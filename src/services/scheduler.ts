import {
  SIGNAL_CHECK_INTERVAL_MS,
  POSITION_CHECK_INTERVAL_MS
} from '../config/constants';
import { runBotOnce } from './botRunner';
import {
  stopMarketData,
  getMarkPrice,
  getExitPrice,
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
  getAvailableBalance,
  getReservedCapital,
  getRiskCapital,
  getPositionNotional,
  updatePositionMetadata,
  partialClosePosition,
  updatePositionStopLoss,
  flushPositionPersistence,
  VirtualPosition,
  beginPositionOpening,
  endPositionOpening,
  isPositionOpening
} from './positionState';
import { TRADE_FEE_RATE } from './strategy';
import { logPositionCheck, logError } from './logger';
import { notifyStartup, notifyError, sendAggregatedSignalSummary } from './telegram';
import axios from 'axios';
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
  verifyPositionAfterFill,
  LighterPosition,
  syncLiveBalance
} from './reconciliation';

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
const reconciliationPending = new Set<string>();

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
  reconciliationPending.delete(key);
}

function markReconciliationPending(symbol: string): void {
  const key = normalizeSymbol(symbol);
  reconciliationPending.add(key);
  lockSymbol(key, SIGNAL_LOCK_MS);
}

function isReconciliationPending(symbol: string): boolean {
  return reconciliationPending.has(normalizeSymbol(symbol));
}

function formatPrice(price: number): string {
  return Number.isFinite(price) ? price.toFixed(4) : 'n/a';
}

function requireMarketId(marketId: number | undefined, context: string): number {
  if (marketId == null || !Number.isInteger(marketId) || marketId < 0) {
    throw new Error(`Missing or invalid marketId for ${context}: ${marketId}`);
  }
  return marketId;
}

function createExecutionService(): ExecutionService {
  if (PAPER_TRADING) return new PaperExecutionService();
  const secret = process.env.LIGHTER_API_SECRET ?? '';
  const apiKeyIndex = Number(process.env.LIGHTER_API_KEY_INDEX ?? 0);
  const accountIndex = Number(process.env.LIGHTER_ACCOUNT_INDEX ?? 0);
  if (!secret) throw new Error('LIGHTER_API_SECRET is required in live mode');
  if (!Number.isInteger(apiKeyIndex) || apiKeyIndex < 0 || apiKeyIndex > 254) throw new Error(`Invalid LIGHTER_API_KEY_INDEX: ${apiKeyIndex}`);
  if (!Number.isInteger(accountIndex) || accountIndex < 0) throw new Error(`Invalid LIGHTER_ACCOUNT_INDEX: ${accountIndex}`);
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
      console.error(`[${new Date().toISOString()}] Periodic reconciliation error:`, error);
    });
  }, 15 * 60_000);
}

function stopReconciliationLoop(): void {
  if (reconciliationInterval) clearInterval(reconciliationInterval);
  reconciliationInterval = null;
}

function startBalanceSyncLoop(accountIndex: number): void {
  balanceSyncInterval = setInterval(() => {
    void syncLiveBalance(signerClient!, accountIndex).catch(error => {console.error(`[${new Date().toISOString()}] Balance sync error:`, error);
    });
  }, 5 * 60_000);
}

function stopBalanceSyncLoop(): void {
  if (balanceSyncInterval) clearInterval(balanceSyncInterval);
  balanceSyncInterval = null;
}

type SignalResult = {
  symbol: string;
  status: 'signal' | 'no-signal' | 'position-open' | 'max-positions' | 'not-ready' | 'error';
  regime: string;
  hasSignal: boolean;
  side?: 'long' | 'short' | 'none';
  price?: number;
  reason?: string;
};

const BE_THRESHOLD_PERCENT = 0.2;
const LOCK_RATIO = 0.3;
const PARTIAL_THRESHOLD_PERCENT = 0.5;
const TRAILING_DISTANCE_PERCENT = 0.35;
const TIME_STOP_SECONDS = 1800;
const TIME_STOP_MFE_PERCENT = 0.3;
const TIME_STOP_MAX_LOSS_PERCENT = -0.5;
const DEAD_TRADE_ENABLED = true;
const DEAD_TRADE_CHECK_AFTER_SEC = 360;
const DEAD_TRADE_MIN_MFE_ATR = 0.3;
const MIN_LOCKED_PERCENT = 0.25;

function formatOpenPositionsForTelegram(): string {
  const positions = getPositions();
  if (!positions.length) return 'No open positions';
  return positions.map(position => {
    const emoji = position.side === 'long' ? '🟢' : '🔴';
    return `${emoji} ${position.symbol} ${position.side.toUpperCase()} | Entry: ${formatPrice(position.entryPrice)} | TP: ${formatPrice(position.takeProfitPrice)} | SL: ${formatPrice(position.stopLossPrice)} | Notional: ${position.notional.toFixed(2)}`;
  }).join('\n');
}

function validateSignalPrice(price: number | undefined): number {
  if (price == null || !Number.isFinite(price) || price <= 0) throw new Error(`Invalid signal price: ${price}`);
  return price;
}

function validateQuantity(quantity: number): number {
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Invalid order quantity: ${quantity}`);
  return quantity;
}

async function hasPendingRemoteOrder(marketId: number): Promise<boolean> {
  if (PAPER_TRADING || !signerClient) return false;

  const accountIndex = Number(process.env.LIGHTER_ACCOUNT_INDEX ?? 0);
  const apiKeyIndex = Number(process.env.LIGHTER_API_KEY_INDEX ?? 0);

  console.log(`[${new Date().toISOString()}] [SCHEDULER] hasPendingRemoteOrder START marketId=${marketId}`);

  try {
    const [activeData, inactiveData] = await Promise.all([
      fetch(`${LIGHTER_API_URL}/api/v1/accountActiveOrders?account_index=${accountIndex}&limit=100`, {
        headers: {
          Accept: 'application/json',
          Authorization: signerClient.create_auth_token_with_expiry(60 * 60, undefined, apiKeyIndex)[0] ?? ''
        }
      }).then(r => r.json()),
      fetch(`${LIGHTER_API_URL}/api/v1/accountInactiveOrders?account_index=${accountIndex}&limit=100`, {
        headers: {
          Accept: 'application/json',
          Authorization: signerClient.create_auth_token_with_expiry(60 * 60, undefined, apiKeyIndex)[0] ?? ''
        }
      }).then(r => r.json())
    ]);

    const activeOrders = Array.isArray((activeData as any).orders) ? (activeData as any).orders : [];
    const inactiveOrders = Array.isArray((inactiveData as any).orders) ? (inactiveData as any).orders : [];

    const pendingOrder = [...activeOrders, ...inactiveOrders].find(
      (order: any) =>
        Number(order.market_index) === marketId &&
        (order.status === 'submitted' || order.status === 'partially_filled' || order.status === 'open')
    );

    if (pendingOrder) {
      console.log(`[${new Date().toISOString()}] [SCHEDULER] hasPendingRemoteOrder FOUND marketId=${marketId} orderId=${pendingOrder.order_id}`);
      return true;
    }

    console.log(`[${new Date().toISOString()}] [SCHEDULER] hasPendingRemoteOrder NONE marketId=${marketId}`);
    return false;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [SCHEDULER] hasPendingRemoteOrder ERROR marketId=${marketId}:`, error);
    return false;
  }
}

async function verifyRemotePositionClosed(symbol: string, marketId: number): Promise<boolean> {
  if (PAPER_TRADING || !signerClient) return true;
  const accountIndex = Number(process.env.LIGHTER_ACCOUNT_INDEX ?? 0);
  console.log(`[${new Date().toISOString()}] [SCHEDULER] verifyRemotePositionClosed START symbol=${symbol} marketId=${marketId}`);
  for (const delay of [0, 250, 500, 1000, 2000, 3000]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const remotePositions = await fetchAccountPositions(signerClient, accountIndex);
    const remote = remotePositions.find(position => position.marketId === marketId) ?? remotePositions.find(position => normalizeSymbol(position.symbol) === normalizeSymbol(symbol));
    if (!remote) {
      console.log(`[${new Date().toISOString()}] [SCHEDULER] verifyRemotePositionClosed OK symbol=${symbol} marketId=${marketId}`);
      return true;
    }
    console.log(`[${new Date().toISOString()}] [SCHEDULER] verifyRemotePositionClosed STILL_EXISTS symbol=${symbol} marketId=${marketId}`);
  }
  notifyError({ context: 'position-close-verification', symbol, error: `Position ${symbol} still exists on exchange after close` });
  return false;
}

async function checkSignals(): Promise<void> {
  if (signalCheckRunning) {
    console.log(`[${new Date().toISOString()}] [SCHEDULER] checkSignals SKIP already running`);
    return;
  }
  signalCheckRunning = true;

  const results: SignalResult[] = [];
  const errorsBySymbol = new Map<string, string>();

  try {
    const tradingPairs = new Set(getActiveTradingPairs().map(normalizeSymbol));
    console.log(`[${new Date().toISOString()}] [SCHEDULER] checkSymbols START symbolsCount=${tradingPairs.size}`);

    for (const rawSymbol of tradingPairs) {
      const symbol = normalizeSymbol(rawSymbol);
      try {
        console.log(`[${new Date().toISOString()}] [SCHEDULER] checkSignals SYMBOL=${symbol}`);

        if (isReconciliationPending(symbol)) {
          console.log(`[${new Date().toISOString()}] [SCHEDULER] checkSignals RECONCILIATION_PENDING symbol=${symbol}`);
          results.push({ symbol, status: 'not-ready', regime: 'reconciliation-pending', hasSignal: false, reason: 'Confirmed fill is awaiting remote position reconciliation' });
          continue;
        }

        if (isSymbolLocked(symbol) || isPositionOpening(symbol)) {
          console.log(`[${new Date().toISOString()}] [SCHEDULER] checkSignals LOCKED symbol=${symbol}`);
          results.push({ symbol, status: 'not-ready', regime: 'locked', hasSignal: false, reason: 'Symbol is locked' });
          continue;
        }

        if (hasOpenPosition(symbol)) {
          console.log(`[${new Date().toISOString()}] [SCHEDULER] checkSignals POSITION_OPEN symbol=${symbol}`);
          results.push({ symbol, status: 'position-open', regime: 'position-open', hasSignal: false, reason: 'Open position exists' });
          continue;
        }

        if (getOpenPositionsCount() >= MAX_PARALLEL_POSITIONS) {
          console.log(`[${new Date().toISOString()}] [SCHEDULER] checkSignals MAX_POSITIONS symbol=${symbol}`);
          results.push({ symbol, status: 'max-positions', regime: 'max-positions', hasSignal: false, reason: `Max positions reached: ${MAX_PARALLEL_POSITIONS}` });
          continue;
        }

        const pendingOrder = await hasPendingRemoteOrder(resolveMarket(symbol).marketId);
        if (pendingOrder) {
          console.log(`[${new Date().toISOString()}] [SCHEDULER] checkSignals PENDING_REMOTE_ORDER symbol=${symbol}`);
          results.push({ symbol, status: 'not-ready', regime: 'pending-order', hasSignal: false, reason: 'Pending remote order exists' });
          continue;
        }

        const result = await runBotOnce(symbol, '15m');
        if (!result.ready) {
          console.log(`[${new Date().toISOString()}] [SCHEDULER] checkSignals NOT_READY symbol=${symbol} reason=${result.reason ?? 'unknown'}`);
          results.push({ symbol, status: 'not-ready', regime: 'unknown', hasSignal: false, reason: result.reason ?? 'Strategy result is not ready' });
          continue;
        }

        const buy = (result as any).buy as boolean;
        const sell = (result as any).sell as boolean;
        const side = (result as any).side as 'long' | 'short' | 'none';
        const price = (result as any).price as number;
        const takeProfitPrice = (result as any).takeProfitPrice as number | null;
        const stopLossPrice = (result as any).stopLossPrice as number | null;
        const regime = (result as any).regime as string;
        const indicators = (result as any).indicators as any;

        if ((result as any).skipReason) {
          console.log(`[${new Date().toISOString()}] [SCHEDULER] checkSignals SKIP symbol=${symbol} reason=${(result as any).skipReason}`);
          results.push({ symbol, status: 'no-signal', regime, hasSignal: false, reason: (result as any).skipReason });
          continue;
        }

        if (!buy && !sell) {
          console.log(`[${new Date().toISOString()}] [SCHEDULER] checkSignals NO_SIGNAL symbol=${symbol}`);
          results.push({ symbol, status: 'no-signal', regime, hasSignal: false, reason: 'No signal' });
          continue;
        }

        if (side !== 'long' && side !== 'short') {
          console.error(`[${new Date().toISOString()}] [SCHEDULER] checkSignals INVALID_SIDE symbol=${symbol} side=${side}`);
          results.push({ symbol, status: 'error', regime, hasSignal: true, side: 'none', price, reason: 'Signal side is invalid' });
          errorsBySymbol.set(symbol, 'Signal side is invalid');
          continue;
        }

        const expectedPrice = validateSignalPrice(price);
        if (takeProfitPrice == null || stopLossPrice == null) throw new Error('Take profit or stop loss is missing');
        const marketId = requireMarketId(resolveMarket(symbol).marketId, `open ${symbol}`);
        const activeMarket = getActiveMarket(symbol);
        if (!activeMarket) throw new Error(`Active market metadata not found: ${symbol}`);

        const stopDistance = Math.abs(expectedPrice - stopLossPrice);
        const totalRiskPerUnit = stopDistance + stopDistance * TRADE_FEE_RATE;
        if (!Number.isFinite(totalRiskPerUnit) || totalRiskPerUnit <= 0) throw new Error(`Invalid total risk per unit: ${totalRiskPerUnit}`);
        const rawQuantity = validateQuantity(Math.min(getRiskCapital() / totalRiskPerUnit, getPositionNotional() / expectedPrice));
        const quantity = validateQuantity(Math.floor(rawQuantity * 10 ** activeMarket.sizeDecimals) / 10 ** activeMarket.sizeDecimals);

        if (!beginPositionOpening(symbol)) {
          console.log(`[${new Date().toISOString()}] [SCHEDULER] checkSignals OPENING_IN_PROGRESS symbol=${symbol}`);
          results.push({ symbol, status: 'not-ready', regime: 'opening', hasSignal: true, side, price: expectedPrice, reason: 'Opening already in progress' });
          continue;
        }

        try {
          const clientOrderId = `${symbol}-${Date.now()}-open`;
          console.log(`[${new Date().toISOString()}] [SCHEDULER] checkSignals OPENING symbol=${symbol} side=${side} quantity=${quantity} price=${expectedPrice}`);

          const executionResult = await executionService.openPosition({ symbol, marketId, side, quantity, expectedPrice, clientOrderId, priceDecimals: activeMarket.priceDecimals, sizeDecimals: activeMarket.sizeDecimals, stopLossPrice, takeProfitPrice });

          if (!executionResult.ok) {
            console.warn(`[${new Date().toISOString()}] [SCHEDULER] checkSignals EXECUTION_FAILED symbol=${symbol} status=${executionResult.status} message=${executionResult.message}`);
            if (executionResult.status === 'unknown') markReconciliationPending(symbol);
            results.push({ symbol, status: executionResult.status === 'unknown' ? 'not-ready' : 'signal', regime, hasSignal: true, side, price: expectedPrice, reason: executionResult.message ?? 'Execution failed' });
            errorsBySymbol.set(symbol, executionResult.message ?? 'Execution failed');
            continue;
          }

          if (executionResult.filledQuantity <= 0 || executionResult.averageFillPrice == null) {
            console.warn(`[${new Date().toISOString()}] [SCHEDULER] checkSignals RECONCILIATION_REQUIRED symbol=${symbol} filledQuantity=${executionResult.filledQuantity}`);
            markReconciliationPending(symbol);
            results.push({ symbol, status: 'not-ready', regime, hasSignal: true, side, price: expectedPrice, reason: 'Fill result requires reconciliation' });
            errorsBySymbol.set(symbol, 'Fill result requires reconciliation');
            continue;
          }

          const openResult = openPosition({
            symbol,
            marketId,
            side,
            entryPrice: executionResult.averageFillPrice,
            quantity: executionResult.filledQuantity,
            takeProfitPrice,
            stopLossPrice,
            exchangeStopLossPrice: stopLossPrice,
            exchangeTakeProfitPrice: takeProfitPrice,
            exchangeStopLossOrderId: executionResult.protectiveOrders?.stopLossOrderId,
            exchangeTakeProfitOrderId: executionResult.protectiveOrders?.takeProfitOrderId,
            exchangeStopLossClientOrderIndex: executionResult.protectiveOrders?.stopLossClientOrderIndex,
            exchangeTakeProfitClientOrderIndex: executionResult.protectiveOrders?.takeProfitClientOrderIndex,
            metadata: {
              regime,
              macdCrossUp: indicators?.macdCrossUp ?? false,
              macdCrossDown: indicators?.macdCrossDown ?? false,
              lastRsi: indicators?.lastRsi ?? 0,
              lastAtr: indicators?.lastAtr ?? 0,
              adx: indicators?.regimeIndicators?.adx ?? 0,
              bbWidth: indicators?.regimeIndicators?.bbWidth ?? 0,
              atrPct: indicators?.regimeIndicators?.atrPct ?? 0,
              ema20: indicators?.regimeIndicators?.ema20 ?? 0,
              ema50: indicators?.regimeIndicators?.ema50 ?? 0,
              ema200: indicators?.regimeIndicators?.ema200 ?? 0,
              entryExtensionAtr: indicators?.entryExtensionAtr ?? 0,
              maxEntryExtensionAtr: indicators?.maxEntryExtensionAtr ?? 0,
              entryTooExtended: indicators?.entryTooExtended ?? false
            },
            executionOrderId: executionResult.orderId,
            clientOrderId
          });

          if (!openResult.ok) {
            console.error(`[${new Date().toISOString()}] [SCHEDULER] checkSignals LOCAL_STATE_FAILED symbol=${symbol} message=${openResult.message}`);
            markReconciliationPending(symbol);
            results.push({ symbol, status: 'error', regime, hasSignal: true, side, price: expectedPrice, reason: `Filled but local state was not created: ${openResult.message}` });
            errorsBySymbol.set(symbol, openResult.message);
            continue;
          }

          if (!PAPER_TRADING && signerClient) {
            const accountIndex = Number(process.env.LIGHTER_ACCOUNT_INDEX ?? 0);
            const verification = await verifyPositionAfterFill(signerClient, accountIndex, marketId, symbol, side, executionResult.filledQuantity);
            if (!verification.ok) {
              console.warn(`[${new Date().toISOString()}] [SCHEDULER] checkSignals VERIFICATION_PENDING symbol=${symbol} mismatch=${verification.mismatch}`);
              markReconciliationPending(symbol);
              notifyError({ context: 'signal-check', symbol, error: `Position verification pending: ${verification.mismatch}` });
              results.push({ symbol, status: 'not-ready', regime, hasSignal: true, side, price: expectedPrice, reason: `Position reconciliation pending: ${verification.mismatch}` });
              errorsBySymbol.set(symbol, verification.mismatch ?? 'Verification failed');
              continue;
            }
            console.log(`[${new Date().toISOString()}] [SCHEDULER] checkSignals VERIFICATION_OK symbol=${symbol}`);
            unlockSymbol(symbol);
            await syncLiveBalance(signerClient, accountIndex).catch(error => console.error(`[${new Date().toISOString()}] Balance sync after open failed:`, error)); // ← Исправлено
          } else {
            unlockSymbol(symbol);
          }

          console.log(`[${new Date().toISOString()}] [SCHEDULER] checkSignals POSITION_OPENED symbol=${symbol}`);
          results.push({ symbol, status: 'signal', regime, hasSignal: true, side, price: expectedPrice, reason: 'Position opened' });
        } finally {
          endPositionOpening(symbol);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[${new Date().toISOString()}] [SCHEDULER] checkSignals ERROR symbol=${symbol} error=${message}`);
        logError({ timestamp: new Date().toISOString(), context: 'signal-check', symbol, error: message });
        errorsBySymbol.set(symbol, message);
        results.push({ symbol, status: 'error', regime: 'error', hasSignal: false, reason: message });
      }
    }

    console.log(`[${new Date().toISOString()}] [SCHEDULER] checkSignals END symbolsCount=${tradingPairs.size}`);

    await sendAggregatedSignalSummary({
      results,
      errorsBySymbol: errorsBySymbol.size > 0 ? Object.fromEntries(errorsBySymbol) : undefined
    });
  } finally {
    signalCheckRunning = false;
  }
}

async function executeClose(position: ReturnType<typeof getPositions>[number], currentPrice: number, reason: 'take_profit' | 'stop_loss' | 'time_stop' | 'breakeven_stop' | 'dead_trade_mfe'): Promise<boolean> {
  const marketId = requireMarketId(position.marketId, `close ${position.symbol}`);
  const activeMarket = getActiveMarket(position.symbol);
  if (!activeMarket) throw new Error(`Active market metadata not found: ${position.symbol}`);
  const clientOrderId = `${position.symbol}-${Date.now()}-${reason}`;

  console.log(`[${new Date().toISOString()}] [SCHEDULER] executeClose START symbol=${position.symbol} reason=${reason} quantity=${position.quantity}`);

  const executionResult = await executionService.closePosition({ symbol: position.symbol, marketId, positionSide: position.side, quantity: position.quantity, expectedPrice: currentPrice, reason, clientOrderId, priceDecimals: activeMarket.priceDecimals, sizeDecimals: activeMarket.sizeDecimals });
  if (!executionResult.ok) throw new Error(`Close execution failed for ${position.symbol}: ${executionResult.message ?? 'unknown error'}`);
  if (executionResult.filledQuantity <= 0 || executionResult.averageFillPrice == null) throw new Error(`Close execution returned no confirmed fill for ${position.symbol}`);

  if (executionResult.filledQuantity < position.quantity * 0.999999) {
    console.log(`[${new Date().toISOString()}] [SCHEDULER] executeClose PARTIAL symbol=${position.symbol} filled=${executionResult.filledQuantity} original=${position.quantity}`);
    const partial = partialClosePosition(position.id, executionResult.filledQuantity, executionResult.averageFillPrice, { executionOrderId: executionResult.orderId, clientOrderId, fee: executionResult.fee });
    if (!partial.ok) throw new Error(`Partial close state update failed for ${position.symbol}: ${partial.message}`);
    console.log(`[${new Date().toISOString()}] [SCHEDULER] executeClose PARTIAL_OK symbol=${position.symbol}`);
    return true;
  }

  if (executionService.cancelProtectiveOrders && (position.exchangeStopLossOrderId || position.exchangeTakeProfitOrderId)) {
    console.log(`[${new Date().toISOString()}] [SCHEDULER] executeClose CANCEL_PROTECTIVE symbol=${position.symbol}`);
    await executionService.cancelProtectiveOrders({ marketId, stopLossOrderId: position.exchangeStopLossOrderId, takeProfitOrderId: position.exchangeTakeProfitOrderId, stopLossClientOrderIndex: position.exchangeStopLossClientOrderIndex ?? 0, takeProfitClientOrderIndex: position.exchangeTakeProfitClientOrderIndex ?? 0 });
    console.log(`[${new Date().toISOString()}] [SCHEDULER] executeClose CANCEL_PROTECTIVE_OK symbol=${position.symbol}`);
  }

  const result = closePosition(position.id, executionResult.averageFillPrice, reason, { executionOrderId: executionResult.orderId, clientOrderId, fee: executionResult.fee });
  if (!result.ok) throw new Error(`Close state update failed for ${position.symbol}: ${result.message}`);

  console.log(`[${new Date().toISOString()}] [SCHEDULER] executeClose OK symbol=${position.symbol} reason=${reason}`);
  return true;
}

async function checkPositions(): Promise<void> {
  if (positionCheckRunning) {
    console.log(`[${new Date().toISOString()}] [SCHEDULER] checkPositions SKIP already running`);
    return;
  }
  positionCheckRunning = true;
  try {
    const snapshot = getPositions();
    console.log(`[${new Date().toISOString()}] [SCHEDULER] checkPositions START positionsCount=${snapshot.length}`);

    for (const snapshotPosition of snapshot) {
      const position = getPositions().find(item => item.id === snapshotPosition.id);
      if (!position || isReconciliationPending(position.symbol)) {
        console.log(`[${new Date().toISOString()}] [SCHEDULER] checkPositions SKIP symbol=${position?.symbol} reason=${position ? 'reconciliation-pending' : 'not found'}`);
        continue;
      }

      const symbol = normalizeSymbol(position.symbol);
      try {
        const markPrice = getMarkPrice(symbol);
        const exitPrice = getExitPrice(symbol, position.side);
        if (markPrice == null || !Number.isFinite(markPrice) || markPrice <= 0) throw new Error(`Mark price unavailable for ${symbol}`);
        if (exitPrice == null || !Number.isFinite(exitPrice) || exitPrice <= 0) throw new Error(`Exit price unavailable for ${symbol}`);

        const pnl = position.side === 'long' ? (markPrice - position.entryPrice) * position.quantity : (position.entryPrice - markPrice) * position.quantity;
        const pnlPercent = position.notional > 0 ? pnl / position.notional * 100 : 0;
        const previousMax = position.metadata?.maxUnrealizedPnL ?? Number.NEGATIVE_INFINITY;
        const previousMaxPercent = position.metadata?.maxUnrealizedPnLPercent ?? Number.NEGATIVE_INFINITY;
        const maxPnl = Math.max(previousMax, pnl);
        const maxPnlPercent = Math.max(previousMaxPercent, pnlPercent);

        updatePositionMetadata(position.id, { maxUnrealizedPnL: maxPnl, maxUnrealizedPnLPercent: maxPnlPercent, worstUnrealizedPnL: Math.min(position.metadata?.worstUnrealizedPnL ?? Infinity, pnl), worstUnrealizedPnLPercent: Math.min(position.metadata?.worstUnrealizedPnLPercent ?? Infinity, pnlPercent) });

        const tpHit = position.side === 'long' ? markPrice >= position.takeProfitPrice : markPrice <= position.takeProfitPrice;
        const slHit = position.side === 'long' ? markPrice <= position.stopLossPrice : markPrice >= position.stopLossPrice;

        if (tpHit) {
          console.log(`[${new Date().toISOString()}] [SCHEDULER] checkPositions TP_HIT symbol=${symbol} pnl=${pnl.toFixed(2)}`);
          await executeClose(position, exitPrice, 'take_profit');
        } else if (slHit) {
          console.log(`[${new Date().toISOString()}] [SCHEDULER] checkPositions SL_HIT symbol=${symbol} pnl=${pnl.toFixed(2)} beTriggered=${position.metadata?.beTriggered ?? false}`);
          await executeClose(position, exitPrice, position.metadata?.beTriggered ? 'breakeven_stop' : 'stop_loss');
        } else {
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
            positionAgeSeconds: Math.max(0, Math.floor((Date.now() - new Date(position.openedAt).getTime()) / 1000))
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[${new Date().toISOString()}] [SCHEDULER] checkPositions ERROR symbol=${symbol} error=${message}`);
        notifyError({ context: 'position-check', symbol, error: message });
      }
    }

    console.log(`[${new Date().toISOString()}] [SCHEDULER] checkPositions END`);
  } finally {
    positionCheckRunning = false;
  }
}

export async function startScheduler(): Promise<void> {
  if (schedulerStarted) {
    console.warn(`[${new Date().toISOString()}] [SCHEDULER] startScheduler SKIP already started`);
    return;
  }

  console.log(`[${new Date().toISOString()}] [SCHEDULER] startScheduler START`);
  schedulerStarted = true;
  schedulerStopping = false;

  try {
    executionService = createExecutionService();
    initializeSignerClient();
    await refreshTopMarkets();

    if (!PAPER_TRADING && signerClient) {
      const accountIndex = Number(process.env.LIGHTER_ACCOUNT_INDEX ?? 0);
      await syncLiveBalance(signerClient, accountIndex); // ← Исправлено
      const restore = await restoreStateAfterRestart(signerClient, accountIndex);
      if (restore.errors > 0) notifyError({ context: 'reconciliation', error: `State reconciliation completed with ${restore.errors} errors` });
      startReconciliationLoop(signerClient, accountIndex);
      startBalanceSyncLoop(accountIndex);
    }

    startMarketRefresh();
    await checkSignals();
    await checkPositions();

    signalCheckInterval = setInterval(() => void checkSignals().catch(console.error), SIGNAL_CHECK_INTERVAL_MS);
    positionCheckInterval = setInterval(() => void checkPositions().catch(console.error), POSITION_CHECK_INTERVAL_MS);

    notifyStartup({ port: Number(process.env.PORT) || 3006, tradingPairs: getActiveTradingPairs(), signalInterval: SIGNAL_CHECK_INTERVAL_MS / 1000, positionInterval: POSITION_CHECK_INTERVAL_MS / 1000 });
    console.log(`[${new Date().toISOString()}] [SCHEDULER] startScheduler OK`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [SCHEDULER] startScheduler ERROR:`, error);
    schedulerStarted = false;
    stopMarketRefresh();
    stopReconciliationLoop();
    stopBalanceSyncLoop();
    executionService?.stop?.();
    throw error;
  }
}

export async function stopScheduler(): Promise<void> {
  console.log(`[${new Date().toISOString()}] [SCHEDULER] stopScheduler START`);

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
    for (const symbol of new Set([...getPositions().map(position => normalizeSymbol(position.symbol)), ...getActiveTradingPairs().map(normalizeSymbol)])) {
      try { stopMarketData(symbol); } catch (error) { console.error(`[${new Date().toISOString()}] Failed to stop market data for ${symbol}:`, error); }
    }
  }

  await flushPositionPersistence().catch(error => console.error(`[${new Date().toISOString()}] Failed to flush persistence:`, error));
  schedulerStarted = false;

  console.log(`[${new Date().toISOString()}] [SCHEDULER] stopScheduler OK`);
}
