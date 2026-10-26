/*
 * scheduler.ts — trade-flow event-driven scheduler.
 *
 * Entry checks are triggered by incoming public trades.
 * Position checks and account reconciliation remain periodic.
 * Live order submission continues through the existing ExecutionService.
 */

import { POSITION_CHECK_INTERVAL_MS } from '../config/constants';

import {
  runTradeFlowOnce,
  initializeVirtualTradeSystem
} from './botRunner';

import {
  getCandles,
  getMarkPrice,
  getTrades,
  recordTradeHistory,
  resolveMarket,
  normalizeSymbol,
  subscribeToTrades,
  stopMarketData,
  type MarketReference
} from './exchange';

import {
  getPositions,
  openPosition,
  closePosition,
  hasOpenPosition,
  getOpenPositionsCount,
  MAX_PARALLEL_POSITIONS,
  getBalance,
  getRiskCapital,
  getPositionNotional,
  updatePositionMetadata,
  flushPositionPersistence,
  beginPositionOpening,
  endPositionOpening,
  isPositionOpening,
  loadReconciliationPendingSymbols,
  addReconciliationPendingSymbol,
  removeReconciliationPendingSymbol,
  isReconciliationPendingSymbol
} from './positionState';

import { TRADE_FEE_RATE } from './strategy';

import { logPositionCheck, logError } from './logger';

import { notifyStartup, notifyError } from './telegram';

import {
  refreshTopMarkets,
  startMarketRefresh,
  stopMarketRefresh,
  getActiveTradingPairs,
  getActiveMarket
} from './scheduler.dynamic.parts';

import {
  PaperExecutionService,
  LighterExecutionService,
  type ExecutionService
} from './execution';

import { SignerClient } from 'zklighter-sdk';

import {
  restoreStateAfterRestart,
  reconcileAccount,
  fetchAccountPositions,
  syncLiveBalance
} from './reconciliation';

import type { EnsureProtectiveOrdersRequest } from './execution/types';

const PAPER_TRADING = process.env.PAPER_TRADING === 'true';

const SIGNAL_LOCK_MS = 15 * 60_000;
const PENDING_OPENING_TTL_MS = 30 * 60_000;
const MAX_TRADE_EVENT_AGE_MS = 10_000;

let executionService: ExecutionService;
let signerClient: SignerClient | null = null;
let reconciliationInterval: NodeJS.Timeout | null = null;
let balanceSyncInterval: NodeJS.Timeout | null = null;
let positionCheckInterval: NodeJS.Timeout | null = null;
let tradeUnsubscribe: (() => void) | null = null;
let positionCheckRunning = false;
let schedulerStopping = false;
let schedulerStarted = false;

const symbolLocks = new Map<string, number>();
const tradeSignalRunning = new Set<string>();
const lastProcessedTradeBySymbol = new Map<string, string>();

type SignalStatus =
  | 'signal'
  | 'no-signal'
  | 'position-open'
  | 'max-positions'
  | 'not-ready'
  | 'error';

type TradeFlowSignalResult = {
  symbol: string;
  status: SignalStatus;
  regime: string;
  hasSignal: boolean;
  side?: 'long' | 'short' | 'none';
  price?: number;
  reason?: string;
  imbalance?: number;
  volumeMultiple?: number | null;
};

type PendingFilledOpen = {
  symbol: string;
  marketId: number;
  side: 'long' | 'short';
  requestedQuantity: number;
  filledQuantity: number;
  expectedPrice: number;
  averageFillPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  exchangeStopLossPrice: number;
  exchangeTakeProfitPrice: number;
  orderId?: string;
  clientOrderId: string;
  regime: string;
  strategyGroup: string;
  indicators: Record<string, unknown>;
  signalTime?: number;
  signalTimeIso?: string;
  protectionStopLossOrderId?: string;
  protectionTakeProfitOrderId?: string;
  createdAt: number;
};

const pendingFilledOpens = new Map<string, PendingFilledOpen>();

function tradeLog(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, timestamp: new Date().toISOString(), ...data }));
}

function tradeError(event: string, error: unknown, data: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    ...data
  }));
}

function isSymbolLocked(symbol: string): boolean {
  const key = normalizeSymbol(symbol);
  const until = symbolLocks.get(key);

  if (!until) return false;
  if (Date.now() >= until) {
    symbolLocks.delete(key);
    return false;
  }

  return true;
}

function lockSymbol(symbol: string, durationMs = SIGNAL_LOCK_MS): void {
  symbolLocks.set(normalizeSymbol(symbol), Date.now() + durationMs);
}

function unlockSymbol(symbol: string): void {
  const key = normalizeSymbol(symbol);
  symbolLocks.delete(key);
  removeReconciliationPendingSymbol(key);
}

function markReconciliationPending(symbol: string): void {
  const key = normalizeSymbol(symbol);
  addReconciliationPendingSymbol(key);
  lockSymbol(key, SIGNAL_LOCK_MS);
}

function isReconciliationPending(symbol: string): boolean {
  return isReconciliationPendingSymbol(symbol);
}

function requireMarketId(marketId: number | undefined, context: string): number {
  if (marketId == null || !Number.isInteger(marketId) || marketId < 0) {
    throw new Error(`Missing or invalid marketId for ${context}: ${marketId}`);
  }

  return marketId;
}

function validateSignalPrice(price: number): number {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid signal price: ${price}`);
  }

  return price;
}

function validateQuantity(quantity: number): number {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(`Invalid order quantity: ${quantity}`);
  }

  return quantity;
}

function createExecutionService(): ExecutionService {
  if (PAPER_TRADING) return new PaperExecutionService();

  const secret = process.env.LIGHTER_API_SECRET ?? '';
  const apiKeyIndex = Number(process.env.LIGHTER_API_KEY_INDEX ?? 0);
  const accountIndex = Number(process.env.LIGHTER_ACCOUNT_INDEX ?? 0);

  if (!secret) throw new Error('LIGHTER_API_SECRET is required in live mode');

  if (!Number.isInteger(apiKeyIndex) || apiKeyIndex < 0 || apiKeyIndex > 254) {
    throw new Error(`Invalid LIGHTER_API_KEY_INDEX: ${apiKeyIndex}`);
  }

  if (!Number.isInteger(accountIndex) || accountIndex < 0) {
    throw new Error(`Invalid LIGHTER_ACCOUNT_INDEX: ${accountIndex}`);
  }

  return new LighterExecutionService(secret, apiKeyIndex, accountIndex);
}

function initializeSignerClient(): void {
  if (PAPER_TRADING) {
    signerClient = null;
    return;
  }

  const secret = process.env.LIGHTER_API_SECRET ?? '';
  const apiKeyIndex = Number(process.env.LIGHTER_API_KEY_INDEX ?? 0);
  const accountIndex = Number(process.env.LIGHTER_ACCOUNT_INDEX ?? 0);

  if (!secret) throw new Error('LIGHTER_API_SECRET is required in live mode');

  const key = secret.startsWith('0x') ? secret.slice(2) : secret;

  signerClient = new SignerClient(
    process.env.LIGHTER_API_URL ?? 'https://mainnet.zklighter.elliot.ai',
    key,
    apiKeyIndex,
    accountIndex
  );
}

function startReconciliationLoop(client: SignerClient, accountIndex: number): void {
  reconciliationInterval = setInterval(() => {
    void reconcileAccount(client, accountIndex, { autoFix: false, dryRun: true }).catch(error => {
      tradeError('EXCHANGE_RECONCILIATION_FAILED', error, { accountIndex });
    });
  }, 15 * 60_000);
}

function stopReconciliationLoop(): void {
  if (reconciliationInterval) clearInterval(reconciliationInterval);
  reconciliationInterval = null;
}

function startBalanceSyncLoop(accountIndex: number): void {
  balanceSyncInterval = setInterval(() => {
    if (!signerClient) return;

    void syncLiveBalance(signerClient, accountIndex).catch(error => {
      tradeError('BALANCE_SYNC_FAILED', error, { accountIndex });
    });
  }, 5 * 60_000);
}

function stopBalanceSyncLoop(): void {
  if (balanceSyncInterval) clearInterval(balanceSyncInterval);
  balanceSyncInterval = null;
}

function buildPositionMetadata(
  regime: string,
  strategyGroup: string,
  indicators: Record<string, unknown>,
  signalTime?: number,
  signalTimeIso?: string
) {
  const numeric = (name: string, fallback = 0): number => {
    const value = indicators[name];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };

  return {
    regime,
    strategyGroup: strategyGroup as any,
    macdCrossUp: false,
    macdCrossDown: false,
    lastRsi: 0,
    lastAtr: numeric('atr'),
    adx: 0,
    bbWidth: 0,
    atrPct: 0,
    ema20: 0,
    ema50: 0,
    ema200: 0,
    entryExtensionAtr: 0,
    maxEntryExtensionAtr: 0,
    entryTooExtended: false,
    entryDistanceFromEma20: 0,
    entryDistanceFromEma20Atr: 0,
    signalTime: signalTime ?? Date.now(),
    signalTimeIso: signalTimeIso ?? new Date().toISOString(),

    tradeFlowWindowMs: numeric('windowMs'),
    tradeFlowWindowTradeCount: numeric('windowTradeCount'),
    tradeFlowBuyVolume: numeric('buyVolume'),
    tradeFlowSellVolume: numeric('sellVolume'),
    tradeFlowTotalVolume: numeric('totalVolume'),
    tradeFlowBaselineVolume: numeric('baselineVolumePerWindow'),
    tradeFlowVolumeMultiple: numeric('volumeMultiple'),
    tradeFlowImbalance: numeric('imbalance'),
    tradeFlowPriceMoveAtr: numeric('priceMoveAtr'),
    tradeFlowExcludedLiquidations: numeric('excludedLiquidationCount')
  };
}

function savePendingFilledOpen(input: PendingFilledOpen): void {
  pendingFilledOpens.set(normalizeSymbol(input.symbol), input);
  markReconciliationPending(input.symbol);

  tradeLog('FILLED_OPEN_PENDING_LOCAL_STATE', {
    symbol: input.symbol,
    marketId: input.marketId,
    side: input.side,
    filledQuantity: input.filledQuantity,
    averageFillPrice: input.averageFillPrice,
    orderId: input.orderId ?? null
  });
}

function clearPendingFilledOpen(symbol: string): void {
  pendingFilledOpens.delete(normalizeSymbol(symbol));
}

function buildOpenPositionInput(input: PendingFilledOpen) {
  return {
    symbol: input.symbol,
    marketId: input.marketId,
    side: input.side,
    entryPrice: input.averageFillPrice,
    quantity: input.filledQuantity,
    takeProfitPrice: input.takeProfitPrice,
    stopLossPrice: input.stopLossPrice,
    exchangeStopLossPrice: input.exchangeStopLossPrice,
    exchangeTakeProfitPrice: input.exchangeTakeProfitPrice,
    exchangeStopLossOrderId: input.protectionStopLossOrderId,
    exchangeTakeProfitOrderId: input.protectionTakeProfitOrderId,
    metadata: buildPositionMetadata(
      input.regime,
      input.strategyGroup,
      input.indicators,
      input.signalTime,
      input.signalTimeIso
    ),
    executionOrderId: input.orderId,
    clientOrderId: input.clientOrderId
  };
}

function tryRestorePendingFilledOpen(symbol: string): boolean {
  const key = normalizeSymbol(symbol);
  const pending = pendingFilledOpens.get(key);

  if (!pending) return false;

  const existing = getPositions().find(
    position => normalizeSymbol(position.symbol) === key && position.marketId === pending.marketId
  );

  if (existing) {
    clearPendingFilledOpen(key);
    unlockSymbol(key);
    return true;
  }

  const openResult = openPosition(buildOpenPositionInput(pending));

  if (!openResult.ok) {
    tradeError('LOCAL_POSITION_RESTORE_FAILED', openResult.message, {
      symbol: pending.symbol,
      marketId: pending.marketId,
      orderId: pending.orderId ?? null
    });

    return false;
  }

  clearPendingFilledOpen(key);
  unlockSymbol(key);

  tradeLog('LOCAL_POSITION_RESTORED_FROM_FILLED_ORDER', {
    symbol: pending.symbol,
    marketId: pending.marketId,
    positionId: openResult.position?.id ?? null,
    orderId: pending.orderId ?? null
  });

  return true;
}

async function ensurePositionProtection(
  position: ReturnType<typeof getPositions>[number],
  activeMarket: { priceDecimals: number; sizeDecimals: number }
): Promise<void> {
  if (position.marketId == null) {
    throw new Error(`Missing marketId for ${position.symbol}`);
  }

  if (!executionService.ensureProtectiveOrders) {
    throw new Error('Execution service does not support protective-order recovery');
  }

  const request: EnsureProtectiveOrdersRequest = {
    symbol: position.symbol,
    marketId: position.marketId,
    side: position.side,
    quantity: position.quantity,
    expectedPrice: position.entryPrice,
    clientOrderId: `${position.symbol}-${Date.now()}-protection`,
    priceDecimals: activeMarket.priceDecimals,
    sizeDecimals: activeMarket.sizeDecimals,
    stopLossPrice: position.exchangeStopLossPrice,
    takeProfitPrice: position.exchangeTakeProfitPrice
  };

  const protection = await executionService.ensureProtectiveOrders(request);

  if (!protection.stopLossOrderId || !protection.takeProfitOrderId) {
    throw new Error(`Protective orders were not fully confirmed for ${position.symbol}`);
  }

  const updated = updatePositionMetadata(position.id, { reconciliationIssue: undefined });

  if (!updated) {
    throw new Error(`Failed to update protection state for ${position.symbol}`);
  }

  tradeLog('PROTECTION_RECOVERED', {
    symbol: position.symbol,
    marketId: position.marketId,
    stopLossOrderId: protection.stopLossOrderId,
    takeProfitOrderId: protection.takeProfitOrderId
  });
}

function hasKnownRemotePosition(remote: any, pending?: PendingFilledOpen): boolean {
  if (!pending) return true;
  if (Number(remote.marketId) !== pending.marketId) return false;

  if (remote.side && String(remote.side).toLowerCase() !== pending.side) return false;

  return Number(remote.quantity ?? remote.size ?? 0) > 0;
}

function describeSignalReason(result: ReturnType<typeof runTradeFlowOnce>): string {
  if (result.skipReason) return result.skipReason;

  const indicators = result.indicators;

  return [
    `imbalance=${indicators.imbalance.toFixed(3)}`,
    `volumeMultiple=${indicators.volumeMultiple?.toFixed(2) ?? 'n/a'}`,
    `trades=${indicators.windowTradeCount}`
  ].join(', ');
}

async function handleTradeEvent(rawSymbol: string, tradeId: string): Promise<void> {
  const symbol = normalizeSymbol(rawSymbol);

  if (schedulerStopping || !schedulerStarted) return;
  if (tradeSignalRunning.has(symbol)) return;

  tradeSignalRunning.add(symbol);

  try {
    const trades = getTrades(symbol);
    const triggeringTrade = trades.find(trade => trade.tradeId === tradeId);

    if (!triggeringTrade) return;

    const ageMs = Date.now() - triggeringTrade.receivedAt;

    if (ageMs < 0 || ageMs > MAX_TRADE_EVENT_AGE_MS) {
      tradeLog('TRADE_EVENT_IGNORED_STALE', { symbol, tradeId, ageMs });
      return;
    }

    if (lastProcessedTradeBySymbol.get(symbol) === tradeId) return;

    lastProcessedTradeBySymbol.set(symbol, tradeId);

    const market = resolveMarket(symbol);
    const marketId = requireMarketId(market.marketId, `trade-flow signal ${symbol}`);

    // Важно:
    // runTradeFlowOnce() вызывается до блокирующих проверок.
    // Он открывает виртуальную сделку на каждом сыром trade-flow сигнале,
    // даже если реальный вход позже будет запрещён.
    const result = runTradeFlowOnce(symbol);

    tradeLog('TRADE_FLOW_CHECK', {
      symbol,
      marketId,
      tradeId,
      ready: result.ready,
      side: result.side,
      price: result.price,
      rawSignal: result.rawSignal,
      rawSignalSide: result.rawSignalData?.side ?? null,
      reason: describeSignalReason(result),
      indicators: result.indicators
    });

    if (tryRestorePendingFilledOpen(symbol)) return;
    if (isReconciliationPending(symbol)) return;
    if (isSymbolLocked(symbol) || isPositionOpening(symbol)) return;
    if (hasOpenPosition(symbol)) return;
    if (getOpenPositionsCount() >= MAX_PARALLEL_POSITIONS) return;

    if (!result.ready || result.side === 'none') return;

    const activeMarket = getActiveMarket(symbol);

    if (!activeMarket) {
      throw new Error(`Active market metadata not found: ${symbol}`);
    }

    const expectedPrice = validateSignalPrice(result.price);

    if (result.takeProfitPrice == null || result.stopLossPrice == null) {
      throw new Error('Trade-flow signal missing take-profit or stop-loss');
    }

    const stopDistance = Math.abs(expectedPrice - result.stopLossPrice);
    const totalRiskPerUnit = stopDistance + stopDistance * TRADE_FEE_RATE;

    if (!Number.isFinite(totalRiskPerUnit) || totalRiskPerUnit <= 0) {
      throw new Error(`Invalid total risk per unit: ${totalRiskPerUnit}`);
    }

    const rawQuantity = validateQuantity(
      Math.min(getRiskCapital() / totalRiskPerUnit, getPositionNotional() / expectedPrice)
    );

    const quantity = validateQuantity(
      Math.floor(rawQuantity * 10 ** activeMarket.sizeDecimals) / 10 ** activeMarket.sizeDecimals
    );

    if (!beginPositionOpening(symbol)) return;

    const clientOrderId = `${symbol}-${Date.now()}-flow-open`;

    tradeLog('POSITION_OPEN_REQUEST', {
      symbol,
      marketId,
      side: result.side,
      strategyGroup: result.group,
      quantity,
      expectedPrice,
      stopLossPrice: result.stopLossPrice,
      takeProfitPrice: result.takeProfitPrice,
      clientOrderId,
      signalTradeId: tradeId
    });

    let openingFinished = false;

    try {
      const executionResult = await executionService.openPosition({
        symbol,
        marketId,
        side: result.side,
        quantity,
        expectedPrice,
        clientOrderId,
        priceDecimals: activeMarket.priceDecimals,
        sizeDecimals: activeMarket.sizeDecimals,
        stopLossPrice: result.stopLossPrice,
        takeProfitPrice: result.takeProfitPrice
      });

      const averageFillPrice = executionResult.averageFillPrice;
      const fillConfirmed =
        executionResult.filledQuantity > 0 &&
        averageFillPrice != null &&
        Number.isFinite(averageFillPrice);

      if (!fillConfirmed) {
        const reason = executionResult.message ?? 'Execution failed';

        tradeError('POSITION_OPEN_FAILED', reason, {
          symbol,
          marketId,
          side: result.side,
          quantity,
          expectedPrice,
          status: executionResult.status,
          orderId: executionResult.orderId ?? null,
          filledQuantity: executionResult.filledQuantity,
          averageFillPrice: averageFillPrice ?? null
        });

        if (executionResult.status === 'unknown') markReconciliationPending(symbol);

        return;
      }

      const signalIndicators = { ...result.indicators, atr: stopDistance };

      const pending: PendingFilledOpen = {
        symbol,
        marketId,
        side: result.side,
        requestedQuantity: quantity,
        filledQuantity: executionResult.filledQuantity,
        expectedPrice,
        averageFillPrice,
        takeProfitPrice: result.takeProfitPrice,
        stopLossPrice: result.stopLossPrice,
        exchangeStopLossPrice: result.stopLossPrice,
        exchangeTakeProfitPrice: result.takeProfitPrice,
        orderId: executionResult.orderId,
        clientOrderId,
        regime: result.regime,
        strategyGroup: result.group,
        indicators: signalIndicators,
        signalTime: result.signalTime,
        signalTimeIso: result.signalTimeIso,
        protectionStopLossOrderId: executionResult.protectiveOrders?.stopLossOrderId,
        protectionTakeProfitOrderId: executionResult.protectiveOrders?.takeProfitOrderId,
        createdAt: Date.now()
      };

      savePendingFilledOpen(pending);

      endPositionOpening(symbol);
      openingFinished = true;

      const openResult = openPosition(buildOpenPositionInput(pending));

      if (!openResult.ok) {
        const restored = tryRestorePendingFilledOpen(symbol);

        if (!restored) {
          const reason = `Filled but local state was not created: ${openResult.message}`;

          tradeError('LOCAL_POSITION_CREATE_FAILED', reason, {
            symbol,
            marketId,
            side: result.side,
            quantity: pending.filledQuantity,
            orderId: pending.orderId ?? null
          });

          markReconciliationPending(symbol);
          return;
        }
      }

      tradeLog('POSITION_OPENED', {
        symbol,
        marketId,
        side: result.side,
        strategyGroup: result.group,
        quantity: pending.filledQuantity,
        requestedPrice: expectedPrice,
        averageFillPrice: pending.averageFillPrice,
        stopLossPrice: pending.stopLossPrice,
        takeProfitPrice: pending.takeProfitPrice,
        executionOrderId: pending.orderId ?? null,
        stopLossOrderId: pending.protectionStopLossOrderId ?? null,
        takeProfitOrderId: pending.protectionTakeProfitOrderId ?? null,
        protectionConfirmed: Boolean(
          pending.protectionStopLossOrderId && pending.protectionTakeProfitOrderId
        )
      });

      const position = getPositions().find(
        item => normalizeSymbol(item.symbol) === symbol && item.marketId === marketId
      );

      if (!position) {
        throw new Error(`Position not found after confirmed fill: ${symbol}`);
      }

      if (!pending.protectionStopLossOrderId || !pending.protectionTakeProfitOrderId) {
        await ensurePositionProtection(position, activeMarket);
      }

      clearPendingFilledOpen(symbol);
      unlockSymbol(symbol);

      if (!PAPER_TRADING && signerClient) {
        await syncLiveBalance(
          signerClient,
          Number(process.env.LIGHTER_ACCOUNT_INDEX ?? 0)
        ).catch(error => {
          tradeError('BALANCE_SYNC_FAILED_AFTER_OPEN', error, { symbol });
        });
      }
    } catch (error) {
      if (!openingFinished) endPositionOpening(symbol);

      const pending = pendingFilledOpens.get(symbol);

      if (pending) savePendingFilledOpen(pending);

      tradeError('POSITION_OPEN_FAILED', error, {
        symbol,
        marketId,
        side: result.side,
        quantity,
        clientOrderId
      });

      markReconciliationPending(symbol);
      notifyError({
        context: 'trade-flow-position-open',
        symbol,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      endPositionOpening(symbol);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    logError({
      timestamp: new Date().toISOString(),
      context: 'trade-flow-event',
      symbol,
      error: message
    });

    tradeError('TRADE_FLOW_EVENT_FAILED', error, { symbol, tradeId });
  } finally {
    tradeSignalRunning.delete(symbol);
  }
}

async function reconcileLocalPositionsWithExchange(
  localPositions: ReturnType<typeof getPositions>
): Promise<void> {
  if (PAPER_TRADING || !signerClient) return;

  const accountIndex = Number(process.env.LIGHTER_ACCOUNT_INDEX ?? 0);

  try {
    const remotePositions = await fetchAccountPositions(signerClient, accountIndex);

    const remoteByMarketId = new Map(
      remotePositions.map(position => [position.marketId, position])
    );

    const remoteBySymbol = new Map(
      remotePositions.map(position => [normalizeSymbol(position.symbol), position])
    );

    for (const local of localPositions) {
      const symbol = normalizeSymbol(local.symbol);

      const remote =
        local.marketId != null
          ? remoteByMarketId.get(local.marketId) ?? remoteBySymbol.get(symbol)
          : remoteBySymbol.get(symbol);

      if (remote) continue;

      const markPrice = getMarkPrice(symbol);
      const closePrice =
        markPrice != null && Number.isFinite(markPrice) && markPrice > 0
          ? markPrice
          : local.entryPrice;

      const tpHit =
        markPrice != null &&
        Number.isFinite(markPrice) &&
        (local.side === 'long'
          ? markPrice >= local.takeProfitPrice
          : markPrice <= local.takeProfitPrice);

      const closeReason = tpHit ? 'take_profit' : 'stop_loss';

      const closeResult = closePosition(local.id, closePrice, closeReason, {
        executionOrderId: 'exchange-auto-close',
        clientOrderId: `${symbol}-${Date.now()}-reconcile-${closeReason}`,
        fee: 0
      });

      if (!closeResult.ok) {
        markReconciliationPending(symbol);

        tradeError('LOCAL_POSITION_CLOSE_FAILED', closeResult.message, {
          symbol,
          positionId: local.id,
          closeReason
        });
      } else {
        const netPnL =
          local.side === 'long'
            ? (closePrice - local.entryPrice) * local.quantity
            : (local.entryPrice - closePrice) * local.quantity;

        recordTradeHistory(symbol, {
          symbol,
          side: local.side,
          openedAt: new Date(local.openedAt).getTime(),
          netPnL
        });

        unlockSymbol(symbol);

        tradeLog('POSITION_CLOSED', {
          symbol,
          positionId: local.id,
          closeReason,
          closePrice,
          netPnL
        });
      }
    }

    const localByMarketId = new Map(
      localPositions
        .filter(position => position.marketId != null)
        .map(position => [position.marketId as number, position])
    );

    const localBySymbol = new Map(
      localPositions.map(position => [normalizeSymbol(position.symbol), position])
    );

    for (const remote of remotePositions) {
      const symbol = normalizeSymbol(remote.symbol);

      const hasLocal = localByMarketId.has(remote.marketId) || localBySymbol.has(symbol);

      if (hasLocal) continue;

      const pending = pendingFilledOpens.get(symbol);

      if (
        pending &&
        Date.now() - pending.createdAt <= PENDING_OPENING_TTL_MS &&
        hasKnownRemotePosition(remote, pending)
      ) {
        const restored = tryRestorePendingFilledOpen(symbol);

        if (restored) {
          tradeLog('LOCAL_POSITION_RECONCILED', {
            symbol,
            marketId: remote.marketId,
            source: 'pending-filled-open'
          });

          continue;
        }
      }

      markReconciliationPending(symbol);

      tradeError(
        'LOCAL_POSITION_MISSING',
        'Remote position has no local state and cannot be reconstructed safely',
        {
          symbol: remote.symbol,
          marketId: remote.marketId,
          hasPendingFilledOpen: Boolean(pending)
        }
      );
    }
  } catch (error) {
    tradeError('EXCHANGE_SYNC_FAILED', error, {
      accountIndex,
      localPositions: localPositions.length
    });

    throw error;
  }
}

async function checkPositions(): Promise<void> {
  if (positionCheckRunning) return;

  positionCheckRunning = true;

  try {
    const snapshot = getPositions();

    await reconcileLocalPositionsWithExchange(snapshot);

    const currentPositions = getPositions();

    for (const snapshotPosition of currentPositions) {
      const position = getPositions().find(item => item.id === snapshotPosition.id);

      if (!position || isReconciliationPending(position.symbol)) continue;

      const symbol = normalizeSymbol(position.symbol);

      try {
        if (!position.exchangeStopLossOrderId || !position.exchangeTakeProfitOrderId) {
          const protectionMarket = getActiveMarket(symbol);

          if (!protectionMarket) {
            throw new Error(`Active market metadata not found: ${symbol}`);
          }

          await ensurePositionProtection(position, protectionMarket);
          unlockSymbol(symbol);
        }

        const markPrice = getMarkPrice(symbol);

        if (markPrice == null || !Number.isFinite(markPrice) || markPrice <= 0) {
          throw new Error(`Mark price unavailable for ${symbol}`);
        }

        const pnl =
          position.side === 'long'
            ? (markPrice - position.entryPrice) * position.quantity
            : (position.entryPrice - markPrice) * position.quantity;

        const pnlPercent = position.notional > 0 ? pnl / position.notional * 100 : 0;

        updatePositionMetadata(position.id, {
          maxUnrealizedPnL: Math.max(
            position.metadata?.maxUnrealizedPnL ?? Number.NEGATIVE_INFINITY,
            pnl
          ),
          maxUnrealizedPnLPercent: Math.max(
            position.metadata?.maxUnrealizedPnLPercent ?? Number.NEGATIVE_INFINITY,
            pnlPercent
          ),
          worstUnrealizedPnL: Math.min(
            position.metadata?.worstUnrealizedPnL ?? Number.POSITIVE_INFINITY,
            pnl
          ),
          worstUnrealizedPnLPercent: Math.min(
            position.metadata?.worstUnrealizedPnLPercent ?? Number.POSITIVE_INFINITY,
            pnlPercent
          )
        });

        const tpHit =
          position.side === 'long'
            ? markPrice >= position.takeProfitPrice
            : markPrice <= position.takeProfitPrice;

        const slHit =
          position.side === 'long'
            ? markPrice <= position.stopLossPrice
            : markPrice >= position.stopLossPrice;

        logPositionCheck({
          timestamp: new Date().toISOString(),
          positionId: position.id,
          symbol,
          side: position.side,
          entryPrice: position.entryPrice,
          currentPrice: markPrice,
          takeProfitPrice: position.takeProfitPrice,
          stopLossPrice: position.stopLossPrice,
          unrealizedPnL: pnl,
          unrealizedPnLPercent: pnlPercent,
          distanceToTP: Math.abs(position.takeProfitPrice - markPrice),
          distanceToTPPercent: Math.abs(position.takeProfitPrice - markPrice) / markPrice * 100,
          distanceToSL: Math.abs(position.stopLossPrice - markPrice),
          distanceToSLPercent: Math.abs(position.stopLossPrice - markPrice) / markPrice * 100,
          hitTakeProfit: tpHit,
          hitStopLoss: slHit,
          action: 'hold',
          positionAgeSeconds: Math.max(
            0,
            Math.floor((Date.now() - new Date(position.openedAt).getTime()) / 1000)
          )
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';

        markReconciliationPending(symbol);

        tradeError('POSITION_CHECK_FAILED', error, {
          symbol,
          positionId: position.id
        });

        notifyError({
          context: 'position-check',
          symbol,
          error: message
        });
      }
    }
  } finally {
    positionCheckRunning = false;
  }
}

function subscribeToTradeEvents(): void {
  tradeUnsubscribe?.();

  tradeUnsubscribe = subscribeToTrades(async (symbol, trade) => {
    await handleTradeEvent(symbol, trade.tradeId);
  });
}

export async function startScheduler(): Promise<void> {
  if (schedulerStarted) return;

  schedulerStarted = true;
  schedulerStopping = false;

  try {
    executionService = createExecutionService();
    initializeSignerClient();

    await refreshTopMarkets();
    await loadReconciliationPendingSymbols();

    if (!PAPER_TRADING && signerClient) {
      const accountIndex = Number(process.env.LIGHTER_ACCOUNT_INDEX ?? 0);

      await syncLiveBalance(signerClient, accountIndex);

      const restore = await restoreStateAfterRestart(signerClient, accountIndex);

      if (restore.errors > 0) {
        notifyError({
          context: 'reconciliation',
          error: `State reconciliation completed with ${restore.errors} errors`
        });
      }

      startReconciliationLoop(signerClient, accountIndex);
      startBalanceSyncLoop(accountIndex);
    }

    // Виртуальный S2:
    // загружает data/virtual_trade_log.csv
    // и запускает проверку открытых виртуальных сделок каждые 5 секунд.
    initializeVirtualTradeSystem();

    startMarketRefresh();

    await checkPositions();

    subscribeToTradeEvents();

    positionCheckInterval = setInterval(() => {
      void checkPositions().catch(error => {
        tradeError('POSITION_INTERVAL_FAILED', error);
      });
    }, POSITION_CHECK_INTERVAL_MS);

    notifyStartup({
      port: Number(process.env.PORT) || 3006,
      tradingPairs: getActiveTradingPairs(),
      signalInterval: 0,
      positionInterval: POSITION_CHECK_INTERVAL_MS / 1000,
      balance: getBalance()
    });

    tradeLog('TRADE_FLOW_SCHEDULER_STARTED', {
      paperTrading: PAPER_TRADING,
      activeMarkets: getActiveTradingPairs().length,
      positionCheckIntervalMs: POSITION_CHECK_INTERVAL_MS
    });
  } catch (error) {
    schedulerStarted = false;
    schedulerStopping = true;

    tradeUnsubscribe?.();
    tradeUnsubscribe = null;

    stopMarketRefresh();
    stopReconciliationLoop();
    stopBalanceSyncLoop();

    if (positionCheckInterval) {
      clearInterval(positionCheckInterval);
      positionCheckInterval = null;
    }

    executionService?.stop?.();

    tradeError('SCHEDULER_START_FAILED', error);

    throw error;
  }
}

export async function stopScheduler(): Promise<void> {
  schedulerStopping = true;

  tradeUnsubscribe?.();
  tradeUnsubscribe = null;

  stopReconciliationLoop();
  stopBalanceSyncLoop();
  stopMarketRefresh();

  if (positionCheckInterval) clearInterval(positionCheckInterval);

  positionCheckInterval = null;

  executionService?.stop?.();

  const symbols = new Set([
    ...getPositions().map(position => normalizeSymbol(position.symbol)),
    ...getActiveTradingPairs().map(normalizeSymbol)
  ]);

  for (const symbol of symbols) {
    try {
      stopMarketData(symbol);
    } catch (error) {
      tradeError('MARKET_DATA_STOP_FAILED', error, { symbol });
    }
  }

  await flushPositionPersistence().catch(error => {
    tradeError('POSITION_PERSISTENCE_FLUSH_FAILED', error);
  });

  schedulerStarted = false;
}

export type {
  TradeFlowSignalResult,
  MarketReference
};
