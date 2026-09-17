/* Full scheduler.ts with automatic SL/TP recovery and structured trade/reconciliation logs. */

import {
  SIGNAL_CHECK_INTERVAL_MS,
  POSITION_CHECK_INTERVAL_MS
} from '../config/constants';
import { runBotOnce } from './botRunner';
import {
  stopMarketData,
  getMarkPrice,
  resolveMarket,
  normalizeSymbol
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
import {
  TRADE_FEE_RATE,
  isTradingTimeUtcPlus4
} from './strategy';
import {
  logPositionCheck,
  logError,
  logSignalCheck
} from './logger';
import {
  notifyStartup,
  notifyError,
  sendAggregatedSignalSummary
} from './telegram';
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
  ExecutionService
} from './execution';
import { SignerClient } from 'zklighter-sdk';
import {
  restoreStateAfterRestart,
  reconcileAccount,
  fetchAccountPositions,
  syncLiveBalance
} from './reconciliation';
import type { EnsureProtectiveOrdersRequest } from './execution/types';

const PAPER_TRADING = process.env.PAPER_TRADING !== 'false';
const SIGNAL_LOCK_MS = 15 * 60_000;

let executionService: ExecutionService;
let signerClient: SignerClient | null = null;
let reconciliationInterval: NodeJS.Timeout | null = null;
let balanceSyncInterval: NodeJS.Timeout | null = null;
let signalCheckInterval: NodeJS.Timeout | null = null;
let positionCheckInterval: NodeJS.Timeout | null = null;
let signalCheckRunning = false;
let positionCheckRunning = false;
let schedulerStopping = false;
let schedulerStarted = false;
const symbolLocks = new Map<string, number>();

type SignalResult = {
  symbol: string;
  status: 'signal' | 'no-signal' | 'position-open' | 'max-positions' | 'not-ready' | 'error';
  regime: string;
  hasSignal: boolean;
  side?: 'long' | 'short' | 'none';
  price?: number;
  reason?: string;
};

function tradeLog(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    ...data
  }));
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

function validateSignalPrice(price: number | undefined): number {
  if (price == null || !Number.isFinite(price) || price <= 0) {
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

async function hasPendingRemoteOrder(marketId: number): Promise<boolean> {
  if (PAPER_TRADING || !signerClient) return false;
  const accountIndex = Number(process.env.LIGHTER_ACCOUNT_INDEX ?? 0);
  const apiKeyIndex = Number(process.env.LIGHTER_API_KEY_INDEX ?? 0);
  const authorization = signerClient.create_auth_token_with_expiry(60 * 60, undefined, apiKeyIndex)[0] ?? '';

  try {
    const responses = await Promise.all([
      fetch(`${process.env.LIGHTER_API_URL ?? 'https://mainnet.zklighter.elliot.ai'}/api/v1/accountActiveOrders?account_index=${accountIndex}&limit=100`, {
        headers: { Accept: 'application/json', Authorization: authorization }
      }),
      fetch(`${process.env.LIGHTER_API_URL ?? 'https://mainnet.zklighter.elliot.ai'}/api/v1/accountInactiveOrders?account_index=${accountIndex}&limit=100`, {
        headers: { Accept: 'application/json', Authorization: authorization }
      })
    ]);

    const data = await Promise.all(responses.map(async response => {
      if (!response.ok) throw new Error(`Orders request failed: ${response.status}`);
      return response.json() as Promise<any>;
    }));

    const orders = data.flatMap(item => Array.isArray(item?.orders) ? item.orders : []);
    return orders.some((order: any) => Number(order.market_index) === marketId && ['submitted', 'partially_filled', 'open'].includes(String(order.status).toLowerCase()));
  } catch (error) {
    tradeError('REMOTE_ORDER_SYNC_FAILED', error, { accountIndex, marketId });
    throw error;
  }
}

function buildPositionMetadata(regime: string, indicators: any, signalTime?: number, signalTimeIso?: string) {
  return {
    regime,
    macdCrossUp: indicators?.macdCrossUp ?? false,
    macdCrossDown: indicators?.macdCrossDown ?? false,
    lastRsi: indicators?.lastRsi ?? 0,
    lastAtr: indicators?.lastAtr ?? 0,
    adx: indicators?.adx ?? 0,
    bbWidth: indicators?.bbWidth ?? 0,
    atrPct: indicators?.atrPct ?? 0,
    ema20: indicators?.ema20 ?? 0,
    ema50: indicators?.regimeIndicators?.ema50 ?? 0,
    ema200: indicators?.ema200 ?? 0,
    entryExtensionAtr: indicators?.entryExtensionAtr ?? 0,
    maxEntryExtensionAtr: indicators?.maxEntryExtensionAtr ?? 0,
    entryTooExtended: indicators?.entryTooExtended ?? false,
    entryDistanceFromEma20: indicators?.entryDistanceFromEma20 ?? 0,
    entryDistanceFromEma20Atr: indicators?.entryDistanceFromEma20Atr ?? 0,
    signalTime: signalTime ?? Date.now(),
    signalTimeIso: signalTimeIso ?? new Date().toISOString()
  };
}

async function ensurePositionProtection(
  position: ReturnType<typeof getPositions>[number],
  activeMarket: { priceDecimals: number; sizeDecimals: number }
): Promise<void> {
  if (position.marketId == null) throw new Error(`Missing marketId for ${position.symbol}`);
  if (!executionService.ensureProtectiveOrders) throw new Error('Execution service does not support protective-order recovery');

  tradeLog('PROTECTION_RECOVERY_REQUEST', {
    symbol: position.symbol,
    marketId: position.marketId,
    side: position.side,
    quantity: position.quantity,
    stopLossPrice: position.exchangeStopLossPrice,
    takeProfitPrice: position.exchangeTakeProfitPrice
  });

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

  try {
    const protection = await executionService.ensureProtectiveOrders(request);
    if (!protection.stopLossOrderId || !protection.takeProfitOrderId) {
      throw new Error(`Protective orders were not fully confirmed for ${position.symbol}`);
    }
    const updated = updatePositionMetadata(position.id, { reconciliationIssue: undefined });
    if (!updated) throw new Error(`Failed to update protection state for ${position.symbol}`);
    tradeLog('PROTECTION_RECOVERED', {
      symbol: position.symbol,
      marketId: position.marketId,
      stopLossOrderId: protection.stopLossOrderId,
      takeProfitOrderId: protection.takeProfitOrderId
    });
  } catch (error) {
    tradeError('PROTECTION_RECOVERY_FAILED', error, { symbol: position.symbol, marketId: position.marketId });
    throw error;
  }
}

async function checkSignals(): Promise<void> {
  if (signalCheckRunning) return;
  signalCheckRunning = true;
  const results: SignalResult[] = [];
  const errorsBySymbol = new Map<string, string>();

  try {
    const tradingPairs = new Set(getActiveTradingPairs().map(normalizeSymbol));
    for (const rawSymbol of tradingPairs) {
      const symbol = normalizeSymbol(rawSymbol);
      try {
        if (isReconciliationPending(symbol)) {
          results.push({ symbol, status: 'not-ready', regime: 'reconciliation-pending', hasSignal: false, reason: 'Confirmed fill is awaiting remote position reconciliation' });
          continue;
        }
        if (isSymbolLocked(symbol) || isPositionOpening(symbol)) {
          results.push({ symbol, status: 'not-ready', regime: 'locked', hasSignal: false, reason: 'Symbol is locked' });
          continue;
        }
        if (hasOpenPosition(symbol)) {
          results.push({ symbol, status: 'position-open', regime: 'position-open', hasSignal: false, reason: 'Open position exists' });
          continue;
        }
        if (getOpenPositionsCount() >= MAX_PARALLEL_POSITIONS) {
          results.push({ symbol, status: 'max-positions', regime: 'max-positions', hasSignal: false, reason: `Max positions reached: ${MAX_PARALLEL_POSITIONS}` });
          continue;
        }

        const market = resolveMarket(symbol);
        const marketId = requireMarketId(market.marketId, `signal check ${symbol}`);
        if (await hasPendingRemoteOrder(marketId)) {
          results.push({ symbol, status: 'not-ready', regime: 'pending-order', hasSignal: false, reason: 'Pending remote order exists' });
          continue;
        }

        const result = await runBotOnce(symbol, '15m');
        if (!result.ready) {
          results.push({ symbol, status: 'not-ready', regime: 'unknown', hasSignal: false, reason: result.reason ?? 'Strategy result is not ready' });
          continue;
        }

        const buy = (result as any).buy as boolean;
        const sell = (result as any).sell as boolean;
        const side = (result as any).side as 'long' | 'short' | 'none';
        const price = (result as any).price as number;
        const takeProfitPrice = (result as any).takeProfitPrice as number | null;
        const stopLossPrice = (result as any).stopLossPrice as number | null;
        const positionSize = (result as any).positionSize as number | null;
        const regime = (result as any).regime as string;
        const skipReason = (result as any).skipReason as string | null;
        const signalTime = (result as any).signalTime as number | undefined;
        const signalTimeIso = (result as any).signalTimeIso as string | undefined;
        const indicators = (result as any).indicators as any;
        const isTradingWindow = isTradingTimeUtcPlus4(new Date());

        logSignalCheck({ timestamp: new Date().toISOString(), symbol, timeframe: '15m', side: side ?? 'none', price: price ?? 0, regime: regime ?? 'unknown', takeProfitPrice: takeProfitPrice ?? null, stopLossPrice: stopLossPrice ?? null, positionSize: positionSize ?? null, macdCrossUp: indicators?.macdCrossUp ?? false, macdCrossDown: indicators?.macdCrossDown ?? false, lastRsi: indicators?.lastRsi ?? 0, lastAtr: indicators?.lastAtr ?? 0, rsiBull: false, rsiBear: false, bbUpper: indicators?.bbUpper ?? 0, bbMiddle: indicators?.bbMiddle ?? 0, bbLower: indicators?.bbLower ?? 0, adx: indicators?.adx ?? 0, adxRising: indicators?.regimeIndicators?.adxRising ?? false, ema20: indicators?.ema20 ?? 0, ema50: indicators?.regimeIndicators?.ema50 ?? 0, ema200: indicators?.ema200 ?? 0, bbWidth: indicators?.bbWidth ?? 0, atrPct: indicators?.atrPct ?? 0, signalTriggered: buy || sell, positionOpened: false, entryDistanceFromEma20: indicators?.entryDistanceFromEma20 ?? null, entryDistanceFromEma20Atr: indicators?.entryDistanceFromEma20Atr ?? null, entryTooExtended: indicators?.entryTooExtended ?? false, signalTimeIso: signalTimeIso ?? new Date().toISOString(), isTradingWindow });

        if (skipReason || (!buy && !sell)) {
          const reason = skipReason ?? 'No signal';
          results.push({ symbol, status: 'no-signal', regime, hasSignal: false, side, price, reason });
          continue;
        }
        if (side !== 'long' && side !== 'short') {
          const reason = 'Signal side is invalid';
          errorsBySymbol.set(symbol, reason);
          results.push({ symbol, status: 'error', regime, hasSignal: true, side: 'none', price, reason });
          continue;
        }
        if (!isTradingWindow) {
          const reason = 'Outside trading window (02:00–13:59 UTC+4)';
          results.push({ symbol, status: 'no-signal', regime, hasSignal: false, side, price, reason });
          continue;
        }

        const expectedPrice = validateSignalPrice(price);
        if (takeProfitPrice == null || stopLossPrice == null) throw new Error('Take profit or stop loss is missing');
        const activeMarket = getActiveMarket(symbol);
        if (!activeMarket) throw new Error(`Active market metadata not found: ${symbol}`);

        const stopDistance = Math.abs(expectedPrice - stopLossPrice);
        const totalRiskPerUnit = stopDistance + stopDistance * TRADE_FEE_RATE;
        if (!Number.isFinite(totalRiskPerUnit) || totalRiskPerUnit <= 0) throw new Error(`Invalid total risk per unit: ${totalRiskPerUnit}`);

        const rawQuantity = validateQuantity(Math.min(getRiskCapital() / totalRiskPerUnit, getPositionNotional() / expectedPrice));
        const quantity = validateQuantity(Math.floor(rawQuantity * 10 ** activeMarket.sizeDecimals) / 10 ** activeMarket.sizeDecimals);
        if (!beginPositionOpening(symbol)) {
          results.push({ symbol, status: 'not-ready', regime: 'opening', hasSignal: true, side, price: expectedPrice, reason: 'Opening already in progress' });
          continue;
        }

        const clientOrderId = `${symbol}-${Date.now()}-open`;
        tradeLog('POSITION_OPEN_REQUEST', { symbol, marketId, side, quantity, expectedPrice, stopLossPrice, takeProfitPrice, clientOrderId });

        let executionResult;
        try {
          executionResult = await executionService.openPosition({ symbol, marketId, side, quantity, expectedPrice, clientOrderId, priceDecimals: activeMarket.priceDecimals, sizeDecimals: activeMarket.sizeDecimals, stopLossPrice, takeProfitPrice });
        } catch (error) {
          tradeError('POSITION_OPEN_FAILED', error, { symbol, marketId, side, quantity, expectedPrice, clientOrderId });
          endPositionOpening(symbol);
          markReconciliationPending(symbol);
          throw error;
        }

        const fillConfirmed = executionResult.filledQuantity > 0 && executionResult.averageFillPrice != null && Number.isFinite(executionResult.averageFillPrice);

        if (!fillConfirmed) {
          endPositionOpening(symbol);
          const reason = executionResult.message ?? 'Execution failed';
          tradeError('POSITION_OPEN_FAILED', reason, { symbol, marketId, side, quantity, expectedPrice, status: executionResult.status, orderId: executionResult.orderId ?? null });
          if (executionResult.status === 'unknown') markReconciliationPending(symbol);
          results.push({ symbol, status: executionResult.status === 'unknown' ? 'not-ready' : 'signal', regime, hasSignal: true, side, price: expectedPrice, reason });
          errorsBySymbol.set(symbol, reason);
          continue;
        }

        const openResult = openPosition({ symbol, marketId, side, entryPrice: executionResult.averageFillPrice as number, quantity: executionResult.filledQuantity, takeProfitPrice, stopLossPrice, exchangeStopLossPrice: stopLossPrice, exchangeTakeProfitPrice: takeProfitPrice, exchangeStopLossOrderId: executionResult.protectiveOrders?.stopLossOrderId, exchangeTakeProfitOrderId: executionResult.protectiveOrders?.takeProfitOrderId, exchangeStopLossClientOrderIndex: executionResult.protectiveOrders?.stopLossClientOrderIndex, exchangeTakeProfitClientOrderIndex: executionResult.protectiveOrders?.takeProfitClientOrderIndex, metadata: buildPositionMetadata(regime, indicators, signalTime, signalTimeIso), executionOrderId: executionResult.orderId, clientOrderId });

        endPositionOpening(symbol);
        if (!openResult.ok) {
          markReconciliationPending(symbol);
          const reason = `Filled but local state was not created: ${openResult.message}`;
          tradeError('LOCAL_POSITION_CREATE_FAILED', reason, { symbol, marketId, side, quantity: executionResult.filledQuantity, orderId: executionResult.orderId ?? null });
          errorsBySymbol.set(symbol, reason);
          results.push({ symbol, status: 'error', regime, hasSignal: true, side, price: expectedPrice, reason });
          continue;
        }

        tradeLog('POSITION_OPENED', { symbol, marketId, side, quantity: executionResult.filledQuantity, requestedPrice: expectedPrice, averageFillPrice: executionResult.averageFillPrice, stopLossPrice, takeProfitPrice, executionOrderId: executionResult.orderId ?? null, stopLossOrderId: executionResult.protectiveOrders?.stopLossOrderId ?? null, takeProfitOrderId: executionResult.protectiveOrders?.takeProfitOrderId ?? null, protectionConfirmed: Boolean(executionResult.protectiveOrders?.stopLossOrderId && executionResult.protectiveOrders?.takeProfitOrderId) });

        if (!executionResult.protectiveOrders?.stopLossOrderId || !executionResult.protectiveOrders?.takeProfitOrderId) {
          try {
            const position = getPositions().find(item => normalizeSymbol(item.symbol) === symbol);
            if (!position) throw new Error(`Position not found after confirmed fill: ${symbol}`);
            const protectionMarket = getActiveMarket(symbol);
            if (!protectionMarket) throw new Error(`Active market metadata not found: ${symbol}`);
            await ensurePositionProtection(position, protectionMarket);
            unlockSymbol(symbol);
            results.push({ symbol, status: 'signal', regime, hasSignal: true, side, price: expectedPrice, reason: 'Position opened and protection recovered' });
          } catch (error) {
            markReconciliationPending(symbol);
            const reason = error instanceof Error ? error.message : 'Protective-order recovery failed';
            tradeError('PROTECTION_RECOVERY_FAILED', reason, { symbol });
            notifyError({ context: 'protective-order-recovery', symbol, error: reason });
            errorsBySymbol.set(symbol, reason);
            results.push({ symbol, status: 'not-ready', regime, hasSignal: true, side, price: expectedPrice, reason });
          }
          continue;
        }

        unlockSymbol(symbol);
        if (!PAPER_TRADING && signerClient) {
          await syncLiveBalance(signerClient, Number(process.env.LIGHTER_ACCOUNT_INDEX ?? 0)).catch(error => {
            tradeError('BALANCE_SYNC_FAILED_AFTER_OPEN', error, { symbol });
          });
        }
        results.push({ symbol, status: 'signal', regime, hasSignal: true, side, price: expectedPrice, reason: 'Position opened and protected' });
      } catch (error) {
        endPositionOpening(symbol);
        const message = error instanceof Error ? error.message : 'Unknown error';
        logError({ timestamp: new Date().toISOString(), context: 'signal-check', symbol, error: message });
        tradeError('SIGNAL_CHECK_FAILED', error, { symbol });
        errorsBySymbol.set(symbol, message);
        results.push({ symbol, status: 'error', regime: 'error', hasSignal: false, reason: message });
      }
    }

    await sendAggregatedSignalSummary({ results, errorsBySymbol: errorsBySymbol.size > 0 ? Object.fromEntries(errorsBySymbol) : undefined, equity: getBalance() });
  } finally {
    signalCheckRunning = false;
  }
}

async function reconcileLocalPositionsWithExchange(localPositions: ReturnType<typeof getPositions>): Promise<void> {
  if (PAPER_TRADING || !signerClient) return;
  const accountIndex = Number(process.env.LIGHTER_ACCOUNT_INDEX ?? 0);

  try {
    const remotePositions = await fetchAccountPositions(signerClient, accountIndex);
    const remoteByMarketId = new Map(remotePositions.map(position => [position.marketId, position]));
    const remoteBySymbol = new Map(remotePositions.map(position => [normalizeSymbol(position.symbol), position]));

    for (const local of localPositions) {
      const symbol = normalizeSymbol(local.symbol);
      const remote = local.marketId != null ? (remoteByMarketId.get(local.marketId) ?? remoteBySymbol.get(symbol)) : remoteBySymbol.get(symbol);
      if (remote) continue;

      const markPrice = getMarkPrice(symbol);
      const closePrice = markPrice != null && Number.isFinite(markPrice) && markPrice > 0 ? markPrice : local.entryPrice;
      const tpHit = markPrice != null && Number.isFinite(markPrice) && (local.side === 'long' ? markPrice >= local.takeProfitPrice : markPrice <= local.takeProfitPrice);
      const closeReason = tpHit ? 'take_profit' : 'stop_loss';

      tradeLog('POSITION_CLOSED_DETECTED', { symbol, positionId: local.id, marketId: local.marketId, side: local.side, closeReason, closePrice, markPrice, entryPrice: local.entryPrice, takeProfitPrice: local.takeProfitPrice, stopLossPrice: local.stopLossPrice });

      const closeResult = closePosition(local.id, closePrice, closeReason, { executionOrderId: 'exchange-auto-close', clientOrderId: `${symbol}-${Date.now()}-reconcile-${closeReason}`, fee: 0 });
      if (!closeResult.ok) {
        markReconciliationPending(symbol);
        tradeError('LOCAL_POSITION_CLOSE_FAILED', closeResult.message, { symbol, positionId: local.id, closeReason });
      } else {
        unlockSymbol(symbol);
        tradeLog('POSITION_CLOSED', { symbol, positionId: local.id, closeReason, closePrice });
      }
    }

    const localByMarketId = new Map(localPositions.filter(position => position.marketId != null).map(position => [position.marketId as number, position]));
    const localBySymbol = new Map(localPositions.map(position => [normalizeSymbol(position.symbol), position]));
    for (const remote of remotePositions) {
      const hasLocal = localByMarketId.has(remote.marketId) || localBySymbol.has(normalizeSymbol(remote.symbol));
      if (!hasLocal) {
        markReconciliationPending(remote.symbol);
        tradeError('LOCAL_POSITION_MISSING', 'Remote position has no local state', { symbol: remote.symbol, marketId: remote.marketId });
      }
    }
  } catch (error) {
    tradeError('EXCHANGE_SYNC_FAILED', error, { accountIndex, localPositions: localPositions.length });
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
          if (!protectionMarket) throw new Error(`Active market metadata not found: ${symbol}`);
          await ensurePositionProtection(position, protectionMarket);
          unlockSymbol(symbol);
        }
        const markPrice = getMarkPrice(symbol);
        if (markPrice == null || !Number.isFinite(markPrice) || markPrice <= 0) throw new Error(`Mark price unavailable for ${symbol}`);
        const pnl = position.side === 'long' ? (markPrice - position.entryPrice) * position.quantity : (position.entryPrice - markPrice) * position.quantity;
        const pnlPercent = position.notional > 0 ? pnl / position.notional * 100 : 0;
        updatePositionMetadata(position.id, { maxUnrealizedPnL: Math.max(position.metadata?.maxUnrealizedPnL ?? Number.NEGATIVE_INFINITY, pnl), maxUnrealizedPnLPercent: Math.max(position.metadata?.maxUnrealizedPnLPercent ?? Number.NEGATIVE_INFINITY, pnlPercent), worstUnrealizedPnL: Math.min(position.metadata?.worstUnrealizedPnL ?? Infinity, pnl), worstUnrealizedPnLPercent: Math.min(position.metadata?.worstUnrealizedPnLPercent ?? Infinity, pnlPercent) });
        const tpHit = position.side === 'long' ? markPrice >= position.takeProfitPrice : markPrice <= position.takeProfitPrice;
        const slHit = position.side === 'long' ? markPrice <= position.stopLossPrice : markPrice >= position.stopLossPrice;
        logPositionCheck({ timestamp: new Date().toISOString(), positionId: position.id, symbol, side: position.side, entryPrice: position.entryPrice, currentPrice: markPrice, takeProfitPrice: position.takeProfitPrice, stopLossPrice: position.stopLossPrice, unrealizedPnL: pnl, unrealizedPnLPercent: pnlPercent, distanceToTP: Math.abs(position.takeProfitPrice - markPrice), distanceToTPPercent: Math.abs(position.takeProfitPrice - markPrice) / markPrice * 100, distanceToSL: Math.abs(position.stopLossPrice - markPrice), distanceToSLPercent: Math.abs(position.stopLossPrice - markPrice) / markPrice * 100, hitTakeProfit: tpHit, hitStopLoss: slHit, action: 'hold', positionAgeSeconds: Math.max(0, Math.floor((Date.now() - new Date(position.openedAt).getTime()) / 1000)) });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        markReconciliationPending(symbol);
        tradeError('POSITION_CHECK_FAILED', error, { symbol, positionId: position.id });
        notifyError({ context: 'position-check', symbol, error: message });
      }
    }
  } finally {
    positionCheckRunning = false;
  }
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
      if (restore.errors > 0) notifyError({ context: 'reconciliation', error: `State reconciliation completed with ${restore.errors} errors` });
      startReconciliationLoop(signerClient, accountIndex);
      startBalanceSyncLoop(accountIndex);
    }
    startMarketRefresh();
    await checkPositions();
    await checkSignals();
    signalCheckInterval = setInterval(() => void checkSignals().catch(error => tradeError('SIGNAL_INTERVAL_FAILED', error)), SIGNAL_CHECK_INTERVAL_MS);
    positionCheckInterval = setInterval(() => void checkPositions().catch(error => tradeError('POSITION_INTERVAL_FAILED', error)), POSITION_CHECK_INTERVAL_MS);
    notifyStartup({ port: Number(process.env.PORT) || 3006, tradingPairs: getActiveTradingPairs(), signalInterval: SIGNAL_CHECK_INTERVAL_MS / 1000, positionInterval: POSITION_CHECK_INTERVAL_MS / 1000, balance: getBalance() });
  } catch (error) {
    schedulerStarted = false;
    stopMarketRefresh();
    stopReconciliationLoop();
    stopBalanceSyncLoop();
    executionService?.stop?.();
    tradeError('SCHEDULER_START_FAILED', error);
    throw error;
  }
}

export async function stopScheduler(): Promise<void> {
  stopReconciliationLoop();
  stopBalanceSyncLoop();
  stopMarketRefresh();
  if (signalCheckInterval) clearInterval(signalCheckInterval);
  if (positionCheckInterval) clearInterval(positionCheckInterval);
  signalCheckInterval = null;
  positionCheckInterval = null;
  executionService?.stop?.();
  if (!schedulerStopping) {
    schedulerStopping = true;
    const symbols = new Set([...getPositions().map(position => normalizeSymbol(position.symbol)), ...getActiveTradingPairs().map(normalizeSymbol)]);
    for (const symbol of symbols) {
      try {
        stopMarketData(symbol);
      } catch (error) {
        tradeError('MARKET_DATA_STOP_FAILED', error, { symbol });
      }
    }
  }
  await flushPositionPersistence().catch(error => tradeError('POSITION_PERSISTENCE_FLUSH_FAILED', error));
  schedulerStarted = false;
}
