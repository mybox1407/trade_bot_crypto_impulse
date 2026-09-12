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
  VirtualPosition
} from './positionState';

import {
  TRADE_FEE_RATE
} from './strategy';

import {
  logPositionCheck,
  logError
} from './logger';

import {
  notifyStartup,
  notifyError
} from './telegram';

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

import {
  SignerClient
} from 'zklighter-sdk';

import {
  restoreStateAfterRestart,
  reconcileAccount,
  fetchAccountPositions,
  verifyPositionAfterFill,
  LighterPosition,
  syncLiveBalance
} from './reconciliation';

const PAPER_TRADING =
  process.env.PAPER_TRADING !== 'false';

const LIGHTER_API_URL =
  process.env.LIGHTER_API_URL ??
  'https://mainnet.zklighter.elliot.ai';

let executionService: ExecutionService;

let signerClient: SignerClient | null = null;

let reconciliationInterval:
  NodeJS.Timeout | null = null;

let balanceSyncInterval:
  NodeJS.Timeout | null = null;

function createExecutionService(): ExecutionService {
  if (PAPER_TRADING) {
    console.log(
      `[${new Date().toISOString()}] ` +
        `Paper execution enabled`
    );

    return new PaperExecutionService();
  }

  const apiKeySecret =
    process.env.LIGHTER_API_SECRET ?? '';

  const apiKeyIndex =
    Number(
      process.env.LIGHTER_API_KEY_INDEX ?? 0
    );

  const accountIndex =
    Number(
      process.env.LIGHTER_ACCOUNT_INDEX ?? 0
    );

  if (!apiKeySecret) {
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

  console.log(
    `[${new Date().toISOString()}] ` +
      `Live execution enabled`
  );

  return new LighterExecutionService(
    apiKeySecret,
    apiKeyIndex,
    accountIndex
  );
}

function initializeSignerClient(): void {
  if (PAPER_TRADING) {
    console.log(
      `[${new Date().toISOString()}] ` +
        `Paper trading enabled; signer ` +
        `initialization skipped`
    );

    signerClient = null;

    return;
  }

  const apiKeySecret =
    process.env.LIGHTER_API_SECRET ?? '';

  const apiKeyIndex =
    Number(
      process.env.LIGHTER_API_KEY_INDEX ?? 0
    );

  const accountIndex =
    Number(
      process.env.LIGHTER_ACCOUNT_INDEX ?? 0
    );

  if (!apiKeySecret) {
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

  const normalizedKey =
    apiKeySecret.startsWith('0x')
      ? apiKeySecret.slice(2)
      : apiKeySecret;

  signerClient = new SignerClient(
    LIGHTER_API_URL,
    normalizedKey,
    apiKeyIndex,
    accountIndex
  );

  console.log(
    `[${new Date().toISOString()}] ` +
      `SignerClient initialized for reconciliation`
  );
}

function startReconciliationLoop(
  client: SignerClient,
  accountIndex: number,
  intervalMs: number
): void {
  reconciliationInterval =
    setInterval(() => {
      void reconcileAccountPeriodic(
        client,
        accountIndex
      );
    }, intervalMs);
}

async function reconcileAccountPeriodic(
  client: SignerClient,
  accountIndex: number
): Promise<void> {
  try {
    const result =
      await reconcileAccount(
        client,
        accountIndex,
        {
          autoFix: false,
          dryRun: true
        }
      );

    if (result.error) {
      console.error(
        `[${new Date().toISOString()}] ` +
          `Periodic reconciliation API error: ` +
          `${result.error}`
      );

      notifyError({
        context: 'reconciliation-periodic',
        error: result.error
      });

      return;
    }

    if (!result.ok) {
      console.warn(
        `[${new Date().toISOString()}] ` +
          `Reconciliation check: ` +
          `${result.mismatches.length} ` +
          `mismatches detected`
      );

      notifyError({
        context: 'reconciliation-periodic',
        error:
          `${result.mismatches.length} ` +
          `position mismatches detected`
      });
    }
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] ` +
        `Reconciliation check error:`,
      error
    );
  }
}

function stopReconciliationLoop(): void {
  if (reconciliationInterval) {
    clearInterval(reconciliationInterval);
    reconciliationInterval = null;
  }
}

function startBalanceSyncLoop(
  accountIndex: number,
  intervalMs: number
): void {
  balanceSyncInterval =
    setInterval(() => {
      void syncLiveBalance(accountIndex).catch(error => {
        console.error(
          `[${new Date().toISOString()}] ` +
            `Failed to sync live balance:`,
          error
        );
      });
    }, intervalMs);
}

function stopBalanceSyncLoop(): void {
  if (balanceSyncInterval) {
    clearInterval(balanceSyncInterval);
    balanceSyncInterval = null;
  }
}

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

let signalCheckInterval:
  NodeJS.Timeout | null = null;

let positionCheckInterval:
  NodeJS.Timeout | null = null;

let signalCheckRunning = false;
let positionCheckRunning = false;
let schedulerStopping = false;
let schedulerStarted = false;
let schedulerFatalError: string | null = null;

// Блокировка символов при UNKNOWN
const symbolLocks = new Map<string, number>();

function isSymbolLocked(symbol: string): boolean {
  const unlockAt = symbolLocks.get(normalizeSymbol(symbol));
  if (!unlockAt) {
    return false;
  }
  if (Date.now() >= unlockAt) {
    symbolLocks.delete(normalizeSymbol(symbol));
    return false;
  }
  return true;
}

function lockSymbol(symbol: string, durationMs: number = 5 * 60_000) {
  const normalized = normalizeSymbol(symbol);
  symbolLocks.set(normalized, Date.now() + durationMs);
}

function formatPrice(price: number): string {
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

function markFatalError(
  message: string
): void {
  schedulerFatalError = message;

  console.error(
    `[${new Date().toISOString()}] ` +
      `FATAL SCHEDULER STATE ERROR: ${message}`
  );
}

function ensureSchedulerHealthy(): void {
  if (schedulerFatalError) {
    throw new Error(
      `Scheduler is blocked after fatal state error: ` +
        `${schedulerFatalError}`
    );
  }
}

function formatOpenPositionsForTelegram(): string {
  const positions = getPositions();

  if (positions.length === 0) {
    return 'No open positions';
  }

  return positions
    .map(position => {
      const sideEmoji =
        position.side === 'long'
          ? '🟢'
          : '🔴';

      return (
        `${sideEmoji} ${position.symbol} ` +
        `${position.side.toUpperCase()} | ` +
        `Entry: ${formatPrice(position.entryPrice)} | ` +
        `TP: ${formatPrice(position.takeProfitPrice)} | ` +
        `SL: ${formatPrice(position.stopLossPrice)} | ` +
        `Notional: ${position.notional.toFixed(2)}`
      );
    })
    .join('\n');
}

async function sendTelegramSummary(
  signalResults: SignalResult[]
): Promise<void> {
  const activeResults =
    signalResults.filter(
      result =>
        result.status === 'signal' ||
        result.status === 'no-signal' ||
        result.status === 'not-ready' ||
        result.status === 'error'
    );

  const signalsCount =
    signalResults.filter(
      result => result.status === 'signal'
    ).length;

  const noSignalCount =
    signalResults.filter(
      result =>
        result.status === 'no-signal' ||
        result.status === 'not-ready'
    ).length;

  const openPositionsCount =
    getOpenPositionsCount();

  const errorCount =
    signalResults.filter(
      result => result.status === 'error'
    ).length;

  const signalText =
    activeResults.length > 0
      ? activeResults
          .map(result => {
            if (result.status === 'error') {
              return (
                `❌ ${result.symbol}: ERROR - ` +
                `${result.reason}`
              );
            }

            if (result.status === 'not-ready') {
              return (
                `⏳ ${result.symbol}: NOT READY - ` +
                `${result.reason}`
              );
            }

            if (result.status === 'signal') {
              const emoji =
                result.side === 'long'
                  ? '🟢'
                  : '🔴';

              const side =
                result.side?.toUpperCase() ??
                'SIGNAL';

              const price =
                result.price != null
                  ? `@ ${formatPrice(result.price)}`
                  : '';

              return (
                `${emoji} ${result.symbol} ` +
                `[${result.regime}]: ${side} ` +
                `${price} - ${result.reason}`
              );
            }

            return (
              `${result.symbol} ` +
              `[${result.regime}]: No signal - ` +
              `${result.reason}`
            );
          })
          .join('\n')
      : 'No free symbols to analyze';

  const summaryMessage =
    `📊 Signal Check Summary\n\n` +
    `📈 Open positions: ` +
    `${openPositionsCount}/${MAX_PARALLEL_POSITIONS}\n` +
    `${formatOpenPositionsForTelegram()}\n\n` +
    `💰 Equity: ${getBalance().toFixed(2)}\n` +
    `🔒 Reserved: ${getReservedCapital().toFixed(2)}\n` +
    `💵 Available: ${getAvailableBalance().toFixed(2)}\n\n` +
    `🔍 Signal scan:\n${signalText}\n\n` +
    `📊 Signals: ${signalsCount} | ` +
    `No signals: ${noSignalCount}\n` +
    `📈 Open: ${openPositionsCount}/` +
    `${MAX_PARALLEL_POSITIONS}\n` +
    `⚠️ Errors: ${errorCount}\n\n` +
    `${new Date().toISOString()}`;

  if (
    signalsCount === 0 &&
    errorCount === 0 &&
    activeResults.length === 0
  ) {
    return;
  }

  try {
    const telegramToken =
      process.env.TELEGRAM_BOT_TOKEN;

    const telegramChatId =
      process.env.TELEGRAM_CHAT_ID;

    if (
      !telegramToken ||
      !telegramChatId
    ) {
      return;
    }

    const url =
      `https://api.telegram.org/bot` +
      `${telegramToken}/sendMessage`;

    await axios.post(
      url,
      {
        chat_id: telegramChatId,
        text: summaryMessage
      },
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] ` +
        `Failed to send summary:`,
      error instanceof Error
        ? error.message
        : 'Unknown'
    );
  }
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

async function checkSignals(): Promise<void> {
  if (signalCheckRunning) {
    return;
  }

  ensureSchedulerHealthy();

  signalCheckRunning = true;

  try {
    const activeTradingPairs =
      getActiveTradingPairs();

    const signalResults: SignalResult[] = [];

    for (
      const rawSymbol
      of activeTradingPairs
    ) {
      const symbol =
        normalizeSymbol(rawSymbol);

      try {
        ensureSchedulerHealthy();

        // Пропускаем заблокированные символы
        if (isSymbolLocked(symbol)) {
          signalResults.push({
            symbol,
            status: 'no-signal',
            regime: 'locked',
            hasSignal: false,
            reason: 'Symbol temporarily locked after unknown execution'
          });
          continue;
        }

        if (hasOpenPosition(symbol)) {
          signalResults.push({
            symbol,
            status: 'position-open',
            regime: 'position-open',
            hasSignal: false,
            reason: 'Open position exists'
          });

          continue;
        }

        if (
          getOpenPositionsCount() >=
          MAX_PARALLEL_POSITIONS
        ) {
          signalResults.push({
            symbol,
            status: 'max-positions',
            regime: 'max-positions',
            hasSignal: false,
            reason:
              `Max positions reached: ` +
              `${MAX_PARALLEL_POSITIONS}`
          });

          continue;
        }

        const result =
          await runBotOnce(symbol, '15m');

        if (!result.ready) {
          signalResults.push({
            symbol,
            status: 'not-ready',
            regime: 'unknown',
            hasSignal: false,
            reason:
              result.reason ??
              'Strategy result is not ready'
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
          (result as any).takeProfitPrice as
            | number
            | null;

        const stopLossPrice =
          (result as any).stopLossPrice as
            | number
            | null;

        const regime =
          (result as any).regime as string;

        const indicators =
          (result as any).indicators as any;

        const skipReason =
          (result as any).skipReason as
            | string
            | null;

        if (skipReason) {
          signalResults.push({
            symbol,
            status: 'no-signal',
            regime,
            hasSignal: false,
            reason: skipReason
          });

          continue;
        }

        if (!buy && !sell) {
          signalResults.push({
            symbol,
            status: 'no-signal',
            regime,
            hasSignal: false,
            reason: 'No signal'
          });

          continue;
        }

        if (
          side !== 'long' &&
          side !== 'short'
        ) {
          signalResults.push({
            symbol,
            status: 'signal',
            regime,
            hasSignal: true,
            side: 'none',
            price,
            reason: 'Signal side is invalid'
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

        const marketRef =
          resolveMarket(symbol);

        const marketId =
          requireMarketId(
            marketRef.marketId,
            `open ${symbol}`
          );

        const activeMarket =
          getActiveMarket(symbol);

        if (!activeMarket) {
          throw new Error(
            `Active market metadata not found: ${symbol}`
          );
        }

        const priceDecimals =
          activeMarket.priceDecimals;

        const sizeDecimals =
          activeMarket.sizeDecimals;

        const stopDistance =
          Math.abs(
            expectedPrice -
              stopLossPrice
          );

        const worstCaseFeePerUnit =
          stopDistance *
          TRADE_FEE_RATE;

        const totalRiskPerUnit =
          stopDistance +
          worstCaseFeePerUnit;

        if (
          !Number.isFinite(
            totalRiskPerUnit
          ) ||
          totalRiskPerUnit <= 0
        ) {
          throw new Error(
            `Invalid total risk per unit: ` +
              `${totalRiskPerUnit}`
          );
        }

        const riskCapital =
          getRiskCapital();

        const maxNotionalByPercent =
          getPositionNotional();

        const calculatedQuantity =
          riskCapital /
          totalRiskPerUnit;

        const maxQuantityByPercent =
          maxNotionalByPercent /
          expectedPrice;

        const rawQuantity =
          validateQuantity(
            Math.min(
              calculatedQuantity,
              maxQuantityByPercent
            )
          );

        const quantityFactor =
          10 ** sizeDecimals;

        const quantity =
          validateQuantity(
            Math.floor(
              rawQuantity *
                quantityFactor
            ) /
            quantityFactor
          );

        const clientOrderId =
          `${symbol}-${Date.now()}-open`;

        const executionResult =
          await executionService.openPosition({
            symbol,
            marketId,
            side,
            quantity,
            expectedPrice,
            clientOrderId,
            priceDecimals,
            sizeDecimals,
            stopLossPrice,
            takeProfitPrice
          });

        if (!executionResult.ok) {
          if (executionResult.status === 'unknown') {
            lockSymbol(symbol, 5 * 60_000);
        
            notifyError({
              context: 'signal-check',
              symbol,
              error:
                `Execution outcome unknown for ${symbol}. ` +
                `Symbol locked for 5 minutes. No new orders.`
            });
          } else if (executionResult.status === 'rejected') {
            // Ордер отменён (например, из-за slippage) - просто логируем
            console.log(
              `[${new Date().toISOString()}] ` +
                `[SCHEDULER] Order rejected for ${symbol}: ${executionResult.message}`
            );
        
            // Можно отправить уведомление, но не как ошибку, а как инфо
            // notifyError({
            //   context: 'signal-check',
            //   symbol,
            //   error: `Order rejected for ${symbol}: ${executionResult.message}`
            // });
          }
        
          signalResults.push({
            symbol,
            status: 'signal',
            regime,
            hasSignal: true,
            side,
            price: expectedPrice,
            reason: executionResult.message ?? 'Execution failed'
          });
        
          continue;
        }

        if (
          executionResult.filledQuantity <= 0 ||
          executionResult.averageFillPrice == null
        ) {
          throw new Error(
            `Execution returned no confirmed fill for ${symbol}`
          );
        }

        if (
          !PAPER_TRADING &&
          !executionResult.protectiveOrders
        ) {
          // Критично: позиция открылась без SL/TP на бирже
          logError({
            timestamp: new Date().toISOString(),
            context: 'signal-check',
            symbol,
            error:
              `Live execution returned no protective SL/TP orders for ${symbol}. ` +
              `Position opened without exchange protection.`
          });

          notifyError({
            context: 'signal-check',
            symbol,
            error:
              `Position ${symbol} opened without SL/TP on exchange. ` +
              `Manual protection required.`
          });
        }

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
                indicators?.macdCrossUp ??
                false,
              macdCrossDown:
                indicators?.macdCrossDown ??
                false,
              lastRsi:
                indicators?.lastRsi ?? 0,
              lastAtr:
                indicators?.lastAtr ?? 0,
              adx:
                indicators?.regimeIndicators?.adx ??
                0,
              bbWidth:
                indicators?.regimeIndicators?.bbWidth ??
                0,
              atrPct:
                indicators?.regimeIndicators?.atrPct ??
                0,
              ema20:
                indicators?.regimeIndicators?.ema20 ??
                0,
              ema50:
                indicators?.regimeIndicators?.ema50 ??
                0,
              ema200:
                indicators?.regimeIndicators?.ema200 ??
                0,
              entryExtensionAtr:
                indicators?.entryExtensionAtr ??
                0,
              maxEntryExtensionAtr:
                indicators?.maxEntryExtensionAtr ??
                0,
              entryTooExtended:
                indicators?.entryTooExtended ??
                false
            },
            executionOrderId:
              executionResult.orderId,
            clientOrderId
          });

        if (!openResult.ok) {
          if (
            !PAPER_TRADING &&
            signerClient
          ) {
            const accountIndex =
              Number(
                process.env.LIGHTER_ACCOUNT_INDEX ??
                  0
              );

            const verification =
              await verifyPositionAfterFill(
                signerClient,
                accountIndex,
                symbol,
                side,
                executionResult.filledQuantity
              );

            if (!verification.ok) {
              markFatalError(
                `${symbol}: execution fill confirmed but ` +
                  `local position state failed AND ` +
                  `reconciliation verification failed: ` +
                  `${verification.mismatch}`
              );
            } else {
              notifyError({
                context: 'signal-check',
                symbol,
                error:
                  `Execution filled but local state failed. ` +
                  `Position exists on exchange, ` +
                  `manual reconciliation required.`
              });
            }
          } else {
            markFatalError(
              `${symbol}: execution fill confirmed but ` +
                `local position state failed: ` +
                `${openResult.message ?? 'unknown error'}`
            );
          }

          signalResults.push({
            symbol,
            status: 'error',
            regime,
            hasSignal: true,
            side,
            price: expectedPrice,
            reason:
              'Execution filled but local position state failed'
          });

          continue;
        }

        if (
          !PAPER_TRADING &&
          signerClient
        ) {
          const accountIndex =
            Number(
              process.env.LIGHTER_ACCOUNT_INDEX ??
                0
            );

          const verification =
            await verifyPositionAfterFill(
              signerClient,
              accountIndex,
              symbol,
              side,
              executionResult.filledQuantity
            );

          if (!verification.ok) {
            markFatalError(
              `${symbol}: position verification failed ` +
                `after successful open: ` +
                `${verification.mismatch}`
            );

            notifyError({
              context: 'signal-check',
              symbol,
              error:
                `Position verification failed: ` +
                `${verification.mismatch}`
            });
          } else {
            console.log(
              `[${new Date().toISOString()}] ` +
                `${symbol}: position verified on ` +
                `exchange successfully`
            );
          }

          await syncLiveBalance(accountIndex).catch(error => {
            console.error(
              `[${new Date().toISOString()}] ` +
                `Failed to sync balance after open:`,
              error
            );
          });
        } else if (PAPER_TRADING) {
          console.log(
            `[${new Date().toISOString()}] ` +
              `${symbol}: paper trade; ` +
              `exchange verification skipped`
          );
        }

        signalResults.push({
          symbol,
          status: 'signal',
          regime,
          hasSignal: true,
          side,
          price: expectedPrice,
          reason: 'Position opened'
        });
      } catch (error) {
        const errorMsg =
          error instanceof Error
            ? error.message
            : 'Unknown error';

        logError({
          timestamp: new Date().toISOString(),
          context: 'signal-check',
          symbol,
          error: errorMsg
        });

        notifyError({
          context: 'signal-check',
          symbol,
          error: errorMsg
        });

        signalResults.push({
          symbol,
          status: 'error',
          regime: 'error',
          hasSignal: false,
          reason: errorMsg
        });
      }
    }

    await sendTelegramSummary(
      signalResults
    );
  } finally {
    signalCheckRunning = false;
  }
}

async function executeClose(
  position: ReturnType<
    typeof getPositions
  >[number],
  currentPrice: number,
  reason:
    | 'take_profit'
    | 'stop_loss'
    | 'time_stop'
    | 'breakeven_stop'
    | 'dead_trade_mfe'
): Promise<boolean> {
  const marketId =
    requireMarketId(
      position.marketId,
      `close ${position.symbol}`
    );

  const activeMarket =
    getActiveMarket(position.symbol);

  if (!activeMarket) {
    throw new Error(
      `Active market metadata not found: ` +
        `${position.symbol}`
    );
  }

  const clientOrderId =
    `${position.symbol}-${Date.now()}-${reason}`;

  const executionResult =
    await executionService.closePosition({
      symbol: position.symbol,
      marketId,
      positionSide: position.side,
      quantity: position.quantity,
      expectedPrice: currentPrice,
      reason,
      clientOrderId,
      priceDecimals:
        activeMarket.priceDecimals,
      sizeDecimals:
        activeMarket.sizeDecimals
    });

  if (!executionResult.ok) {
    throw new Error(
      `Close execution failed for ` +
        `${position.symbol}: ` +
        `${executionResult.message ?? 'unknown error'}`
    );
  }

  if (
    executionResult.filledQuantity <= 0 ||
    executionResult.averageFillPrice == null
  ) {
    throw new Error(
      `Close execution returned no confirmed fill for ` +
        `${position.symbol}`
    );
  }

  if (
    executionResult.filledQuantity >
    position.quantity * 1.000001
  ) {
    throw new Error(
      `Close fill exceeds local position quantity for ` +
        `${position.symbol}: filled=` +
        `${executionResult.filledQuantity}, ` +
        `local=${position.quantity}`
    );
  }

  if (
    executionResult.filledQuantity <
    position.quantity * 0.999999
  ) {
    const partialResult =
      partialClosePosition(
        position.id,
        executionResult.filledQuantity,
        executionResult.averageFillPrice,
        {
          executionOrderId:
            executionResult.orderId,
          clientOrderId,
          fee: executionResult.fee
        }
      );

    if (!partialResult.ok) {
      markFatalError(
        `${position.symbol}: partial close fill confirmed ` +
          `but local state failed: ` +
          `${partialResult.message}`
      );

      throw new Error(
        `Partial close state update failed for ` +
          `${position.symbol}: ` +
          `${partialResult.message}`
      );
    }

    if (!PAPER_TRADING && signerClient) {
      const accountIndex =
        Number(
          process.env.LIGHTER_ACCOUNT_INDEX ?? 0
        );

      await syncLiveBalance(accountIndex).catch(error => {
        console.error(
          `[${new Date().toISOString()}] ` +
            `Failed to sync balance after partial close:`,
          error
        );
      });
    }

    return true;
  }

  // Отменяем SL/TP только если они есть
  if (
    executionService.cancelProtectiveOrders &&
    position.marketId != null &&
    (
      position.exchangeStopLossOrderId ||
      position.exchangeTakeProfitOrderId
    )
  ) {
    await executionService.cancelProtectiveOrders({
      marketId: position.marketId,
      stopLossOrderId:
        position.exchangeStopLossOrderId,
      takeProfitOrderId:
        position.exchangeTakeProfitOrderId,
      stopLossClientOrderIndex:
        position.exchangeStopLossClientOrderIndex ??
        0,
      takeProfitClientOrderIndex:
        position.exchangeTakeProfitClientOrderIndex ??
        0
    });
  }

  const result =
    closePosition(
      position.id,
      executionResult.averageFillPrice,
      reason,
      {
        executionOrderId:
          executionResult.orderId,
        clientOrderId,
        fee: executionResult.fee
      }
    );

  if (!result.ok) {
    markFatalError(
      `${position.symbol}: close fill confirmed but ` +
        `local close state failed: ${result.message}`
    );

    throw new Error(
      `Close state update failed for ` +
        `${position.symbol}: ` +
        `${result.message}`
    );
  }

  if (!PAPER_TRADING && signerClient) {
    const accountIndex =
      Number(
        process.env.LIGHTER_ACCOUNT_INDEX ?? 0
      );

    await syncLiveBalance(accountIndex).catch(error => {
      console.error(
        `[${new Date().toISOString()}] ` +
          `Failed to sync balance after close:`,
        error
      );
    });
  }

  return true;
}

async function verifyRemotePositionClosed(
  symbol: string
): Promise<void> {
  if (
    PAPER_TRADING ||
    !signerClient
  ) {
    return;
  }

  const accountIndex =
    Number(
      process.env.LIGHTER_ACCOUNT_INDEX ?? 0
    );

  const remotePositions =
    await fetchAccountPositions(
      signerClient,
      accountIndex
    );

  const remote =
    remotePositions.find(
      (position: LighterPosition) =>
        normalizeSymbol(position.symbol) ===
        normalizeSymbol(symbol)
    );

  if (remote) {
    notifyError({
      context:
        'position-close-verification',
      symbol,
      error:
        `Position ${symbol} still exists ` +
        `on exchange after close`
    });
  }
}

async function checkPositions(): Promise<void> {
  if (positionCheckRunning) {
    return;
  }

  ensureSchedulerHealthy();

  positionCheckRunning = true;

  try {
    const positions = getPositions();

    if (positions.length === 0) {
      return;
    }

    for (
      const snapshotPosition
      of positions
    ) {
      try {
        ensureSchedulerHealthy();

        const position =
          getPositions().find(
            item =>
              item.id === snapshotPosition.id
          );

        if (!position) {
          continue;
        }

        const symbol =
          normalizeSymbol(position.symbol);

        if (!hasOpenPosition(symbol)) {
          continue;
        }

        const markPrice =
          getMarkPrice(symbol);

        const exitPrice =
          getExitPrice(
            symbol,
            position.side
          );

        if (
          markPrice == null ||
          !Number.isFinite(markPrice) ||
          markPrice <= 0
        ) {
          throw new Error(
            `Mark price unavailable for ${symbol}`
          );
        }

        if (
          exitPrice == null ||
          !Number.isFinite(exitPrice) ||
          exitPrice <= 0
        ) {
          throw new Error(
            `Exit price unavailable for ${symbol}`
          );
        }

        const unrealizedPnL =
          position.side === 'long'
            ? (
                markPrice -
                position.entryPrice
              ) * position.quantity
            : (
                position.entryPrice -
                markPrice
              ) * position.quantity;

        const unrealizedPnLPercent =
          position.notional > 0
            ? (
                unrealizedPnL /
                position.notional
              ) * 100
            : 0;

        const previousMaxPnL =
          position.metadata
            ?.maxUnrealizedPnL ??
          Number.NEGATIVE_INFINITY;

        const previousMaxPnLPercent =
          position.metadata
            ?.maxUnrealizedPnLPercent ??
          Number.NEGATIVE_INFINITY;

        const previousWorstPnL =
          position.metadata
            ?.worstUnrealizedPnL ??
          Number.POSITIVE_INFINITY;

        const previousWorstPnLPercent =
          position.metadata
            ?.worstUnrealizedPnLPercent ??
          Number.POSITIVE_INFINITY;

        const maxUnrealizedPnL =
          Math.max(
            previousMaxPnL,
            unrealizedPnL
          );

        const maxUnrealizedPnLPercent =
          Math.max(
            previousMaxPnLPercent,
            unrealizedPnLPercent
          );

        updatePositionMetadata(
          position.id,
          {
            maxUnrealizedPnL,
            maxUnrealizedPnLPercent,
            worstUnrealizedPnL:
              Math.min(
                previousWorstPnL,
                unrealizedPnL
              ),
            worstUnrealizedPnLPercent:
              Math.min(
                previousWorstPnLPercent,
                unrealizedPnLPercent
              )
          }
        );

        const openedAt =
          new Date(
            position.openedAt
          ).getTime();

        const positionAgeSeconds =
          Math.max(
            0,
            Math.floor(
              (
                Date.now() -
                openedAt
              ) / 1000
            )
          );

        const partialClosed =
          position.metadata
            ?.partialClosed ??
          false;

        const trailingActive =
          position.metadata
            ?.trailingActive ??
          false;

        const beTriggered =
          position.metadata
            ?.beTriggered ??
          false;

        if (
          !beTriggered &&
          maxUnrealizedPnLPercent >=
            BE_THRESHOLD_PERCENT
        ) {
          const lockedPercent =
            Math.max(
              MIN_LOCKED_PERCENT,
              (
                maxUnrealizedPnLPercent -
                BE_THRESHOLD_PERCENT
              ) * LOCK_RATIO
            );

          const ratchetStop =
            position.side === 'long'
              ? position.entryPrice *
                (1 + lockedPercent / 100)
              : position.entryPrice *
                (1 - lockedPercent / 100);

          const nextStop =
            position.side === 'long'
              ? Math.max(
                  position.stopLossPrice,
                  ratchetStop
                )
              : Math.min(
                  position.stopLossPrice,
                  ratchetStop
                );

          if (
            nextStop !==
            position.stopLossPrice
          ) {
            if (
              !updatePositionStopLoss(
                position.id,
                nextStop
              )
            ) {
              throw new Error(
                `Failed to update ratchet stop for ` +
                  `${position.id}`
              );
            }

            updatePositionMetadata(
              position.id,
              {
                beTriggered: true,
                trailingStopPrice: nextStop
              }
            );
          }
        }

        if (
          !partialClosed &&
          maxUnrealizedPnLPercent >=
            PARTIAL_THRESHOLD_PERCENT
        ) {
          const currentPosition =
            getPositions().find(
              item =>
                item.id === position.id
            );

          if (!currentPosition) {
            throw new Error(
              `Position disappeared before partial close: ` +
                `${symbol}`
            );
          }

          const closeQuantity =
            currentPosition.quantity * 0.5;

          const marketId =
            requireMarketId(
              currentPosition.marketId,
              `partial close ${symbol}`
            );

          const activeMarket =
            getActiveMarket(symbol);

          if (!activeMarket) {
            throw new Error(
              `Active market metadata not found: ${symbol}`
            );
          }

          const clientOrderId =
            `${symbol}-${Date.now()}-partial`;

          const partialExecution =
            await executionService.closePosition({
              symbol,
              marketId,
              positionSide:
                currentPosition.side,
              quantity: closeQuantity,
              expectedPrice: exitPrice,
              reason: 'partial_close',
              clientOrderId,
              priceDecimals:
                activeMarket.priceDecimals,
              sizeDecimals:
                activeMarket.sizeDecimals
            });

          if (!partialExecution.ok) {
            throw new Error(
              `Partial close failed for ${symbol}: ` +
                `${partialExecution.message ?? 'unknown error'}`
            );
          }

          if (
            partialExecution.filledQuantity <= 0 ||
            partialExecution.averageFillPrice ==
              null
          ) {
            throw new Error(
              `Partial close has no confirmed fill: ` +
                `${symbol}`
            );
          }

          if (
            partialExecution.filledQuantity >=
            currentPosition.quantity
          ) {
            throw new Error(
              `Partial close filled entire position unexpectedly: ` +
                `${symbol}`
            );
          }

          const partialResult =
            partialClosePosition(
              currentPosition.id,
              partialExecution.filledQuantity,
              partialExecution.averageFillPrice,
              {
                executionOrderId:
                  partialExecution.orderId,
                clientOrderId,
                fee: partialExecution.fee
              }
            );

          if (!partialResult.ok) {
            markFatalError(
              `${symbol}: partial close filled but ` +
                `local state failed: ` +
                `${partialResult.message}`
            );

            throw new Error(
              `Partial close state update failed for ` +
                `${symbol}: ` +
                `${partialResult.message}`
            );
          }

          if (!PAPER_TRADING && signerClient) {
            const accountIndex =
              Number(
                process.env.LIGHTER_ACCOUNT_INDEX ?? 0
              );

            await syncLiveBalance(accountIndex).catch(error => {
              console.error(
                `[${new Date().toISOString()}] ` +
                  `Failed to sync balance after partial close:`,
                error
              );
            });
          }

          const remainingPosition =
            getPositions().find(
              item =>
                item.id === currentPosition.id
            );

          if (!remainingPosition) {
            throw new Error(
              `Position ${currentPosition.id} not found after partial close`
            );
          }

          const trailDistance =
            exitPrice *
            (
              TRAILING_DISTANCE_PERCENT / 100
            );

          const proposedInitialTrail =
            remainingPosition.side === 'long'
              ? exitPrice - trailDistance
              : exitPrice + trailDistance;

          const initialTrailingStop =
            remainingPosition.side === 'long'
              ? Math.max(
                  remainingPosition.stopLossPrice,
                  proposedInitialTrail
                )
              : Math.min(
                  remainingPosition.stopLossPrice,
                  proposedInitialTrail
                );

          if (
            !updatePositionStopLoss(
              remainingPosition.id,
              initialTrailingStop
            )
          ) {
            throw new Error(
              `Failed to initialize trailing stop for ` +
                `${symbol}`
            );
          }

          updatePositionMetadata(
            remainingPosition.id,
            {
              partialClosed: true,
              trailingActive: true,
              trailingStopPrice:
                initialTrailingStop
            }
          );
        }

        const statePosition =
          getPositions().find(
            item =>
              item.id === position.id
          );

        if (!statePosition) {
          continue;
        }

        const currentStatePosition =
          statePosition;

        const activePartialClosed =
          currentStatePosition.metadata
            ?.partialClosed ??
          false;

        const activeTrailing =
          currentStatePosition.metadata
            ?.trailingActive ??
          false;

        const activeBeTriggered =
          currentStatePosition.metadata
            ?.beTriggered ??
          false;

        // DEAD_TRADE: закрываем только если позиция без partial и без BE
        if (
          DEAD_TRADE_ENABLED &&
          !activePartialClosed &&
          !activeBeTriggered &&
          positionAgeSeconds >=
            DEAD_TRADE_CHECK_AFTER_SEC
        ) {
          const entryAtr =
            currentStatePosition.metadata
              ?.lastAtr ??
            0;

          const mfeAtr =
            entryAtr > 0
              ? maxUnrealizedPnL /
                (
                  entryAtr *
                  currentStatePosition.quantity
                )
              : 0;

          if (
            mfeAtr >=
            DEAD_TRADE_MIN_MFE_ATR
          ) {
            await executeClose(
              currentStatePosition,
              exitPrice,
              'dead_trade_mfe'
            );

            await verifyRemotePositionClosed(
              symbol
            );

            continue;
          }
        }

        // TIME_STOP: закрываем только если позиция без partial и без BE
        if (
          !activePartialClosed &&
          !activeBeTriggered &&
          positionAgeSeconds >=
            TIME_STOP_SECONDS &&
          (
            maxUnrealizedPnLPercent <
              TIME_STOP_MFE_PERCENT ||
            unrealizedPnLPercent <
              TIME_STOP_MAX_LOSS_PERCENT
          )
        ) {
          await executeClose(
            currentStatePosition,
            exitPrice,
            'time_stop'
          );

          await verifyRemotePositionClosed(
            symbol
          );

          continue;
        }

        if (
          activeTrailing &&
          activePartialClosed
        ) {
          const priorTrailingStop =
            currentStatePosition.metadata
              ?.trailingStopPrice ??
            currentStatePosition.stopLossPrice;

          const trailDistance =
            exitPrice *
            (
              TRAILING_DISTANCE_PERCENT / 100
            );

          const candidateTrailingStop =
            currentStatePosition.side === 'long'
              ? exitPrice - trailDistance
              : exitPrice + trailDistance;

          const nextTrailingStop =
            currentStatePosition.side === 'long'
              ? Math.max(
                  currentStatePosition.stopLossPrice,
                  priorTrailingStop,
                  candidateTrailingStop
                )
              : Math.min(
                  currentStatePosition.stopLossPrice,
                  priorTrailingStop,
                  candidateTrailingStop
                );

          if (
            nextTrailingStop !==
            currentStatePosition.stopLossPrice
          ) {
            if (
              !updatePositionStopLoss(
                currentStatePosition.id,
                nextTrailingStop
              )
            ) {
              throw new Error(
                `Failed to update trailing stop for ` +
                  `${symbol}`
              );
            }

            updatePositionMetadata(
              currentStatePosition.id,
              {
                trailingStopPrice:
                  nextTrailingStop
              }
            );
          }
        }

        const finalPosition =
          getPositions().find(
            item =>
              item.id === position.id
          );

        if (!finalPosition) {
          continue;
        }

        const tpValid =
          finalPosition.side === 'long'
            ? finalPosition.takeProfitPrice >
              finalPosition.entryPrice
            : finalPosition.takeProfitPrice <
              finalPosition.entryPrice;

        const slValid =
          finalPosition.side === 'long'
            ? finalPosition.stopLossPrice <
              finalPosition.entryPrice
            : finalPosition.stopLossPrice >
              finalPosition.entryPrice;

        if (!tpValid || !slValid) {
          console.warn(
            `[${new Date().toISOString()}] ` +
              `${symbol}: Invalid TP/SL levels detected: ` +
              `TP=${finalPosition.takeProfitPrice}, ` +
              `SL=${finalPosition.stopLossPrice}, ` +
              `entry=${finalPosition.entryPrice}, ` +
              `side=${finalPosition.side}`
          );

          logError({
            timestamp:
              new Date().toISOString(),
            context: 'position-check',
            symbol,
            positionId: finalPosition.id,
            error:
              `Invalid TP/SL levels: ` +
              `TP=${finalPosition.takeProfitPrice}, ` +
              `SL=${finalPosition.stopLossPrice}, ` +
              `entry=${finalPosition.entryPrice}`
          });

          continue;
        }

        const hitTakeProfit =
          finalPosition.side === 'long'
            ? markPrice >=
              finalPosition.takeProfitPrice
            : markPrice <=
              finalPosition.takeProfitPrice;

        const hitStopLoss =
          finalPosition.side === 'long'
            ? markPrice <=
              finalPosition.stopLossPrice
            : markPrice >=
              finalPosition.stopLossPrice;

        if (
          hitTakeProfit &&
          hitStopLoss
        ) {
          logError({
            timestamp:
              new Date().toISOString(),
            context: 'position-check',
            symbol,
            positionId: finalPosition.id,
            error:
              'TP and SL triggered simultaneously; ' +
              'TP priority applied'
          });
        }

        if (hitTakeProfit) {
          await executeClose(
            finalPosition,
            exitPrice,
            'take_profit'
          );

          await verifyRemotePositionClosed(
            symbol
          );

          continue;
        }

        if (hitStopLoss) {
          await executeClose(
            finalPosition,
            exitPrice,
            finalPosition.metadata
              ?.beTriggered
              ? 'breakeven_stop'
              : 'stop_loss'
          );

          await verifyRemotePositionClosed(
            symbol
          );

          continue;
        }

        const distanceToTP =
          finalPosition.side === 'long'
            ? finalPosition.takeProfitPrice -
              markPrice
            : markPrice -
              finalPosition.takeProfitPrice;

        const distanceToSL =
          finalPosition.side === 'long'
            ? markPrice -
              finalPosition.stopLossPrice
            : finalPosition.stopLossPrice -
              markPrice;

        logPositionCheck({
          timestamp:
            new Date().toISOString(),
          positionId: finalPosition.id,
          symbol: finalPosition.symbol,
          side: finalPosition.side,
          entryPrice:
            finalPosition.entryPrice,
          currentPrice: markPrice,
          takeProfitPrice:
            finalPosition.takeProfitPrice,
          stopLossPrice:
            finalPosition.stopLossPrice,
          unrealizedPnL,
          unrealizedPnLPercent,
          distanceToTP,
          distanceToTPPercent:
            (
              distanceToTP /
              markPrice
            ) * 100,
          distanceToSL,
          distanceToSLPercent:
            (
              distanceToSL /
              markPrice
            ) * 100,
          hitTakeProfit,
          hitStopLoss,
          action: 'hold',
          positionAgeSeconds
        });
      } catch (error) {
        const errorMsg =
          error instanceof Error
            ? error.message
            : 'Unknown error';

        logError({
          timestamp:
            new Date().toISOString(),
          context: 'position-check',
          symbol:
            snapshotPosition.symbol,
          positionId:
            snapshotPosition.id,
          error: errorMsg
        });

        notifyError({
          context: 'position-check',
          symbol:
            snapshotPosition.symbol,
          error: errorMsg
        });
      }
    }
  } finally {
    positionCheckRunning = false;
  }
}

export async function startScheduler(): Promise<void> {
  if (schedulerStarted) {
    return;
  }

  schedulerStarted = true;
  schedulerStopping = false;
  schedulerFatalError = null;

  try {
    executionService =
      createExecutionService();

    initializeSignerClient();

    await refreshTopMarkets();

    if (
      !PAPER_TRADING &&
      signerClient
    ) {
      const accountIndex =
        Number(
          process.env.LIGHTER_ACCOUNT_INDEX ??
            0
        );

      await syncLiveBalance(accountIndex);

      console.log(
        `[${new Date().toISOString()}] ` +
          `Running state reconciliation...`
      );

      const restore =
        await restoreStateAfterRestart(
          signerClient,
          accountIndex
        );

      console.log(
        `[${new Date().toISOString()}] ` +
          `Reconciliation: ` +
          `restored=${restore.restored}, ` +
          `closed=${restore.closed}, ` +
          `errors=${restore.errors}`
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
        accountIndex,
        15 * 60 * 1000
      );

      startBalanceSyncLoop(
        accountIndex,
        5 * 60 * 1000
      );
    } else if (PAPER_TRADING) {
      console.log(
        `[${new Date().toISOString()}] ` +
          `Paper trading enabled; ` +
          `state reconciliation skipped`
      );
    }

    startMarketRefresh();

    await checkSignals();
    await checkPositions();

    signalCheckInterval =
      setInterval(
        () => {
          void checkSignals().catch(
            error => {
              console.error(
                `[${new Date().toISOString()}] ` +
                  `Signal interval error:`,
                error
              );
            }
          );
        },
        SIGNAL_CHECK_INTERVAL_MS
      );

    positionCheckInterval =
      setInterval(
        () => {
          void checkPositions().catch(
            error => {
              console.error(
                `[${new Date().toISOString()}] ` +
                  `Position interval error:`,
                error
              );
            }
          );
        },
        POSITION_CHECK_INTERVAL_MS
      );

    const activeTradingPairs =
      getActiveTradingPairs();

    notifyStartup({
      port:
        Number(process.env.PORT) || 3006,
      tradingPairs:
        activeTradingPairs,
      signalInterval:
        SIGNAL_CHECK_INTERVAL_MS / 1000,
      positionInterval:
        POSITION_CHECK_INTERVAL_MS / 1000
    });
  } catch (error) {
    schedulerStarted = false;
    stopMarketRefresh();
    stopReconciliationLoop();
    stopBalanceSyncLoop();

    executionService?.stop?.();

    throw error;
  }
}

export async function stopScheduler(): Promise<void> {
  stopReconciliationLoop();

  stopBalanceSyncLoop();

  stopMarketRefresh();

  if (signalCheckInterval) {
    clearInterval(signalCheckInterval);
    signalCheckInterval = null;
  }

  if (positionCheckInterval) {
    clearInterval(
      positionCheckInterval
    );

    positionCheckInterval = null;
  }

  executionService?.stop?.();

  if (!schedulerStopping) {
    schedulerStopping = true;

    const symbols = new Set([
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
            `Failed to stop market data for ` +
            `${symbol}:`,
          error
        );
      }
    }
  }

  await flushPositionPersistence().catch(error => {
    console.error(
      `[${new Date().toISOString()}] ` +
        `Failed to flush position persistence:`,
      error
    );
  });

  schedulerStarted = false;
}
