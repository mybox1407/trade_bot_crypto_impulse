import {
  SIGNAL_CHECK_INTERVAL_MS,
  POSITION_CHECK_INTERVAL_MS,
  TOP_MARKETS_LIMIT,
  MARKET_REFRESH_INTERVAL_MS
} from '../config/constants';

import { runBotOnce } from './botRunner';

import {
  startMarketData,
  stopMarketData,
  getCurrentPrice,
  getMarketPrice,
  resolveMarket
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
  updatePositionStopLoss
} from './positionState';

import { TRADE_FEE_RATE } from './strategy';

import {
  logSignalCheck,
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
  getActiveTradingPairs
} from './scheduler.dynamic.parts';

import {
  PaperExecutionService,
  ExecutionService,
  OpenExecutionRequest,
  CloseExecutionRequest
} from './execution';

const executionService: ExecutionService =
  new PaperExecutionService();

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
const DEAD_TRADE_CHECK_AFTER_SEC = 240;
const DEAD_TRADE_MIN_MFE_ATR = 0.3;
const ROUND_TRIP_FEE_PERCENT = TRADE_FEE_RATE * 2 * 100;
const BE_SLIPPAGE_BUFFER_PERCENT = 0.05;
const MIN_LOCKED_PERCENT = 0.25;

let signalCheckInterval: NodeJS.Timeout | null = null;
let positionCheckInterval: NodeJS.Timeout | null = null;

let signalCheckRunning = false;
let positionCheckRunning = false;
let schedulerStopping = false;
let schedulerStarted = false;

let marketRefreshRunning = false;

function formatPrice(price: number): string {
  return Number.isFinite(price)
    ? price.toFixed(4)
    : 'n/a';
}

function formatOpenPositionsForTelegram(): string {
  const positions = getPositions();

  if (positions.length === 0) {
    return 'No open positions';
  }

  return positions
    .map(position => {
      const sideEmoji = position.side === 'long' ? '🟢' : '🔴';
      return `${sideEmoji} ${position.symbol} ${position.side.toUpperCase()} | Entry: ${formatPrice(position.entryPrice)} | TP: ${formatPrice(position.takeProfitPrice)} | SL: ${formatPrice(position.stopLossPrice)} | Notional: ${position.notional.toFixed(2)}`;
    })
    .join('\n');
}

async function sendTelegramSummary(
  signalResults: SignalResult[]
): Promise<void> {
  const activeResults = signalResults.filter(
    result =>
      result.status === 'signal' ||
      result.status === 'no-signal' ||
      result.status === 'not-ready' ||
      result.status === 'error'
  );

  const signalsCount = signalResults.filter(
    result => result.status === 'signal'
  ).length;

  const noSignalCount = signalResults.filter(
    result =>
      result.status === 'no-signal' ||
      result.status === 'not-ready'
  ).length;

  const openPositionsCount = getOpenPositionsCount();
  const errorCount = signalResults.filter(
    result => result.status === 'error'
  ).length;

  const signalText =
    activeResults.length > 0
      ? activeResults
          .map(result => {
            if (result.status === 'error') {
              return `❌ ${result.symbol}: ERROR - ${result.reason}`;
            }

            if (result.status === 'not-ready') {
              return `⏳ ${result.symbol}: NOT READY - ${result.reason}`;
            }

            if (result.status === 'signal') {
              const emoji = result.side === 'long' ? '🟢' : '🔴';
              const side = result.side?.toUpperCase() ?? 'SIGNAL';
              const price = result.price != null ? `@ ${formatPrice(result.price)}` : '';
              return `${emoji} ${result.symbol} [${result.regime}]: ${side} ${price} - ${result.reason}`;
            }

            return `${result.symbol} [${result.regime}]: No signal - ${result.reason}`;
          })
          .join('\n')
      : 'No free symbols to analyze';

  const summaryMessage =
`📊 Signal Check Summary

📈 Open positions: ${openPositionsCount}/${MAX_PARALLEL_POSITIONS}
${formatOpenPositionsForTelegram()}

💰 Equity: ${getBalance().toFixed(2)}
🔒 Reserved: ${getReservedCapital().toFixed(2)}
💵 Available: ${getAvailableBalance().toFixed(2)}

🔍 Signal scan:
${signalText}

📊 Signals: ${signalsCount} | No signals: ${noSignalCount}
📈 Open: ${openPositionsCount}/${MAX_PARALLEL_POSITIONS}
⚠️ Errors: ${errorCount}

${new Date().toISOString()}`;

  const shouldSendSummary =
    signalsCount > 0 ||
    errorCount > 0 ||
    activeResults.length > 0;

  if (!shouldSendSummary) {
    console.log(
      `[${new Date().toISOString()}] Telegram summary skipped: all positions are already open`
    );
    return;
  }

  try {
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = process.env.TELEGRAM_CHAT_ID;

    if (!telegramToken || !telegramChatId) {
      console.warn(
        `[${new Date().toISOString()}] Telegram summary skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing`
      );
      return;
    }

    const url = `https://api.telegram.org/bot${telegramToken}/sendMessage`;

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

    console.log(
      `[${new Date().toISOString()}] Telegram summary sent`
    );
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Failed to send summary:`,
      error instanceof Error ? error.message : 'Unknown'
    );
  }
}

async function checkSignals(): Promise<void> {
  if (signalCheckRunning) {
    console.warn(
      `[${new Date().toISOString()}] SIGNAL CHECK SKIPPED: previous check is still running`
    );
    return;
  }

  signalCheckRunning = true;

  try {
    console.log(
      `[${new Date().toISOString()}] SIGNAL CHECK START`
    );

    const activeTradingPairs = getActiveTradingPairs();

    console.log(
      `[${new Date().toISOString()}] Pairs: ${activeTradingPairs.length}, ` +
        `Open positions: ${getOpenPositionsCount()}/${MAX_PARALLEL_POSITIONS}, ` +
        `Equity: ${getBalance().toFixed(2)}, ` +
        `Reserved: ${getReservedCapital().toFixed(2)}, ` +
        `Available: ${getAvailableBalance().toFixed(2)}`
    );

    const signalResults: SignalResult[] = [];

    for (const symbol of activeTradingPairs) {
      try {
        if (hasOpenPosition(symbol)) {
          console.log(
            `[${new Date().toISOString()}] ${symbol} SIGNAL CHECK SKIPPED: open position exists`
          );

          signalResults.push({
            symbol,
            status: 'position-open',
            regime: 'position-open',
            hasSignal: false,
            reason: 'Open position exists'
          });

          continue;
        }

        if (getOpenPositionsCount() >= MAX_PARALLEL_POSITIONS) {
          console.log(
            `[${new Date().toISOString()}] ${symbol} SIGNAL CHECK SKIPPED: max positions reached (${getOpenPositionsCount()}/${MAX_PARALLEL_POSITIONS})`
          );

          signalResults.push({
            symbol,
            status: 'max-positions',
            regime: 'max-positions',
            hasSignal: false,
            reason: `Max positions reached: ${MAX_PARALLEL_POSITIONS}`
          });

          continue;
        }

        const result = await runBotOnce(symbol, '15m');

        if (!result.ready) {
          const reason = result.reason ?? 'Strategy result is not ready';
          console.log(
            `[${new Date().toISOString()}] ${symbol} NOT READY - ${reason}`
          );

          signalResults.push({
            symbol,
            status: 'not-ready',
            regime: 'unknown',
            hasSignal: false,
            reason
          });

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
        const indicators = (result as any).indicators as any;
        const skipReason = (result as any).skipReason as string | null;

        console.log(
          `[${new Date().toISOString()}] ${symbol} ANALYSIS:`,
          `Price: ${formatPrice(price)}`,
          `Regime: ${regime}`,
          `MACD Cross Up: ${indicators?.macdCrossUp}, Down: ${indicators?.macdCrossDown}`,
          `RSI: ${indicators?.lastRsi?.toFixed(2)}`,
          `ATR: ${indicators?.lastAtr?.toFixed(4)}`,
          `ADX: ${indicators?.regimeIndicators?.adx?.toFixed(2)}`,
          `BB Width: ${indicators?.regimeIndicators?.bbWidth?.toFixed(4)}`
        );

        if (indicators?.entryExtensionAtr != null) {
          console.log(
            `Entry extension: ${indicators.entryExtensionAtr.toFixed(2)} ATR (limit: ${indicators.maxEntryExtensionAtr?.toFixed(2) ?? 'n/a'} ATR, filtered: ${indicators.entryTooExtended})`
          );
        }

        const signalReason = buy ? 'BUY' : sell ? 'SELL' : 'NONE';

        if (skipReason) {
          console.log(`Signal skipped: ${skipReason}`);

          signalResults.push({
            symbol,
            status: 'no-signal',
            regime,
            hasSignal: false,
            reason: skipReason
          });

          logSignalCheck({
            timestamp: new Date().toISOString(),
            symbol,
            timeframe: '15m',
            side: 'none',
            price: price ?? 0,
            regime: regime ?? 'unknown',
            takeProfitPrice: null,
            stopLossPrice: null,
            positionSize: null,
            macdCrossUp: indicators?.macdCrossUp ?? false,
            macdCrossDown: indicators?.macdCrossDown ?? false,
            lastRsi: indicators?.lastRsi ?? 0,
            lastAtr: indicators?.lastAtr ?? 0,
            rsiBull: indicators?.rsiBull ?? false,
            rsiBear: indicators?.rsiBear ?? false,
            bbUpper: indicators?.bbUpper ?? 0,
            bbMiddle: indicators?.bbMiddle ?? 0,
            bbLower: indicators?.bbLower ?? 0,
            adx: indicators?.regimeIndicators?.adx ?? 0,
            adxRising: indicators?.regimeIndicators?.adxRising ?? false,
            ema20: indicators?.regimeIndicators?.ema20 ?? 0,
            ema50: indicators?.regimeIndicators?.ema50 ?? 0,
            ema200: indicators?.regimeIndicators?.ema200 ?? 0,
            bbWidth: indicators?.regimeIndicators?.bbWidth ?? 0,
            atrPct: indicators?.regimeIndicators?.atrPct ?? 0,
            signalTriggered: false,
            positionOpened: false
          });

          continue;
        }

        if (!buy && !sell) {
          console.log(
            `[${new Date().toISOString()}] ${symbol} NO SIGNAL`
          );

          let signalReason = '';

          if (regime === 'high-volatility') {
            signalReason = `High volatility (ATR: ${indicators?.regimeIndicators?.atrPct?.toFixed(4)})`;
          } else if (regime === 'range') {
            signalReason = `Range (ADX: ${indicators?.regimeIndicators?.adx?.toFixed(2)})`;
          } else if (regime === 'trend-up') {
            const reasons: string[] = [];

            if (!indicators?.macdCrossUp && !indicators?.macdCrossDown) {
              reasons.push('No MACD cross');
            }

            if (!indicators?.rsiBull) {
              reasons.push(`RSI not bull (${indicators?.lastRsi?.toFixed(2)})`);
            }

            if (price < (indicators?.regimeIndicators?.ema200 ?? 0)) {
              reasons.push('Price below EMA200');
            }

            signalReason = reasons.join(', ') || 'Trend up - trades disabled';
          } else if (regime === 'trend-down') {
            const reasons: string[] = [];

            if (!indicators?.macdCrossUp && !indicators?.macdCrossDown) {
              reasons.push('No MACD cross');
            }

            if (!indicators?.rsiBear) {
              reasons.push(`RSI not bear (${indicators?.lastRsi?.toFixed(2)})`);
            }

            if (price > (indicators?.regimeIndicators?.ema200 ?? 0)) {
              reasons.push('Price above EMA200');
            }

            signalReason = reasons.join(', ') || 'No MACD cross down';
          } else if (regime === 'breakout-watch') {
            signalReason = 'Waiting for BB breakout';
          } else {
            signalReason = 'Unknown regime';
          }

          console.log(`Reason: ${signalReason}`);

          signalResults.push({
            symbol,
            status: 'no-signal',
            regime,
            hasSignal: false,
            reason: signalReason
          });

          logSignalCheck({
            timestamp: new Date().toISOString(),
            symbol,
            timeframe: '15m',
            side: buy || sell ? side : 'none',
            price: price ?? 0,
            regime: regime ?? 'unknown',
            takeProfitPrice: takeProfitPrice ?? null,
            stopLossPrice: stopLossPrice ?? null,
            positionSize: positionSize ?? null,
            macdCrossUp: indicators?.macdCrossUp ?? false,
            macdCrossDown: indicators?.macdCrossDown ?? false,
            lastRsi: indicators?.lastRsi ?? 0,
            lastAtr: indicators?.lastAtr ?? 0,
            rsiBull: indicators?.rsiBull ?? false,
            rsiBear: indicators?.rsiBear ?? false,
            bbUpper: indicators?.bbUpper ?? 0,
            bbMiddle: indicators?.bbMiddle ?? 0,
            bbLower: indicators?.bbLower ?? 0,
            adx: indicators?.regimeIndicators?.adx ?? 0,
            adxRising: indicators?.regimeIndicators?.adxRising ?? false,
            ema20: indicators?.regimeIndicators?.ema20 ?? 0,
            ema50: indicators?.regimeIndicators?.ema50 ?? 0,
            ema200: indicators?.regimeIndicators?.ema200 ?? 0,
            bbWidth: indicators?.regimeIndicators?.bbWidth ?? 0,
            atrPct: indicators?.regimeIndicators?.atrPct ?? 0,
            signalTriggered: buy || sell,
            positionOpened: false
          });

          continue;
        }

        if (side === 'none') {
          const reason = 'Signal side is none';
          console.log(
            `[${new Date().toISOString()}] ${symbol} FAILED TO OPEN - ${reason}`
          );

          signalResults.push({
            symbol,
            status: 'signal',
            regime,
            hasSignal: true,
            side,
            price,
            reason
          });

          continue;
        }

        if (takeProfitPrice == null || stopLossPrice == null) {
          const reason = 'Take profit or stop loss is missing';
          console.log(
            `[${new Date().toISOString()}] ${symbol} FAILED TO OPEN - ${reason}`
          );

          signalResults.push({
            symbol,
            status: 'signal',
            regime,
            hasSignal: true,
            side,
            price,
            reason
          });

          continue;
        }

        const riskCapital = getRiskCapital();
        const maxNotionalByPercent = getPositionNotional();

        const stopDistance = Math.abs(price - stopLossPrice);
        const worstCaseFeePerUnit = Math.abs(price - stopLossPrice) * TRADE_FEE_RATE;
        const totalRiskPerUnit = stopDistance + worstCaseFeePerUnit;

        const calculatedQuantity = riskCapital / totalRiskPerUnit;
        const maxQuantityByPercent = maxNotionalByPercent / price;

        const quantity = Math.min(calculatedQuantity, maxQuantityByPercent);

        if (quantity <= 0) {
          const reason = 'Calculated quantity is invalid';
          console.log(
            `[${new Date().toISOString()}] ${symbol} FAILED TO OPEN - ${reason}`
          );

          signalResults.push({
            symbol,
            status: 'signal',
            regime,
            hasSignal: true,
            side,
            price,
            reason
          });

          continue;
        }

        const marketRef = resolveMarket(symbol);
        const marketId = marketRef.marketId;

        const clientOrderId = `${symbol}-${Date.now()}-open`;

        const executionResult = await executionService.openPosition({
          symbol,
          marketId,
          side,
          quantity,
          expectedPrice: price,
          clientOrderId,
          priceDecimals: 2,
          sizeDecimals: 8
        });

        if (!executionResult.ok) {
          console.log(
            `[${new Date().toISOString()}] ${symbol} EXECUTION FAILED - ${executionResult.message}`
          );

          signalResults.push({
            symbol,
            status: 'signal',
            regime,
            hasSignal: true,
            side,
            price,
            reason: executionResult.message ?? 'Execution failed'
          });

          continue;
        }

        if (
          executionResult.filledQuantity <= 0 ||
          executionResult.averageFillPrice == null
        ) {
          console.log(
            `[${new Date().toISOString()}] ${symbol} NO FILL CONFIRMED`
          );

          signalResults.push({
            symbol,
            status: 'signal',
            regime,
            hasSignal: true,
            side,
            price,
            reason: 'No fill confirmed'
          });

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

        if (openResult.ok && openResult.position) {
          console.log(
            `[${new Date().toISOString()}] ${symbol} POSITION OPENED!`,
            `Position ID: ${openResult.position.id}`,
            `Quantity: ${openResult.position.quantity.toFixed(8)}`,
            `Notional: ${openResult.position.notional.toFixed(2)}`,
            `Entry: ${openResult.position.entryPrice.toFixed(4)}`,
            `TP: ${openResult.position.takeProfitPrice.toFixed(4)}`,
            `SL: ${openResult.position.stopLossPrice.toFixed(4)}`,
            `Equity: ${openResult.balance.toFixed(2)}`,
            `Reserved: ${openResult.reservedCapitalAfter.toFixed(2)}`,
            `Available: ${openResult.availableBalanceAfter.toFixed(2)}`
          );

          signalResults.push({
            symbol,
            status: 'signal',
            regime,
            hasSignal: true,
            side,
            price,
            reason: 'Position opened'
          });
        } else {
          console.log(
            `[${new Date().toISOString()}] ${symbol} FAILED TO OPEN - ${openResult.message}`
          );

          signalResults.push({
            symbol,
            status: 'signal',
            regime,
            hasSignal: true,
            side,
            price,
            reason: openResult.message ?? 'Unknown error'
          });
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';

        console.error(
          `[${new Date().toISOString()}] ${symbol} ERROR - ${errorMsg}`
        );

        logError({
          timestamp: new Date().toISOString(),
          context: 'signal-check',
          symbol,
          error: String(errorMsg),
          stack: undefined
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

    await sendTelegramSummary(signalResults);

    console.log(
      `[${new Date().toISOString()}] SIGNAL CHECK END`
    );
  } finally {
    signalCheckRunning = false;
  }
}

async function checkPositions(): Promise<void> {
  if (positionCheckRunning) {
    console.warn(
      `[${new Date().toISOString()}] POSITION CHECK SKIPPED: previous check is still running`
    );
    return;
  }

  positionCheckRunning = true;

  try {
    const positions = getPositions();

    if (positions.length === 0) {
      return;
    }

    console.log(
      `[${new Date().toISOString()}] POSITION CHECK START`
    );

    console.log(
      `[${new Date().toISOString()}] Checking ${positions.length} positions...`
    );

    for (const position of positions) {
      try {
        if (!hasOpenPosition(position.symbol)) {
          continue;
        }

        const currentPrice = getCurrentPrice(position.symbol);

        if (currentPrice == null || !Number.isFinite(currentPrice)) {
          console.warn(
            `[${new Date().toISOString()}] ${position.symbol}: current price unavailable`
          );
          continue;
        }

        const unrealizedPnL =
          position.side === 'long'
            ? (currentPrice - position.entryPrice) * position.quantity
            : (position.entryPrice - currentPrice) * position.quantity;

        const unrealizedPnLPercent =
          position.notional > 0
            ? (unrealizedPnL / position.notional) * 100
            : 0;

        const previousMaxPnL = position.metadata?.maxUnrealizedPnL ?? Number.NEGATIVE_INFINITY;
        const previousMaxPnLPercent = position.metadata?.maxUnrealizedPnLPercent ?? Number.NEGATIVE_INFINITY;
        const previousWorstPnL = position.metadata?.worstUnrealizedPnL ?? Number.POSITIVE_INFINITY;
        const previousWorstPnLPercent = position.metadata?.worstUnrealizedPnLPercent ?? Number.POSITIVE_INFINITY;

        const maxUnrealizedPnL = Math.max(previousMaxPnL, unrealizedPnL);
        const maxUnrealizedPnLPercent = Math.max(previousMaxPnLPercent, unrealizedPnLPercent);

        updatePositionMetadata(position.id, {
          maxUnrealizedPnL,
          maxUnrealizedPnLPercent,
          worstUnrealizedPnL: Math.min(previousWorstPnL, unrealizedPnL),
          worstUnrealizedPnLPercent: Math.min(previousWorstPnLPercent, unrealizedPnLPercent)
        });

        const openedAt = new Date(position.openedAt).getTime();
        const positionAgeSeconds = Math.floor((Date.now() - openedAt) / 1000);

        const partialClosed = position.metadata?.partialClosed ?? false;
        const trailingActive = position.metadata?.trailingActive ?? false;
        const beTriggered = position.metadata?.beTriggered ?? false;

        if (!beTriggered && maxUnrealizedPnLPercent >= BE_THRESHOLD_PERCENT) {
          const lockedPercent = Math.max(
            MIN_LOCKED_PERCENT,
            (maxUnrealizedPnLPercent - BE_THRESHOLD_PERCENT) * LOCK_RATIO
          );

          const ratchetStop =
            position.side === 'long'
              ? position.entryPrice * (1 + lockedPercent / 100)
              : position.entryPrice * (1 - lockedPercent / 100);

          const nextStop =
            position.side === 'long'
              ? Math.max(position.stopLossPrice, ratchetStop)
              : Math.min(position.stopLossPrice, ratchetStop);

          if (nextStop !== position.stopLossPrice) {
            const updated = updatePositionStopLoss(position.id, nextStop);

            if (!updated) {
              throw new Error(`Failed to update ratchet stop for ${position.id}`);
            }

            position.stopLossPrice = nextStop;

            updatePositionMetadata(position.id, {
              beTriggered: true,
              trailingStopPrice: nextStop
            });

            console.log(
              `[${new Date().toISOString()}] ${position.symbol}: RATCHET SL -> ${formatPrice(nextStop)} | MFE: ${maxUnrealizedPnLPercent.toFixed(2)}% | Lock: ${lockedPercent.toFixed(2)}%`
            );
          }
        }

        if (!partialClosed && maxUnrealizedPnLPercent >= PARTIAL_THRESHOLD_PERCENT) {
          const quantityBeforePartial = position.quantity;
          const closeQuantity = quantityBeforePartial * 0.5;

          const clientOrderId = `${position.symbol}-${Date.now()}-partial`;

          const partialExecution = await executionService.closePosition({
            symbol: position.symbol,
            marketId: position.marketId ?? 0,
            positionSide: position.side,
            quantity: closeQuantity,
            expectedPrice: currentPrice,
            reason: 'partial-close',
            clientOrderId,
            priceDecimals: 2,
            sizeDecimals: 8
          });

          if (!partialExecution.ok) {
            throw new Error(
              `Partial close failed for ${position.symbol}: ${partialExecution.message}`
            );
          }

          if (
            partialExecution.filledQuantity <= 0 ||
            partialExecution.averageFillPrice == null
          ) {
            throw new Error(
              `Partial close has no confirmed fill: ${position.symbol}`
            );
          }

          const partialResult = partialClosePosition(
            position.id,
            partialExecution.filledQuantity,
            partialExecution.averageFillPrice,
            {
              executionOrderId: partialExecution.orderId,
              clientOrderId,
              fee: partialExecution.fee
            }
          );

          if (!partialResult.ok) {
            throw new Error(
              `Partial close state update failed for ${position.symbol}: ${partialResult.message}`
            );
          }

          const remainingPosition = getPositions().find(item => item.id === position.id);

          if (!remainingPosition) {
            throw new Error(`Position ${position.id} not found after partial close`);
          }

          const trailDistance = currentPrice * (TRAILING_DISTANCE_PERCENT / 100);

          const proposedInitialTrail =
            remainingPosition.side === 'long'
              ? currentPrice - trailDistance
              : currentPrice + trailDistance;

          const initialTrailingStop =
            remainingPosition.side === 'long'
              ? Math.max(remainingPosition.stopLossPrice, proposedInitialTrail)
              : Math.min(remainingPosition.stopLossPrice, proposedInitialTrail);

          const updated = updatePositionStopLoss(remainingPosition.id, initialTrailingStop);

          if (!updated) {
            throw new Error(`Failed to initialize trailing stop for ${position.id}`);
          }

          position.quantity = remainingPosition.quantity;
          position.notional = remainingPosition.notional;
          position.reservedCapital = remainingPosition.reservedCapital;
          position.stopLossPrice = initialTrailingStop;

          updatePositionMetadata(position.id, {
            partialClosed: true,
            trailingActive: true,
            trailingStopPrice: initialTrailingStop
          });

          console.log(
            `[${new Date().toISOString()}] ${position.symbol}: PARTIAL CLOSE 50% (${partialExecution.filledQuantity.toFixed(8)} @ ${formatPrice(partialExecution.averageFillPrice)})`
          );

          console.log(
            `[${new Date().toISOString()}] ${position.symbol}: TRAILING ON @ ${formatPrice(initialTrailingStop)}`
          );
        }

        if (
          DEAD_TRADE_ENABLED &&
          !partialClosed &&
          !beTriggered &&
          positionAgeSeconds >= DEAD_TRADE_CHECK_AFTER_SEC
        ) {
          const entryAtr = position.metadata?.lastAtr ?? 0;
          const mfeAtr =
            entryAtr > 0
              ? maxUnrealizedPnL / (entryAtr * position.quantity)
              : 0;

          if (mfeAtr >= DEAD_TRADE_MIN_MFE_ATR) {
            const clientOrderId = `${position.symbol}-${Date.now()}-dead`;

            const closeExecution = await executionService.closePosition({
              symbol: position.symbol,
              marketId: position.marketId ?? 0,
              positionSide: position.side,
              quantity: position.quantity,
              expectedPrice: currentPrice,
              reason: 'dead-trade-mfe',
              clientOrderId,
              priceDecimals: 2,
              sizeDecimals: 8
            });

            if (!closeExecution.ok) {
              throw new Error(
                `Dead trade close failed for ${position.symbol}: ${closeExecution.message}`
              );
            }

            if (
              closeExecution.filledQuantity <= 0 ||
              closeExecution.averageFillPrice == null
            ) {
              throw new Error(
                `Dead trade close has no confirmed fill: ${position.symbol}`
              );
            }

            const result = closePosition(
              position.id,
              closeExecution.averageFillPrice,
              'dead-trade-mfe',
              {
                executionOrderId: closeExecution.orderId,
                clientOrderId,
                fee: closeExecution.fee
              }
            );

            if (!result.ok) {
              throw new Error(
                `Dead trade state update failed for ${position.symbol}: ${result.message}`
              );
            }

            console.log(
              `[${new Date().toISOString()}] ${position.symbol}: DEAD TRADE (MFE: ${mfeAtr.toFixed(2)} ATR, after ${positionAgeSeconds}s) | Net: ${result.lastClosedTrade?.netPnL.toFixed(2)}`
            );

            continue;
          }
        }

        if (
          !partialClosed &&
          !beTriggered &&
          positionAgeSeconds >= TIME_STOP_SECONDS &&
          (
            maxUnrealizedPnLPercent < TIME_STOP_MFE_PERCENT ||
            unrealizedPnLPercent < TIME_STOP_MAX_LOSS_PERCENT
          )
        ) {
          const clientOrderId = `${position.symbol}-${Date.now()}-timestop`;

          const closeExecution = await executionService.closePosition({
            symbol: position.symbol,
            marketId: position.marketId ?? 0,
            positionSide: position.side,
            quantity: position.quantity,
            expectedPrice: currentPrice,
            reason: 'time-stop',
            clientOrderId,
            priceDecimals: 2,
            sizeDecimals: 8
          });

          if (!closeExecution.ok) {
            throw new Error(
              `Time stop failed for ${position.symbol}: ${closeExecution.message}`
            );
          }

          if (
            closeExecution.filledQuantity <= 0 ||
            closeExecution.averageFillPrice == null
          ) {
            throw new Error(
              `Time stop has no confirmed fill: ${position.symbol}`
            );
          }

          const result = closePosition(
            position.id,
            closeExecution.averageFillPrice,
            'time-stop',
            {
              executionOrderId: closeExecution.orderId,
              clientOrderId,
              fee: closeExecution.fee
            }
          );

          if (!result.ok) {
            throw new Error(
              `Time stop state update failed for ${position.symbol}: ${result.message}`
            );
          }

          console.log(
            `[${new Date().toISOString()}] ${position.symbol}: TIME STOP (MFE: ${maxUnrealizedPnLPercent.toFixed(2)}%, after ${positionAgeSeconds}s) | Net: ${result.lastClosedTrade?.netPnL.toFixed(2)}`
          );

          continue;
        }

        if (trailingActive && partialClosed) {
          const statePosition = getPositions().find(item => item.id === position.id);

          if (!statePosition) {
            continue;
          }

          const priorTrailingStop =
            statePosition.metadata?.trailingStopPrice ?? statePosition.stopLossPrice;

          const trailDistance = currentPrice * (TRAILING_DISTANCE_PERCENT / 100);

          const candidateTrailingStop =
            statePosition.side === 'long'
              ? currentPrice - trailDistance
              : currentPrice + trailDistance;

          const nextTrailingStop =
            statePosition.side === 'long'
              ? Math.max(statePosition.stopLossPrice, priorTrailingStop, candidateTrailingStop)
              : Math.min(statePosition.stopLossPrice, priorTrailingStop, candidateTrailingStop);

          if (nextTrailingStop !== statePosition.stopLossPrice) {
            const updated = updatePositionStopLoss(statePosition.id, nextTrailingStop);

            if (!updated) {
              throw new Error(`Failed to update trailing stop for ${statePosition.id}`);
            }

            position.stopLossPrice = nextTrailingStop;

            updatePositionMetadata(position.id, {
              trailingActive: true,
              trailingStopPrice: nextTrailingStop
            });

            console.log(
              `[${new Date().toISOString()}] ${position.symbol}: TRAILING SL -> ${formatPrice(nextTrailingStop)}`
            );
          }
        }

        const activePosition = getPositions().find(item => item.id === position.id);

        if (!activePosition) {
          continue;
        }

        position.stopLossPrice = activePosition.stopLossPrice;
        position.quantity = activePosition.quantity;
        position.notional = activePosition.notional;
        position.reservedCapital = activePosition.reservedCapital;

        const distanceToTP =
          position.side === 'long'
            ? position.takeProfitPrice - currentPrice
            : currentPrice - position.takeProfitPrice;

        const distanceToTPPercent = (distanceToTP / currentPrice) * 100;

        const distanceToSL =
          position.side === 'long'
            ? currentPrice - position.stopLossPrice
            : position.stopLossPrice - currentPrice;

        const distanceToSLPercent = (distanceToSL / currentPrice) * 100;

        const hitTakeProfit =
          position.side === 'long'
            ? currentPrice >= position.takeProfitPrice
            : currentPrice <= position.takeProfitPrice;

        const hitStopLoss =
          position.side === 'long'
            ? currentPrice <= position.stopLossPrice
            : currentPrice >= position.stopLossPrice;

        if (hitTakeProfit) {
          const clientOrderId = `${position.symbol}-${Date.now()}-tp`;

          const closeExecution = await executionService.closePosition({
            symbol: position.symbol,
            marketId: position.marketId ?? 0,
            positionSide: position.side,
            quantity: position.quantity,
            expectedPrice: currentPrice,
            reason: 'take-profit',
            clientOrderId,
            priceDecimals: 2,
            sizeDecimals: 8
          });

          if (!closeExecution.ok) {
            throw new Error(
              `TP close failed for ${position.symbol}: ${closeExecution.message}`
            );
          }

          if (
            closeExecution.filledQuantity <= 0 ||
            closeExecution.averageFillPrice == null
          ) {
            throw new Error(
              `TP close has no confirmed fill: ${position.symbol}`
            );
          }

          const result = closePosition(
            position.id,
            closeExecution.averageFillPrice,
            'take-profit',
            {
              executionOrderId: closeExecution.orderId,
              clientOrderId,
              fee: closeExecution.fee
            }
          );

          if (!result.ok) {
            throw new Error(
              `TP state update failed for ${position.symbol}: ${result.message}`
            );
          }

          console.log(
            `[${new Date().toISOString()}] ${position.symbol}: CLOSED AT TP | Net: ${result.lastClosedTrade?.netPnL.toFixed(2)}`
          );
        } else if (hitStopLoss) {
          const clientOrderId = `${position.symbol}-${Date.now()}-sl`;

          const closeExecution = await executionService.closePosition({
            symbol: position.symbol,
            marketId: position.marketId ?? 0,
            positionSide: position.side,
            quantity: position.quantity,
            expectedPrice: currentPrice,
            reason: beTriggered ? 'breakeven-stop' : 'stop-loss',
            clientOrderId,
            priceDecimals: 2,
            sizeDecimals: 8
          });

          if (!closeExecution.ok) {
            throw new Error(
              `SL close failed for ${position.symbol}: ${closeExecution.message}`
            );
          }

          if (
            closeExecution.filledQuantity <= 0 ||
            closeExecution.averageFillPrice == null
          ) {
            throw new Error(
              `SL close has no confirmed fill: ${position.symbol}`
            );
          }

          const result = closePosition(
            position.id,
            closeExecution.averageFillPrice,
            beTriggered ? 'breakeven-stop' : 'stop-loss',
            {
              executionOrderId: closeExecution.orderId,
              clientOrderId,
              fee: closeExecution.fee
            }
          );

          if (!result.ok) {
            throw new Error(
              `SL state update failed for ${position.symbol}: ${result.message}`
            );
          }

          console.log(
            `[${new Date().toISOString()}] ${position.symbol}: CLOSED AT ${beTriggered ? 'BE STOP' : 'SL'} | Net: ${result.lastClosedTrade?.netPnL.toFixed(2)}`
          );
        } else {
          console.log(
            `[${new Date().toISOString()}] ${position.symbol}: HOLDING`
          );

          logPositionCheck({
            timestamp: new Date().toISOString(),
            positionId: position.id,
            symbol: position.symbol,
            side: position.side,
            entryPrice: position.entryPrice,
            currentPrice,
            takeProfitPrice: position.takeProfitPrice,
            stopLossPrice: position.stopLossPrice,
            unrealizedPnL,
            unrealizedPnLPercent,
            distanceToTP,
            distanceToTPPercent,
            distanceToSL,
            distanceToSLPercent,
            hitTakeProfit,
            hitStopLoss,
            action: hitTakeProfit ? 'close-tp' : hitStopLoss ? (beTriggered ? 'close-be' : 'close-sl') : 'hold',
            positionAgeSeconds
          });
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';

        console.error(
          `[${new Date().toISOString()}] ${position.symbol} ERROR - ${errorMsg}`
        );

        logError({
          timestamp: new Date().toISOString(),
          context: 'position-check',
          symbol: position.symbol,
          positionId: position.id,
          error: String(errorMsg),
          stack: undefined
        });

        notifyError({
          context: 'position-check',
          symbol: position.symbol,
          error: errorMsg
        });
      }
    }

    console.log(
      `[${new Date().toISOString()}] POSITION CHECK END`
    );
  } finally {
    positionCheckRunning = false;
  }
}

export async function startScheduler(): Promise<void> {
  if (schedulerStarted) {
    console.warn(
      `[${new Date().toISOString()}] Scheduler already started, ignoring duplicate start`
    );
    return;
  }

  schedulerStarted = true;

  console.log(
    `[${new Date().toISOString()}] TRADING BOT STARTING...`
  );

  console.log(
    `[${new Date().toISOString()}] Loading Lighter top markets...`
  );

  await refreshTopMarkets();

  startMarketRefresh();

  const activeTradingPairs = getActiveTradingPairs();

  console.log(
    `[${new Date().toISOString()}] Active markets: ${activeTradingPairs.length}`
  );

  console.log(
    `[${new Date().toISOString()}] Trading pairs: ${activeTradingPairs.join(', ')}`
  );

  console.log(
    `[${new Date().toISOString()}] Port: ${Number(process.env.PORT) || 3002}`
  );

  console.log(
    `[${new Date().toISOString()}] Signal check interval: ${SIGNAL_CHECK_INTERVAL_MS / 1000}s`
  );

  console.log(
    `[${new Date().toISOString()}] Position check interval: ${POSITION_CHECK_INTERVAL_MS / 1000}s`
  );

  console.log(
    `[${new Date().toISOString()}] Max positions: ${MAX_PARALLEL_POSITIONS}`
  );

  console.log(
    `[${new Date().toISOString()}] Exit management: BE ${BE_THRESHOLD_PERCENT}%, lock ${LOCK_RATIO * 100}%, Partial ${PARTIAL_THRESHOLD_PERCENT}%, Trailing ${TRAILING_DISTANCE_PERCENT}%, Time-stop ${TIME_STOP_SECONDS / 60}min, MFE time-stop ${TIME_STOP_MFE_PERCENT}% (!BE), Dead-trade ${DEAD_TRADE_CHECK_AFTER_SEC / 60}min, MFE ${DEAD_TRADE_MIN_MFE_ATR} ATR`
  );

  const positionPercent = getBalance() > 0
    ? (getPositionNotional() / getBalance()) * 100
    : 0;

  console.log(
    `[${new Date().toISOString()}] Position size: ${positionPercent.toFixed(0)}% of equity`
  );

  console.log(
    `[${new Date().toISOString()}] Starting equity: ${getBalance().toFixed(2)}`
  );

  notifyStartup({
    port: Number(process.env.PORT) || 3002,
    tradingPairs: activeTradingPairs,
    signalInterval: SIGNAL_CHECK_INTERVAL_MS / 1000,
    positionInterval: POSITION_CHECK_INTERVAL_MS / 1000
  });

  await checkSignals();
  await checkPositions();

  signalCheckInterval = setInterval(
    () => void checkSignals(),
    SIGNAL_CHECK_INTERVAL_MS
  );

  positionCheckInterval = setInterval(
    () => void checkPositions(),
    POSITION_CHECK_INTERVAL_MS
  );
}

export function stopScheduler(): void {
  console.log(
    `[${new Date().toISOString()}] Stopping scheduler...`
  );

  stopMarketRefresh();

  if (signalCheckInterval) {
    clearInterval(signalCheckInterval);
    signalCheckInterval = null;
  }

  if (positionCheckInterval) {
    clearInterval(positionCheckInterval);
    positionCheckInterval = null;
  }

  if (!schedulerStopping) {
    schedulerStopping = true;

    for (const position of getPositions()) {
      try {
        stopMarketData(position.symbol);
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] Failed to stop position market data for ${position.symbol}:`,
          error
        );
      }
    }

    for (const symbol of getActiveTradingPairs()) {
      try {
        stopMarketData(symbol);
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] Failed to stop Lighter data for ${symbol}:`,
          error
        );
      }
    }
  }

  console.log(
    `[${new Date().toISOString()}] Scheduler stopped`
  );
}
