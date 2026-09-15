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
  getRiskCapital,
  getPositionNotional,
  updatePositionMetadata,
  partialClosePosition,
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

const LIGHTER_API_URL =
  process.env.LIGHTER_API_URL ??
  'https://mainnet.zklighter.elliot.ai';

const PAPER_TRADING =
  process.env.PAPER_TRADING !== 'false';

const SIGNAL_LOCK_MS =
  15 * 60_000;

let executionService: ExecutionService;
let signerClient: SignerClient | null = null;

let reconciliationInterval:
  | NodeJS.Timeout
  | null = null;

let balanceSyncInterval:
  | NodeJS.Timeout
  | null = null;

let signalCheckInterval:
  | NodeJS.Timeout
  | null = null;

let positionCheckInterval:
  | NodeJS.Timeout
  | null = null;

let signalCheckRunning = false;
let positionCheckRunning = false;
let schedulerStopping = false;
let schedulerStarted = false;

const symbolLocks =
  new Map<string, number>();

type SignalResult = {
  symbol: string;
  status:
    | 'signal'
    | 'no-signal'
    | 'position-open'
    | 'max-positions'
    | 'not-ready'
    | 'error';
  regime: string;
  hasSignal: boolean;
  side?: 'long' | 'short' | 'none';
  price?: number;
  reason?: string;
};

function isSymbolLocked(
  symbol: string
): boolean {
  const key =
    normalizeSymbol(symbol);

  const until =
    symbolLocks.get(key);

  if (!until) {
    return false;
  }

  if (Date.now() >= until) {
    symbolLocks.delete(key);
    return false;
  }

  return true;
}

function lockSymbol(
  symbol: string,
  durationMs = SIGNAL_LOCK_MS
): void {
  symbolLocks.set(
    normalizeSymbol(symbol),
    Date.now() + durationMs
  );
}

function unlockSymbol(
  symbol: string
): void {
  const key =
    normalizeSymbol(symbol);

  symbolLocks.delete(key);
  removeReconciliationPendingSymbol(key);
}

function markReconciliationPending(
  symbol: string
): void {
  const key =
    normalizeSymbol(symbol);

  addReconciliationPendingSymbol(key);
  lockSymbol(key, SIGNAL_LOCK_MS);
}

function isReconciliationPending(
  symbol: string
): boolean {
  return isReconciliationPendingSymbol(symbol);
}

function formatPrice(
  price: number
): string {
  return Number.isFinite(price)
    ? price.toFixed(4)
    : 'n/a';
}

function requireMarketId(
  marketId: number | undefined,
  context: string
): number {
  if (
    marketId == null ||
    !Number.isInteger(marketId) ||
    marketId < 0
  ) {
    throw new Error(
      `Missing or invalid marketId for ${context}: ${marketId}`
    );
  }

  return marketId;
}

function validateSignalPrice(
  price: number | undefined
): number {
  if (
    price == null ||
    !Number.isFinite(price) ||
    price <= 0
  ) {
    throw new Error(
      `Invalid signal price: ${price}`
    );
  }

  return price;
}

function validateQuantity(
  quantity: number
): number {
  if (
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    throw new Error(
      `Invalid order quantity: ${quantity}`
    );
  }

  return quantity;
}

function createExecutionService(): ExecutionService {
  if (PAPER_TRADING) {
    return new PaperExecutionService();
  }

  const secret =
    process.env.LIGHTER_API_SECRET ?? '';

  const apiKeyIndex =
    Number(
      process.env.LIGHTER_API_KEY_INDEX ?? 0
    );

  const accountIndex =
    Number(
      process.env.LIGHTER_ACCOUNT_INDEX ?? 0
    );

  if (!secret) {
    throw new Error(
      'LIGHTER_API_SECRET is required in live mode'
    );
  }

  if (
    !Number.isInteger(apiKeyIndex) ||
    apiKeyIndex < 0 ||
    apiKeyIndex > 254
  ) {
    throw new Error(
      `Invalid LIGHTER_API_KEY_INDEX: ${apiKeyIndex}`
    );
  }

  if (
    !Number.isInteger(accountIndex) ||
    accountIndex < 0
  ) {
    throw new Error(
      `Invalid LIGHTER_ACCOUNT_INDEX: ${accountIndex}`
    );
  }

  return new LighterExecutionService(
    secret,
    apiKeyIndex,
    accountIndex
  );
}

function initializeSignerClient(): void {
  if (PAPER_TRADING) {
    signerClient = null;
    return;
  }

  const secret =
    process.env.LIGHTER_API_SECRET ?? '';

  const apiKeyIndex =
    Number(
      process.env.LIGHTER_API_KEY_INDEX ?? 0
    );

  const accountIndex =
    Number(
      process.env.LIGHTER_ACCOUNT_INDEX ?? 0
    );

  if (!secret) {
    throw new Error(
      'LIGHTER_API_SECRET is required in live mode'
    );
  }

  const key =
    secret.startsWith('0x')
      ? secret.slice(2)
      : secret;

  signerClient = new SignerClient(
    process.env.LIGHTER_API_URL ??
      'https://mainnet.zklighter.elliot.ai',
    key,
    apiKeyIndex,
    accountIndex
  );
}

function startReconciliationLoop(
  client: SignerClient,
  accountIndex: number
): void {
  reconciliationInterval = setInterval(() => {
    void reconcileAccount(
      client,
      accountIndex,
      {
        autoFix: false,
        dryRun: true
      }
    ).catch(error => {
      console.error(
        `[${new Date().toISOString()}] ` +
        `Periodic reconciliation error:`,
        error
      );
    });
  }, 15 * 60_000);
}

function stopReconciliationLoop(): void {
  if (reconciliationInterval) {
    clearInterval(reconciliationInterval);
  }

  reconciliationInterval = null;
}

function startBalanceSyncLoop(
  accountIndex: number
): void {
  balanceSyncInterval = setInterval(() => {
    if (!signerClient) {
      return;
    }

    void syncLiveBalance(
      signerClient,
      accountIndex
    ).catch(error => {
      console.error(
        `[${new Date().toISOString()}] ` +
        `Balance sync error:`,
        error
      );
    });
  }, 5 * 60_000);
}

function stopBalanceSyncLoop(): void {
  if (balanceSyncInterval) {
    clearInterval(balanceSyncInterval);
  }

  balanceSyncInterval = null;
}

async function hasPendingRemoteOrder(
  marketId: number
): Promise<boolean> {
  if (PAPER_TRADING || !signerClient) {
    return false;
  }

  const accountIndex =
    Number(
      process.env.LIGHTER_ACCOUNT_INDEX ?? 0
    );

  const apiKeyIndex =
    Number(
      process.env.LIGHTER_API_KEY_INDEX ?? 0
    );

  console.log(
    `[${new Date().toISOString()}] ` +
    `[SCHEDULER] hasPendingRemoteOrder START ` +
    `marketId=${marketId}`
  );

  try {
    const authorization =
      signerClient
        .create_auth_token_with_expiry(
          60 * 60,
          undefined,
          apiKeyIndex
        )[0] ?? '';

    const [activeData, inactiveData] =
      await Promise.all([
        fetch(
          `${LIGHTER_API_URL}/api/v1/accountActiveOrders?` +
          `account_index=${accountIndex}&limit=100`,
          {
            headers: {
              Accept: 'application/json',
              Authorization: authorization
            }
          }
        ).then(response => response.json()),

        fetch(
          `${LIGHTER_API_URL}/api/v1/accountInactiveOrders?` +
          `account_index=${accountIndex}&limit=100`,
          {
            headers: {
              Accept: 'application/json',
              Authorization: authorization
            }
          }
        ).then(response => response.json())
      ]);

    const activeOrders =
      Array.isArray((activeData as any).orders)
        ? (activeData as any).orders
        : [];

    const inactiveOrders =
      Array.isArray((inactiveData as any).orders)
        ? (inactiveData as any).orders
        : [];

    const pendingOrder =
      [...activeOrders, ...inactiveOrders].find(
        (order: any) =>
          Number(order.market_index) === marketId &&
          (
            order.status === 'submitted' ||
            order.status === 'partially_filled' ||
            order.status === 'open'
          )
      );

    if (pendingOrder) {
      console.log(
        `[${new Date().toISOString()}] ` +
        `[SCHEDULER] hasPendingRemoteOrder FOUND ` +
        `marketId=${marketId} ` +
        `orderId=${pendingOrder.order_id}`
      );

      return true;
    }

    console.log(
      `[${new Date().toISOString()}] ` +
      `[SCHEDULER] hasPendingRemoteOrder NONE ` +
      `marketId=${marketId}`
    );

    return false;
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] ` +
      `[SCHEDULER] hasPendingRemoteOrder ERROR ` +
      `marketId=${marketId}:`,
      error
    );

    return false;
  }
}

async function checkSignals(): Promise<void> {
  if (signalCheckRunning) {
    console.log(
      `[${new Date().toISOString()}] ` +
      `[SCHEDULER] checkSignals SKIP already running`
    );

    return;
  }

  signalCheckRunning = true;

  const results: SignalResult[] = [];
  const errorsBySymbol =
    new Map<string, string>();

  try {
    const tradingPairs =
      new Set(
        getActiveTradingPairs()
          .map(normalizeSymbol)
      );

    console.log(
      `[${new Date().toISOString()}] ` +
      `[SCHEDULER] checkSignals START ` +
      `symbolsCount=${tradingPairs.size}`
    );

    for (const rawSymbol of tradingPairs) {
      const symbol =
        normalizeSymbol(rawSymbol);

      try {
        console.log(
          `[${new Date().toISOString()}] ` +
          `[SCHEDULER] checkSignals SYMBOL=${symbol}`
        );

        if (isReconciliationPending(symbol)) {
          const reason =
            'Confirmed fill is awaiting remote position reconciliation';

          console.log(
            `[${new Date().toISOString()}] ` +
            `[SCHEDULER] checkSignals RECONCILIATION_PENDING ` +
            `symbol=${symbol}`
          );

          results.push({
            symbol,
            status: 'not-ready',
            regime: 'reconciliation-pending',
            hasSignal: false,
            reason
          });

          continue;
        }

        if (
          isSymbolLocked(symbol) ||
          isPositionOpening(symbol)
        ) {
          const reason =
            'Symbol is locked';

          console.log(
            `[${new Date().toISOString()}] ` +
            `[SCHEDULER] checkSignals LOCKED ` +
            `symbol=${symbol}`
          );

          results.push({
            symbol,
            status: 'not-ready',
            regime: 'locked',
            hasSignal: false,
            reason
          });

          continue;
        }

        if (hasOpenPosition(symbol)) {
          const reason =
            'Open position exists';

          console.log(
            `[${new Date().toISOString()}] ` +
            `[SCHEDULER] checkSignals POSITION_OPEN ` +
            `symbol=${symbol}`
          );

          results.push({
            symbol,
            status: 'position-open',
            regime: 'position-open',
            hasSignal: false,
            reason
          });

          continue;
        }

        if (
          getOpenPositionsCount() >=
          MAX_PARALLEL_POSITIONS
        ) {
          const reason =
            `Max positions reached: ` +
            `${MAX_PARALLEL_POSITIONS}`;

          console.log(
            `[${new Date().toISOString()}] ` +
            `[SCHEDULER] checkSignals MAX_POSITIONS ` +
            `symbol=${symbol}`
          );

          results.push({
            symbol,
            status: 'max-positions',
            regime: 'max-positions',
            hasSignal: false,
            reason
          });

          continue;
        }

        const market =
          resolveMarket(symbol);

        const marketId =
          requireMarketId(
            market.marketId,
            `signal check ${symbol}`
          );

        const pendingOrder =
          await hasPendingRemoteOrder(marketId);

        if (pendingOrder) {
          const reason =
            'Pending remote order exists';

          console.log(
            `[${new Date().toISOString()}] ` +
            `[SCHEDULER] checkSignals PENDING_REMOTE_ORDER ` +
            `symbol=${symbol}`
          );

          results.push({
            symbol,
            status: 'not-ready',
            regime: 'pending-order',
            hasSignal: false,
            reason
          });

          continue;
        }

        const result =
          await runBotOnce(
            symbol,
            '15m'
          );

        if (!result.ready) {
          const reason =
            result.reason ??
            'Strategy result is not ready';

          console.log(
            `[${new Date().toISOString()}] ` +
            `[SCHEDULER] checkSignals NOT_READY ` +
            `symbol=${symbol} reason=${reason}`
          );

          results.push({
            symbol,
            status: 'not-ready',
            regime: 'unknown',
            hasSignal: false,
            reason
          });

          continue;
        }

        const buy =
          (result as any).buy as boolean;

        const sell =
          (result as any).sell as boolean;

        const side =
          (result as any).side as
            | 'long'
            | 'short'
            | 'none';

        const price =
          (result as any).price as number;

        const takeProfitPrice =
          (result as any)
            .takeProfitPrice as number | null;

        const stopLossPrice =
          (result as any)
            .stopLossPrice as number | null;

        const positionSize =
          (result as any)
            .positionSize as number | null;

        const regime =
          (result as any).regime as string;

        const skipReason =
          (result as any)
            .skipReason as string | null;

        const signalTime =
          (result as any).signalTime as
            | number
            | undefined;

        const signalTimeIso =
          (result as any).signalTimeIso as
            | string
            | undefined;

        const indicators =
          (result as any).indicators as any;

        const isTradingWindow =
          isTradingTimeUtcPlus4(new Date());

        logSignalCheck({
          timestamp: new Date().toISOString(),
          symbol,
          timeframe: '15m',
          side: side ?? 'none',
          price: price ?? 0,
          regime: regime ?? 'unknown',
          takeProfitPrice:
            takeProfitPrice ?? null,
          stopLossPrice:
            stopLossPrice ?? null,
          positionSize:
            positionSize ?? null,
          macdCrossUp:
            indicators?.macdCrossUp ?? false,
          macdCrossDown:
            indicators?.macdCrossDown ?? false,
          lastRsi:
            indicators?.lastRsi ?? 0,
          lastAtr:
            indicators?.lastAtr ?? 0,
          rsiBull: false,
          rsiBear: false,
          bbUpper:
            indicators?.bbUpper ?? 0,
          bbMiddle:
            indicators?.bbMiddle ?? 0,
          bbLower:
            indicators?.bbLower ?? 0,
          adx:
            indicators?.adx ?? 0,
          adxRising:
            indicators?.regimeIndicators?.adxRising ??
            false,
          ema20:
            indicators?.ema20 ?? 0,
          ema50:
            indicators?.regimeIndicators?.ema50 ?? 0,
          ema200:
            indicators?.ema200 ?? 0,
          bbWidth:
            indicators?.bbWidth ?? 0,
          atrPct:
            indicators?.atrPct ?? 0,
          signalTriggered:
            buy || sell,
          positionOpened: false,
          entryDistanceFromEma20:
            indicators?.entryDistanceFromEma20 ??
            null,
          entryDistanceFromEma20Atr:
            indicators?.entryDistanceFromEma20Atr ??
            null,
          entryTooExtended:
            indicators?.entryTooExtended ?? false,
          signalTimeIso:
            signalTimeIso ??
            new Date().toISOString(),
          isTradingWindow
        });

        /*
         * Стратегия сама блокирует вход вне временного окна и
         * возвращает buy/sell=false с skipReason.
         * Этот лог нужен именно для явной диагностики окна.
         */
        if (
          !isTradingWindow &&
          skipReason
        ) {
          console.log(
            `[${new Date().toISOString()}] ` +
            `[SCHEDULER] checkSignals OUTSIDE_TRADING_WINDOW ` +
            `symbol=${symbol} ` +
            `reason=${skipReason}`
          );
        }

        if (skipReason) {
          console.log(
            `[${new Date().toISOString()}] ` +
            `[SCHEDULER] checkSignals SKIP ` +
            `symbol=${symbol} ` +
            `reason=${skipReason}`
          );

          results.push({
            symbol,
            status: 'no-signal',
            regime,
            hasSignal: false,
            side,
            price,
            reason: skipReason
          });

          continue;
        }

        if (!buy && !sell) {
          const reason =
            'No signal';

          console.log(
            `[${new Date().toISOString()}] ` +
            `[SCHEDULER] checkSignals NO_SIGNAL ` +
            `symbol=${symbol}`
          );

          results.push({
            symbol,
            status: 'no-signal',
            regime,
            hasSignal: false,
            side,
            price,
            reason
          });

          continue;
        }

        if (
          side !== 'long' &&
          side !== 'short'
        ) {
          const reason =
            'Signal side is invalid';

          console.error(
            `[${new Date().toISOString()}] ` +
            `[SCHEDULER] checkSignals INVALID_SIDE ` +
            `symbol=${symbol} side=${side}`
          );

          results.push({
            symbol,
            status: 'error',
            regime,
            hasSignal: true,
            side: 'none',
            price,
            reason
          });

          errorsBySymbol.set(
            symbol,
            reason
          );

          continue;
        }

        /*
         * Дополнительная защита на уровне scheduler.
         * Даже если в стратегии случайно будет изменён фильтр,
         * в нерабочее окно ордер не уйдёт на биржу.
         */
        if (!isTradingWindow) {
          const reason =
            'Outside trading window (02:00–13:59 UTC+4)';

          console.log(
            `[${new Date().toISOString()}] ` +
            `[SCHEDULER] checkSignals OUTSIDE_TRADING_WINDOW ` +
            `symbol=${symbol} ` +
            `side=${side} price=${price}`
          );

          results.push({
            symbol,
            status: 'no-signal',
            regime,
            hasSignal: false,
            side,
            price,
            reason
          });

          continue;
        }

        const expectedPrice =
          validateSignalPrice(price);

        if (
          takeProfitPrice == null ||
          stopLossPrice == null
        ) {
          throw new Error(
            'Take profit or stop loss is missing'
          );
        }

        const activeMarket =
          getActiveMarket(symbol);

        if (!activeMarket) {
          throw new Error(
            `Active market metadata not found: ${symbol}`
          );
        }

        const stopDistance =
          Math.abs(
            expectedPrice - stopLossPrice
          );

        const totalRiskPerUnit =
          stopDistance +
          stopDistance * TRADE_FEE_RATE;

        if (
          !Number.isFinite(totalRiskPerUnit) ||
          totalRiskPerUnit <= 0
        ) {
          throw new Error(
            `Invalid total risk per unit: ${totalRiskPerUnit}`
          );
        }

        const rawQuantity =
          validateQuantity(
            Math.min(
              getRiskCapital() / totalRiskPerUnit,
              getPositionNotional() / expectedPrice
            )
          );

        const quantity =
          validateQuantity(
            Math.floor(
              rawQuantity *
              10 ** activeMarket.sizeDecimals
            ) /
            10 ** activeMarket.sizeDecimals
          );

        if (!beginPositionOpening(symbol)) {
          const reason =
            'Opening already in progress';

          console.log(
            `[${new Date().toISOString()}] ` +
            `[SCHEDULER] checkSignals OPENING_IN_PROGRESS ` +
            `symbol=${symbol}`
          );

          results.push({
            symbol,
            status: 'not-ready',
            regime: 'opening',
            hasSignal: true,
            side,
            price: expectedPrice,
            reason
          });

          continue;
        }

        const clientOrderId =
          `${symbol}-${Date.now()}-open`;

        console.log(
          `[${new Date().toISOString()}] ` +
          `[SCHEDULER] checkSignals OPENING ` +
          `symbol=${symbol} ` +
          `side=${side} ` +
          `quantity=${quantity} ` +
          `price=${expectedPrice}`
        );

        const executionResult =
          await executionService.openPosition({
            symbol,
            marketId,
            side,
            quantity,
            expectedPrice,
            clientOrderId,
            priceDecimals:
              activeMarket.priceDecimals,
            sizeDecimals:
              activeMarket.sizeDecimals,
            stopLossPrice,
            takeProfitPrice
          });

        if (!executionResult.ok) {
          endPositionOpening(symbol);

          const reason =
            executionResult.message ??
            'Execution failed';

          console.warn(
            `[${new Date().toISOString()}] ` +
            `[SCHEDULER] checkSignals EXECUTION_FAILED ` +
            `symbol=${symbol} ` +
            `status=${executionResult.status} ` +
            `message=${reason}`
          );

          if (
            executionResult.status ===
            'unknown'
          ) {
            markReconciliationPending(symbol);
          }

          results.push({
            symbol,
            status:
              executionResult.status ===
              'unknown'
                ? 'not-ready'
                : 'signal',
            regime,
            hasSignal: true,
            side,
            price: expectedPrice,
            reason
          });

          errorsBySymbol.set(
            symbol,
            reason
          );

          continue;
        }

        if (
          executionResult.filledQuantity <= 0 ||
          executionResult.averageFillPrice == null
        ) {
          endPositionOpening(symbol);

          const reason =
            'Fill result requires reconciliation';

          console.warn(
            `[${new Date().toISOString()}] ` +
            `[SCHEDULER] checkSignals ` +
            `RECONCILIATION_REQUIRED ` +
            `symbol=${symbol} ` +
            `filledQuantity=${executionResult.filledQuantity}`
          );

          markReconciliationPending(symbol);

          results.push({
            symbol,
            status: 'not-ready',
            regime,
            hasSignal: true,
            side,
            price: expectedPrice,
            reason
          });

          errorsBySymbol.set(
            symbol,
            reason
          );

          continue;
        }

        endPositionOpening(symbol);

        const openResult =
          openPosition({
            symbol,
            marketId,
            side,
            entryPrice:
              executionResult.averageFillPrice,
            quantity:
              executionResult.filledQuantity,
            takeProfitPrice,
            stopLossPrice,
            exchangeStopLossPrice:
              stopLossPrice,
            exchangeTakeProfitPrice:
              takeProfitPrice,
            exchangeStopLossOrderId:
              executionResult.protectiveOrders
                ?.stopLossOrderId,
            exchangeTakeProfitOrderId:
              executionResult.protectiveOrders
                ?.takeProfitOrderId,
            exchangeStopLossClientOrderIndex:
              executionResult.protectiveOrders
                ?.stopLossClientOrderIndex,
            exchangeTakeProfitClientOrderIndex:
              executionResult.protectiveOrders
                ?.takeProfitClientOrderIndex,
            metadata: {
              regime,
              macdCrossUp:
                indicators?.macdCrossUp ?? false,
              macdCrossDown:
                indicators?.macdCrossDown ?? false,
              lastRsi:
                indicators?.lastRsi ?? 0,
              lastAtr:
                indicators?.lastAtr ?? 0,
              adx:
                indicators?.adx ?? 0,
              bbWidth:
                indicators?.bbWidth ?? 0,
              atrPct:
                indicators?.atrPct ?? 0,
              ema20:
                indicators?.ema20 ?? 0,
              ema50:
                indicators?.regimeIndicators?.ema50 ??
                0,
              ema200:
                indicators?.ema200 ?? 0,
              entryExtensionAtr:
                indicators?.entryExtensionAtr ?? 0,
              maxEntryExtensionAtr:
                indicators?.maxEntryExtensionAtr ?? 0,
              entryTooExtended:
                indicators?.entryTooExtended ?? false,
              entryDistanceFromEma20:
                indicators?.entryDistanceFromEma20 ??
                0,
              entryDistanceFromEma20Atr:
                indicators?.entryDistanceFromEma20Atr ??
                0,
              signalTime:
                signalTime ?? Date.now(),
              signalTimeIso:
                signalTimeIso ??
                new Date().toISOString()
            },
            executionOrderId:
              executionResult.orderId,
            clientOrderId
          });

        if (!openResult.ok) {
          const reason =
            `Filled but local state was not created: ` +
            `${openResult.message}`;

          console.error(
            `[${new Date().toISOString()}] ` +
            `[SCHEDULER] checkSignals ` +
            `LOCAL_STATE_FAILED ` +
            `symbol=${symbol} ` +
            `message=${openResult.message}`
          );

          markReconciliationPending(symbol);

          results.push({
            symbol,
            status: 'error',
            regime,
            hasSignal: true,
            side,
            price: expectedPrice,
            reason
          });

          errorsBySymbol.set(
            symbol,
            reason
          );

          continue;
        }

        if (!PAPER_TRADING && signerClient) {
          const accountIndex =
            Number(
              process.env.LIGHTER_ACCOUNT_INDEX ??
              0
            );

          console.log(
            `[${new Date().toISOString()}] ` +
            `[SCHEDULER] checkSignals VERIFICATION_OK ` +
            `symbol=${symbol} ` +
            `(WebSocket confirmed)`
          );

          unlockSymbol(symbol);

          await syncLiveBalance(
            signerClient,
            accountIndex
          ).catch(error => {
            console.error(
              `[${new Date().toISOString()}] ` +
              `Balance sync after open failed:`,
              error
            );
          });
        } else {
          unlockSymbol(symbol);
        }

        console.log(
          `[${new Date().toISOString()}] ` +
          `[SCHEDULER] checkSignals POSITION_OPENED ` +
          `symbol=${symbol}`
        );

        results.push({
          symbol,
          status: 'signal',
          regime,
          hasSignal: true,
          side,
          price: expectedPrice,
          reason: 'Position opened'
        });
      } catch (error) {
        endPositionOpening(symbol);

        const message =
          error instanceof Error
            ? error.message
            : 'Unknown error';

        console.error(
          `[${new Date().toISOString()}] ` +
          `[SCHEDULER] checkSignals ERROR ` +
          `symbol=${symbol} ` +
          `error=${message}`
        );

        logError({
          timestamp: new Date().toISOString(),
          context: 'signal-check',
          symbol,
          error: message
        });

        errorsBySymbol.set(
          symbol,
          message
        );

        results.push({
          symbol,
          status: 'error',
          regime: 'error',
          hasSignal: false,
          reason: message
        });
      }
    }

    console.log(
      `[${new Date().toISOString()}] ` +
      `[SCHEDULER] checkSignals END ` +
      `symbolsCount=${tradingPairs.size}`
    );

    await sendAggregatedSignalSummary({
      results,
      errorsBySymbol:
        errorsBySymbol.size > 0
          ? Object.fromEntries(errorsBySymbol)
          : undefined,
      equity: getBalance()
    });
  } finally {
    signalCheckRunning = false;
  }
}

async function reconcileLocalPositionsWithExchange(
  localPositions: ReturnType<typeof getPositions>
): Promise<void> {
  if (
    PAPER_TRADING ||
    !signerClient ||
    localPositions.length === 0
  ) {
    return;
  }

  const accountIndex =
    Number(
      process.env.LIGHTER_ACCOUNT_INDEX ?? 0
    );

  try {
    const remotePositions =
      await fetchAccountPositions(
        signerClient,
        accountIndex
      );

    const remoteByMarketId =
      new Map(
        remotePositions.map(position => [
          position.marketId,
          position
        ])
      );

    const remoteBySymbol =
      new Map(
        remotePositions.map(position => [
          normalizeSymbol(position.symbol),
          position
        ])
      );

    for (const local of localPositions) {
      const symbol =
        normalizeSymbol(local.symbol);

      const remote =
        local.marketId != null
          ? (
            remoteByMarketId.get(
              local.marketId
            ) ??
            remoteBySymbol.get(symbol)
          )
          : remoteBySymbol.get(symbol);

      /*
       * Локальная позиция исчезла на Lighter:
       * SL/TP мог исполниться, позицию могли закрыть вручную,
       * либо она была ликвидирована.
       */
      if (!remote) {
        const markPrice =
          getMarkPrice(symbol);

        const tpHit =
          markPrice != null &&
          Number.isFinite(markPrice) &&
          (
            local.side === 'long'
              ? markPrice >=
                local.takeProfitPrice
              : markPrice <=
                local.takeProfitPrice
          );

        const closeReason:
          | 'take_profit'
          | 'stop_loss' =
          tpHit
            ? 'take_profit'
            : 'stop_loss';

        /*
         * Это не фактический fill защитного ордера:
         * пока используем последнюю mark price. Если mark
         * недоступна — entryPrice, чтобы очистить локальный
         * слот и не заблокировать лимит из 3 позиций.
         */
        const closePrice =
          markPrice != null &&
          Number.isFinite(markPrice) &&
          markPrice > 0
            ? markPrice
            : local.entryPrice;

        console.log(
          `[${new Date().toISOString()}] ` +
          `[SCHEDULER] RECONCILE POSITION_MISSING ` +
          `symbol=${symbol} ` +
          `marketId=${local.marketId ?? 'unknown'} ` +
          `reason=${closeReason} ` +
          `closePrice=${formatPrice(closePrice)} ` +
          `tp=${formatPrice(local.takeProfitPrice)} ` +
          `sl=${formatPrice(local.stopLossPrice)}`
        );

        const closeResult =
          closePosition(
            local.id,
            closePrice,
            closeReason,
            {
              executionOrderId:
                'exchange-auto-close',
              clientOrderId:
                `${symbol}-${Date.now()}-` +
                `reconcile-${closeReason}`,
              fee: 0
            }
          );

        if (!closeResult.ok) {
          console.error(
            `[${new Date().toISOString()}] ` +
            `[SCHEDULER] RECONCILE ` +
            `LOCAL_CLOSE_FAILED ` +
            `symbol=${symbol} ` +
            `error=${closeResult.message}`
          );

          markReconciliationPending(symbol);
        } else {
          console.log(
            `[${new Date().toISOString()}] ` +
            `[SCHEDULER] RECONCILE ` +
            `LOCAL_CLOSE_OK ` +
            `symbol=${symbol} ` +
            `reason=${closeReason}`
          );

          unlockSymbol(symbol);
        }

        continue;
      }

      /*
       * В LighterPosition нет поля `size` в текущем типе.
       * Поэтому не читаем remote.size и не делаем ложную
       * проверку количества. Факт наличия позиции подтверждён.
       */
      console.log(
        `[${new Date().toISOString()}] ` +
        `[SCHEDULER] RECONCILE POSITION_PRESENT ` +
        `symbol=${symbol} ` +
        `marketId=${remote.marketId}`
      );
    }

    const localByMarketId =
      new Map(
        localPositions
          .filter(
            position =>
              position.marketId != null
          )
          .map(position => [
            position.marketId as number,
            position
          ])
      );

    const localBySymbol =
      new Map(
        localPositions.map(position => [
          normalizeSymbol(position.symbol),
          position
        ])
      );

    for (const remote of remotePositions) {
      const hasLocal =
        localByMarketId.has(
          remote.marketId
        ) ||
        localBySymbol.has(
          normalizeSymbol(remote.symbol)
        );

      if (!hasLocal) {
        console.warn(
          `[${new Date().toISOString()}] ` +
          `[SCHEDULER] RECONCILE ORPHAN_POSITION ` +
          `symbol=${remote.symbol} ` +
          `marketId=${remote.marketId}`
        );

        markReconciliationPending(
          remote.symbol
        );
      }
    }
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] ` +
      `[SCHEDULER] RECONCILE ERROR:`,
      error
    );
  }
}

async function checkPositions(): Promise<void> {
  if (positionCheckRunning) {
    console.log(
      `[${new Date().toISOString()}] ` +
      `[SCHEDULER] checkPositions SKIP already running`
    );

    return;
  }

  positionCheckRunning = true;

  try {
    const snapshot =
      getPositions();

    console.log(
      `[${new Date().toISOString()}] ` +
      `[SCHEDULER] checkPositions START ` +
      `positionsCount=${snapshot.length}`
    );

    await reconcileLocalPositionsWithExchange(
      snapshot
    );

    const currentPositions =
      getPositions();

    for (
      const snapshotPosition of currentPositions
    ) {
      const position =
        getPositions().find(
          item =>
            item.id === snapshotPosition.id
        );

      if (
        !position ||
        isReconciliationPending(position.symbol)
      ) {
        console.log(
          `[${new Date().toISOString()}] ` +
          `[SCHEDULER] checkPositions SKIP ` +
          `symbol=${position?.symbol ?? 'unknown'} ` +
          `reason=${position
            ? 'reconciliation-pending'
            : 'not-found'}`
        );

        continue;
      }

      const symbol =
        normalizeSymbol(position.symbol);

      try {
        const markPrice =
          getMarkPrice(symbol);

        if (
          markPrice == null ||
          !Number.isFinite(markPrice) ||
          markPrice <= 0
        ) {
          throw new Error(
            `Mark price unavailable for ${symbol}`
          );
        }

        const pnl =
          position.side === 'long'
            ? (
              markPrice -
              position.entryPrice
            ) * position.quantity
            : (
              position.entryPrice -
              markPrice
            ) * position.quantity;

        const pnlPercent =
          position.notional > 0
            ? pnl /
              position.notional *
              100
            : 0;

        const previousMax =
          position.metadata?.maxUnrealizedPnL ??
          Number.NEGATIVE_INFINITY;

        const previousMaxPercent =
          position.metadata
            ?.maxUnrealizedPnLPercent ??
          Number.NEGATIVE_INFINITY;

        const maxPnl =
          Math.max(
            previousMax,
            pnl
          );

        const maxPnlPercent =
          Math.max(
            previousMaxPercent,
            pnlPercent
          );

        updatePositionMetadata(position.id, {
          maxUnrealizedPnL: maxPnl,
          maxUnrealizedPnLPercent:
            maxPnlPercent,
          worstUnrealizedPnL:
            Math.min(
              position.metadata
                ?.worstUnrealizedPnL ??
                Infinity,
              pnl
            ),
          worstUnrealizedPnLPercent:
            Math.min(
              position.metadata
                ?.worstUnrealizedPnLPercent ??
                Infinity,
              pnlPercent
            )
        });

        /*
         * Никаких локальных закрытий, BE, trailing,
         * dead trade или time stop здесь нет.
         * Реальное закрытие выполняется только биржевыми
         * защитными ордерами SL/TP.
         */
        const tpHit =
          position.side === 'long'
            ? markPrice >=
              position.takeProfitPrice
            : markPrice <=
              position.takeProfitPrice;

        const slHit =
          position.side === 'long'
            ? markPrice <=
              position.stopLossPrice
            : markPrice >=
              position.stopLossPrice;

        if (tpHit) {
          console.log(
            `[${new Date().toISOString()}] ` +
            `[SCHEDULER] checkPositions TP_HIT ` +
            `(mark price) ` +
            `symbol=${symbol} ` +
            `pnl=${pnl.toFixed(2)}`
          );
        }

        if (slHit) {
          console.log(
            `[${new Date().toISOString()}] ` +
            `[SCHEDULER] checkPositions SL_HIT ` +
            `(mark price) ` +
            `symbol=${symbol} ` +
            `pnl=${pnl.toFixed(2)}`
          );
        }

        logPositionCheck({
          timestamp: new Date().toISOString(),
          positionId: position.id,
          symbol,
          side: position.side,
          entryPrice: position.entryPrice,
          currentPrice: markPrice,
          takeProfitPrice:
            position.takeProfitPrice,
          stopLossPrice:
            position.stopLossPrice,
          unrealizedPnL: pnl,
          unrealizedPnLPercent:
            pnlPercent,
          distanceToTP:
            Math.abs(
              position.takeProfitPrice -
              markPrice
            ),
          distanceToTPPercent:
            Math.abs(
              position.takeProfitPrice -
              markPrice
            ) / markPrice * 100,
          distanceToSL:
            Math.abs(
              position.stopLossPrice -
              markPrice
            ),
          distanceToSLPercent:
            Math.abs(
              position.stopLossPrice -
              markPrice
            ) / markPrice * 100,
          hitTakeProfit: tpHit,
          hitStopLoss: slHit,
          action: 'hold',
          positionAgeSeconds:
            Math.max(
              0,
              Math.floor(
                (
                  Date.now() -
                  new Date(
                    position.openedAt
                  ).getTime()
                ) / 1000
              )
            )
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Unknown error';

        console.error(
          `[${new Date().toISOString()}] ` +
          `[SCHEDULER] checkPositions ERROR ` +
          `symbol=${symbol} ` +
          `error=${message}`
        );

        notifyError({
          context: 'position-check',
          symbol,
          error: message
        });
      }
    }

    console.log(
      `[${new Date().toISOString()}] ` +
      `[SCHEDULER] checkPositions END`
    );
  } finally {
    positionCheckRunning = false;
  }
}

export async function startScheduler(): Promise<void> {
  if (schedulerStarted) {
    console.warn(
      `[${new Date().toISOString()}] ` +
      `[SCHEDULER] startScheduler SKIP already started`
    );

    return;
  }

  console.log(
    `[${new Date().toISOString()}] ` +
    `[SCHEDULER] startScheduler START`
  );

  schedulerStarted = true;
  schedulerStopping = false;

  try {
    executionService =
      createExecutionService();

    initializeSignerClient();

    await refreshTopMarkets();
    await loadReconciliationPendingSymbols();

    if (!PAPER_TRADING && signerClient) {
      const accountIndex =
        Number(
          process.env.LIGHTER_ACCOUNT_INDEX ??
          0
        );

      await syncLiveBalance(
        signerClient,
        accountIndex
      );

      const restore =
        await restoreStateAfterRestart(
          signerClient,
          accountIndex
        );

      if (restore.errors > 0) {
        notifyError({
          context: 'reconciliation',
          error:
            `State reconciliation completed with ` +
            `${restore.errors} errors`
        });
      }

      startReconciliationLoop(
        signerClient,
        accountIndex
      );

      startBalanceSyncLoop(accountIndex);
    }

    startMarketRefresh();

    /*
     * Сначала сверяем позиции с биржей, чтобы освободить
     * закрытые биржевым TP/SL слоты, затем ищем новые входы.
     */
    await checkPositions();
    await checkSignals();

    signalCheckInterval =
      setInterval(() => {
        void checkSignals().catch(console.error);
      }, SIGNAL_CHECK_INTERVAL_MS);

    positionCheckInterval =
      setInterval(() => {
        void checkPositions().catch(console.error);
      }, POSITION_CHECK_INTERVAL_MS);

    notifyStartup({
      port:
        Number(process.env.PORT) ||
        3006,
      tradingPairs:
        getActiveTradingPairs(),
      signalInterval:
        SIGNAL_CHECK_INTERVAL_MS / 1000,
      positionInterval:
        POSITION_CHECK_INTERVAL_MS / 1000,
      balance: getBalance()
    });

    console.log(
      `[${new Date().toISOString()}] ` +
      `[SCHEDULER] startScheduler OK`
    );
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] ` +
      `[SCHEDULER] startScheduler ERROR:`,
      error
    );

    schedulerStarted = false;

    stopMarketRefresh();
    stopReconciliationLoop();
    stopBalanceSyncLoop();

    executionService?.stop?.();

    throw error;
  }
}

export async function stopScheduler(): Promise<void> {
  console.log(
    `[${new Date().toISOString()}] ` +
    `[SCHEDULER] stopScheduler START`
  );

  stopReconciliationLoop();
  stopBalanceSyncLoop();
  stopMarketRefresh();

  if (signalCheckInterval) {
    clearInterval(signalCheckInterval);
  }

  if (positionCheckInterval) {
    clearInterval(positionCheckInterval);
  }

  signalCheckInterval = null;
  positionCheckInterval = null;

  executionService?.stop?.();

  if (!schedulerStopping) {
    schedulerStopping = true;

    const symbols =
      new Set([
        ...getPositions().map(
          position =>
            normalizeSymbol(position.symbol)
        ),
        ...getActiveTradingPairs().map(
          normalizeSymbol
        )
      ]);

    for (const symbol of symbols) {
      try {
        stopMarketData(symbol);
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] ` +
          `Failed to stop market data ` +
          `for ${symbol}:`,
          error
        );
      }
    }
  }

  await flushPositionPersistence().catch(
    error => {
      console.error(
        `[${new Date().toISOString()}] ` +
        `Failed to flush persistence:`,
        error
      );
    }
  );

  schedulerStarted = false;

  console.log(
    `[${new Date().toISOString()}] ` +
    `[SCHEDULER] stopScheduler OK`
  );
}
