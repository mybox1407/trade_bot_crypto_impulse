import {
  TRADING_PAIRS,
  SIGNAL_CHECK_INTERVAL_MS,
  POSITION_CHECK_INTERVAL_MS
} from '../config/constants';
import { runBotOnce } from './botRunner';
import { getCurrentPrice } from './exchange';
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
import { logSignalCheck, logPositionCheck, logError } from './logger';
import { notifyStartup, notifyError } from './telegram';
import axios from 'axios';

type SignalResult = {
  symbol: string;
  status:
    | 'signal'
    | 'no_signal'
    | 'position_open'
    | 'max_positions'
    | 'not_ready'
    | 'error';
  regime: string;
  hasSignal: boolean;
  side?: 'long' | 'short' | 'none';
  price?: number;
  reason: string;
};

// ========== EXIT MANAGEMENT: согласовано с strategy.ts ==========
const BE_TRIGGER_ATR = 0.8;
const PARTIAL_CLOSE_ATR = 1.0;
const TRAILING_DISTANCE_ATR = 0.8;

// 15m таймфрейм: 30 мин = 2 бара
const BARS_PER_TIME_STOP = 2;
const BAR_DURATION_SECONDS = 900; // 15m = 900s

const TIME_STOP_MFE_ATR = 0.7; // жёстче: 0.7 ATR за 2 бара
const TIME_STOP_MAX_LOSS_ATR = 1.0;

const MIN_LOCKED_PERCENT = 0.25; // 0.25% вместо ~0.13%

let signalCheckInterval: NodeJS.Timeout | null = null;
let positionCheckInterval: NodeJS.Timeout | null = null;

let signalCheckRunning = false;
let positionCheckRunning = false;

function formatPrice(price: number) {
  return Number.isFinite(price) ? price.toFixed(4) : 'n/a';
}

function formatOpenPositionsForTelegram() {
  const positions = getPositions();

  if (positions.length === 0) {
    return 'No open positions';
  }

  return positions
    .map(position => {
      const sideEmoji = position.side === 'long' ? '🟢' : '🔴';

      return [
        `${sideEmoji} ${position.symbol}: ${position.side.toUpperCase()}`,
        `Entry ${formatPrice(position.entryPrice)}`,
        `TP ${formatPrice(position.takeProfitPrice)}`,
        `SL ${formatPrice(position.stopLossPrice)}`,
        `Notional $${position.notional.toFixed(2)}`
      ].join(' | ');
    })
    .join('\n');
}

async function sendTelegramSummary(signalResults: SignalResult[]) {
  const activeResults = signalResults.filter(
    result =>
      result.status === 'signal' ||
      result.status === 'no_signal' ||
      result.status === 'not_ready' ||
      result.status === 'error'
  );

  const signalsCount = signalResults.filter(
    result => result.status === 'signal'
  ).length;

  const noSignalCount = signalResults.filter(
    result =>
      result.status === 'no_signal' ||
      result.status === 'not_ready'
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
              return `❌ ${result.symbol}: ERROR | ${result.reason}`;
            }

            if (result.status === 'not_ready') {
              return `⚠️ ${result.symbol}: NOT READY | ${result.reason}`;
            }

            if (result.status === 'signal') {
              const emoji = result.side === 'long' ? '🟢' : '🔴';
              const side = result.side?.toUpperCase() ?? 'SIGNAL';
              const price =
                result.price != null
                  ? ` @ ${formatPrice(result.price)}`
                  : '';

              return `${emoji} ${result.symbol}: ${result.regime} | ${side}${price} | ${result.reason}`;
            }

            return `⏳ ${result.symbol}: ${result.regime} | No signal | ${result.reason}`;
          })
          .join('\n')
      : 'No free symbols to analyze';

  const summaryMessage = `📊 Signal Check Summary

📌 Open positions: ${openPositionsCount}/${MAX_PARALLEL_POSITIONS}
${formatOpenPositionsForTelegram()}

💼 Equity: $${getBalance().toFixed(2)}
🔒 Reserved: $${getReservedCapital().toFixed(2)}
💵 Available: $${getAvailableBalance().toFixed(2)}

🔎 Signal scan
${signalText}

Signals: ${signalsCount} | No signals: ${noSignalCount} | Open: ${openPositionsCount}/${MAX_PARALLEL_POSITIONS} | Errors: ${errorCount}
${new Date().toISOString()}`;

  const shouldSendSummary =
    signalsCount > 0 ||
    errorCount > 0 ||
    activeResults.length > 0;

  if (!shouldSendSummary) {
    console.log(
      `[${new Date().toISOString()}] 📱 Telegram summary skipped — all positions are already open`
    );
    return;
  }

  try {
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
    const telegramChatId = process.env.TELEGRAM_CHAT_ID || '';

    if (!telegramToken || !telegramChatId) {
      console.warn(
        `[${new Date().toISOString()}] ⚠️ Telegram summary skipped — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing`
      );
      return;
    }

    const url = `https://api.telegram.org/bot${telegramToken}/sendMessage`;

    await axios.post(url, {
      chat_id: telegramChatId,
      text: summaryMessage
    });

    console.log(`[${new Date().toISOString()}] 📱 Telegram summary sent`);
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Failed to send summary: ${
        error instanceof Error ? error.message : 'Unknown'
      }`
    );
  }
}

async function checkSignals() {
  if (signalCheckRunning) {
    console.warn(
      `[${new Date().toISOString()}] ⏭ SIGNAL CHECK SKIPPED — previous check is still running`
    );
    return;
  }

  signalCheckRunning = true;

  try {
    console.log(
      `\n[${new Date().toISOString()}] ========== SIGNAL CHECK START ==========`
    );

    console.log(
      `[${new Date().toISOString()}] Pairs: ${TRADING_PAIRS.length}, ` +
        `Open positions: ${getOpenPositionsCount()}/${MAX_PARALLEL_POSITIONS}, ` +
        `Equity: $${getBalance().toFixed(2)}, ` +
        `Reserved: $${getReservedCapital().toFixed(2)}, ` +
        `Available: $${getAvailableBalance().toFixed(2)}`
    );

    const signalResults: SignalResult[] = [];

    for (const symbol of TRADING_PAIRS) {
      try {
        if (hasOpenPosition(symbol)) {
          console.log(
            `[${new Date().toISOString()}] 📌 ${symbol}: SIGNAL CHECK SKIPPED — open position exists`
          );

          signalResults.push({
            symbol,
            status: 'position_open',
            regime: 'position_open',
            hasSignal: false,
            reason: 'Open position exists'
          });

          continue;
        }

        if (getOpenPositionsCount() >= MAX_PARALLEL_POSITIONS) {
          console.log(
            `[${new Date().toISOString()}] ⛔ ${symbol}: SIGNAL CHECK SKIPPED — ` +
              `max positions reached (${getOpenPositionsCount()}/${MAX_PARALLEL_POSITIONS})`
          );

          signalResults.push({
            symbol,
            status: 'max_positions',
            regime: 'max_positions',
            hasSignal: false,
            reason: `Max positions reached (${MAX_PARALLEL_POSITIONS})`
          });

          continue;
        }

        const result = await runBotOnce(symbol, '15m');

        if (!result.ready) {
          const reason = result.reason ?? 'Strategy result is not ready';

          console.log(
            `[${new Date().toISOString()}] ❌ ${symbol}: NOT READY - ${reason}`
          );

          signalResults.push({
            symbol,
            status: 'not_ready',
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

        console.log(`\n[${new Date().toISOString()}] 🔍 ${symbol} ANALYSIS:`);
        console.log(`   Price: ${formatPrice(price)}`);
        console.log(`   Regime: ${regime}`);
        console.log(
          `   MACD Cross Up: ${indicators?.macdCrossUp}, Down: ${indicators?.macdCrossDown}`
        );
        console.log(`   RSI: ${indicators?.lastRsi?.toFixed(2)}`);
        console.log(`   ATR: ${indicators?.lastAtr?.toFixed(4)}`);
        console.log(`   ADX: ${indicators?.regimeIndicators?.adx?.toFixed(2)}`);
        console.log(
          `   BB Width: ${indicators?.regimeIndicators?.bbWidth?.toFixed(4)}`
        );

        if (indicators?.entryExtensionAtr != null) {
          console.log(
            `   Entry extension: ${indicators.entryExtensionAtr.toFixed(2)} ATR ` +
              `(limit: ${indicators.maxEntryExtensionAtr?.toFixed(2) ?? 'n/a'} ATR, ` +
              `filtered: ${indicators.entryTooExtended === true})`
          );
        }

        if (indicators?.vetoCounters) {
          console.log(
            `   Veto counters: EMA20=${indicators.vetoCounters.ema20Extension}, ` +
              `ExtATR=${indicators.vetoCounters.entryExtensionAtr}, ` +
              `RSI=${indicators.vetoCounters.rsiCapBreakout}, ` +
              `Vol=${indicators.vetoCounters.volumeSpike}, ` +
              `MACD=${indicators.vetoCounters.macdCross}, ` +
              `BB=${indicators.vetoCounters.bbSqueeze}`
          );
        }

        console.log(`   Signal: ${buy ? 'BUY' : sell ? 'SELL' : 'NONE'}`);

        let signalReason = '';

        if (skipReason) {
          console.log(`   ⚠️ Signal skipped: ${skipReason}`);

          signalResults.push({
            symbol,
            status: 'no_signal',
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

        if (buy || sell) {
          console.log(
            `\n[${new Date().toISOString()}] 🚨 ${symbol}: SIGNAL DETECTED!`
          );
          console.log(`   Side: ${side.toUpperCase()}`);
          console.log(`   Entry: ${formatPrice(price)}`);
          console.log(
            `   TP: ${takeProfitPrice?.toFixed(4)}, SL: ${stopLossPrice?.toFixed(4)}`
          );
          console.log(
            `   Strategy position size: ${positionSize?.toFixed(4)}`
          );

          signalReason = 'Signal detected';

          if (side === 'none') {
            const reason = 'Signal side is none';

            console.log(
              `[${new Date().toISOString()}] ❌ ${symbol}: FAILED TO OPEN - ${reason}`
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
              `[${new Date().toISOString()}] ❌ ${symbol}: FAILED TO OPEN - ${reason}`
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
          const worstCaseFeePerUnit =
            (price + stopLossPrice) * TRADE_FEE_RATE;
          const totalRiskPerUnit = stopDistance + worstCaseFeePerUnit;
          const calculatedQuantity = riskCapital / totalRiskPerUnit;

          const openResult = openPosition({
            symbol,
            side,
            entryPrice: price,
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
              maxEntryExtensionAtr:
                indicators?.maxEntryExtensionAtr ?? 0,
              entryTooExtended:
                indicators?.entryTooExtended ?? false,

              partialCloseInfo: indicators?.partialCloseInfo ?? null,
              trailingInfo: indicators?.trailingInfo ?? null,
              beTriggerAtr: indicators?.beTriggerAtr ?? BE_TRIGGER_ATR,
              partialCloseAtr: indicators?.partialCloseAtr ?? PARTIAL_CLOSE_ATR,
              trailingStopAtr: indicators?.trailingStopAtr ?? TRAILING_DISTANCE_ATR
            } as any,
            riskCapital,
            maxNotionalByPercent,
            stopDistance,
            totalRiskPerUnit,
            calculatedQuantity
          });

          if (openResult.ok && openResult.position) {
            console.log(
              `[${new Date().toISOString()}] ✅ ${symbol}: POSITION OPENED!`
            );
            console.log(`   Position ID: ${openResult.position.id}`);
            console.log(
              `   Quantity: ${openResult.position.quantity.toFixed(8)}`
            );
            console.log(
              `   Notional: $${openResult.position.notional.toFixed(2)}`
            );
            console.log(`   Equity: $${openResult.balance.toFixed(2)}`);
            console.log(
              `   Reserved: $${openResult.reservedCapitalAfter.toFixed(2)}`
            );
            console.log(
              `   Available: $${openResult.availableBalanceAfter.toFixed(2)}`
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
              `[${new Date().toISOString()}] ❌ ${symbol}: FAILED TO OPEN - ${openResult.message}`
            );

            signalResults.push({
              symbol,
              status: 'signal',
              regime,
              hasSignal: true,
              side,
              price,
              reason: openResult.message || 'Unknown error'
            });
          }
        } else {
          console.log(`[${new Date().toISOString()}] ⏭ ${symbol}: NO SIGNAL`);

          if (regime === 'high_volatility') {
            signalReason =
              `High volatility (ATR%: ` +
              `${indicators?.regimeIndicators?.atrPct?.toFixed(4)})`;
          } else if (regime === 'range') {
            signalReason =
              `Range (ADX: ` +
              `${indicators?.regimeIndicators?.adx?.toFixed(2)})`;
          } else if (regime === 'trend_up') {
            const reasons: string[] = [];

            if (!indicators?.macdCrossUp && !indicators?.macdCrossDown) {
              reasons.push('No MACD cross');
            }

            if (!indicators?.rsiBull) {
              reasons.push(
                `RSI not bull (${indicators?.lastRsi?.toFixed(2)})`
              );
            }

            if (price <= (indicators?.regimeIndicators?.ema200 ?? 0)) {
              reasons.push('Price below EMA200');
            }

            signalReason = reasons.join(', ') || 'Trend up - trades disabled';
          } else if (regime === 'trend_down') {
            const reasons: string[] = [];

            if (!indicators?.macdCrossUp && !indicators?.macdCrossDown) {
              reasons.push('No MACD cross');
            }

            if (!indicators?.rsiBear) {
              reasons.push(
                `RSI not bear (${indicators?.lastRsi?.toFixed(2)})`
              );
            }

            if (price >= (indicators?.regimeIndicators?.ema200 ?? 0)) {
              reasons.push('Price above EMA200');
            }

            signalReason = reasons.join(', ') || 'No MACD cross down';
          } else if (regime === 'breakout_watch') {
            signalReason = 'Waiting for BB breakout';
          } else {
            signalReason = 'Unknown regime';
          }

          console.log(`   Reason: ${signalReason}`);

          signalResults.push({
            symbol,
            status: 'no_signal',
            regime,
            hasSignal: false,
            reason: signalReason
          });
        }

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
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : 'Unknown error';

        console.error(
          `[${new Date().toISOString()}] 💥 ${symbol}: ERROR - ${errorMsg}`
        );

        logError({
          timestamp: new Date().toISOString(),
          context: 'signal_check',
          symbol,
          error: String(errorMsg),
          stack: undefined
        });

        notifyError({
          context: 'signal_check',
          symbol,
          error: String(errorMsg)
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
      `[${new Date().toISOString()}] ========== SIGNAL CHECK END ==========\n`
    );
  } finally {
    signalCheckRunning = false;
  }
}

async function checkPositions() {
  if (positionCheckRunning) {
    console.warn(
      `[${new Date().toISOString()}] ⏭ POSITION CHECK SKIPPED — previous check is still running`
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
      `\n[${new Date().toISOString()}] ========== POSITION CHECK START ==========`
    );
    console.log(
      `[${new Date().toISOString()}] Checking ${positions.length} position(s)...`
    );

    for (const position of positions) {
      try {
        if (!hasOpenPosition(position.symbol)) {
          continue;
        }

        const currentPrice = await getCurrentPrice(position.symbol);

        const unrealizedPnL =
          position.side === 'long'
            ? (currentPrice - position.entryPrice) * position.quantity
            : (position.entryPrice - currentPrice) * position.quantity;

        const unrealizedPnLPercent =
          position.notional > 0
            ? (unrealizedPnL / position.notional) * 100
            : 0;

        const previousMaxPnL =
          position.metadata?.maxUnrealizedPnL ?? Number.NEGATIVE_INFINITY;

        const previousMaxPnLPercent =
          position.metadata?.maxUnrealizedPnLPercent ??
          Number.NEGATIVE_INFINITY;

        const previousWorstPnL =
          position.metadata?.worstUnrealizedPnL ?? Number.POSITIVE_INFINITY;

        const previousWorstPnLPercent =
          position.metadata?.worstUnrealizedPnLPercent ??
          Number.POSITIVE_INFINITY;

        const maxUnrealizedPnL = Math.max(previousMaxPnL, unrealizedPnL);
        const maxUnrealizedPnLPercent = Math.max(
          previousMaxPnLPercent,
          unrealizedPnLPercent
        );

        updatePositionMetadata(position.id, {
          maxUnrealizedPnL,
          maxUnrealizedPnLPercent,
          worstUnrealizedPnL: Math.min(previousWorstPnL, unrealizedPnL),
          worstUnrealizedPnLPercent: Math.min(
            previousWorstPnLPercent,
            unrealizedPnLPercent
          )
        });

        const openedAt = new Date(position.openedAt).getTime();
        const positionAgeSeconds = Math.floor(
          (Date.now() - openedAt) / 1000
        );

        const partialClosed = position.metadata?.partialClosed ?? false;
        const trailingActive = position.metadata?.trailingActive ?? false;
        const beTriggered = position.metadata?.beTriggered ?? false;

        const atr = position.metadata?.lastAtr ?? 0;
        const mfeAtr = atr > 0 ? maxUnrealizedPnL / (atr * position.quantity) : 0;
        const lossAtr = atr > 0 ? unrealizedPnL / (atr * position.quantity) : 0;

        // 15m: считаем возраст в барах стратегии, не в секундах
        const barAge = Math.floor(positionAgeSeconds / BAR_DURATION_SECONDS);

        if (
          !partialClosed &&
          barAge >= BARS_PER_TIME_STOP &&
          (mfeAtr < TIME_STOP_MFE_ATR || lossAtr > TIME_STOP_MAX_LOSS_ATR)
        ) {
          const result = closePosition(
            position.id,
            currentPrice,
            'time_stop'
          );

          if (!result.ok) {
            throw new Error(
              `Failed to time-stop ${position.symbol}: ${result.message}`
            );
          }

          console.log(
            `[${new Date().toISOString()}] ⏱ ${position.symbol}: TIME STOP | ` +
              `MFE ${mfeAtr.toFixed(2)} ATR (${maxUnrealizedPnLPercent.toFixed(2)}%) ` +
              `after ${barAge} bars (${positionAgeSeconds}s) | ` +
              `Net $${result.lastClosedTrade?.netPnL.toFixed(2)}`
          );

          continue;
        }

        const beTriggerAtr = position.metadata?.beTriggerAtr ?? BE_TRIGGER_ATR;
        const partialCloseAtr = position.metadata?.partialCloseAtr ?? PARTIAL_CLOSE_ATR;

        // 1.0 ATR для трендов, 0.8 ATR для пробоев
        const baseTrailingAtr =
          position.metadata?.regime === 'breakout_watch' ? 0.8 : 1.0;

        const trailingStopAtr =
          position.metadata?.trailingStopAtr ?? baseTrailingAtr;

        const mfeInAtr = atr > 0 ? maxUnrealizedPnL / (atr * position.quantity) : 0;

        if (
          !beTriggered &&
          mfeInAtr >= beTriggerAtr
        ) {
          const lockedPercent =
            MIN_LOCKED_PERCENT +
            (mfeInAtr - beTriggerAtr) * 0.5;

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
              throw new Error(
                `Failed to update ratchet stop for ${position.id}`
              );
            }

            position.stopLossPrice = nextStop;

            updatePositionMetadata(position.id, {
              beTriggered: true,
              trailingStopPrice: nextStop
            });

            console.log(
              `[${new Date().toISOString()}] 🛡 ${position.symbol}: RATCHET SL @ ` +
                `${formatPrice(nextStop)} | MFE ${mfeInAtr.toFixed(2)} ATR (${maxUnrealizedPnLPercent.toFixed(2)}%) | ` +
                `lock ${lockedPercent.toFixed(2)}%`
            );
          }
        }

        if (
          !partialClosed &&
          mfeInAtr >= partialCloseAtr
        ) {
          const quantityBeforePartial = position.quantity;
          const closeQuantity = quantityBeforePartial * 0.5;

          const partialResult = partialClosePosition(
            position.id,
            closeQuantity,
            currentPrice
          );

          if (!partialResult.ok) {
            throw new Error(
              `Partial close failed for ${position.symbol}: ${partialResult.message}`
            );
          }

          const remainingPosition = getPositions().find(
            item => item.id === position.id
          );

          if (!remainingPosition) {
            throw new Error(
              `Position ${position.id} not found after partial close`
            );
          }

          const trailDistance = atr * trailingStopAtr;

          const proposedInitialTrail =
            remainingPosition.side === 'long'
              ? currentPrice - trailDistance
              : currentPrice + trailDistance;

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

          const updated = updatePositionStopLoss(
            remainingPosition.id,
            initialTrailingStop
          );

          if (!updated) {
            throw new Error(
              `Failed to initialize trailing stop for ${position.id}`
            );
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
            `[${new Date().toISOString()}] 📉 ${position.symbol}: PARTIAL CLOSE 50% ` +
              `(${closeQuantity.toFixed(8)}) @ ${formatPrice(currentPrice)} | ` +
              `MFE ${mfeInAtr.toFixed(2)} ATR`
          );
          console.log(
            `[${new Date().toISOString()}] 🪢 ${position.symbol}: TRAILING ON @ ` +
              `${formatPrice(initialTrailingStop)} (${trailingStopAtr.toFixed(2)} ATR)`
          );
        }

        if (trailingActive || partialClosed) {
          const statePosition = getPositions().find(
            item => item.id === position.id
          );

          if (!statePosition) {
            continue;
          }

          const priorTrailingStop =
            statePosition.metadata?.trailingStopPrice ??
            statePosition.stopLossPrice;

          const trailDistance = atr * trailingStopAtr;

          const candidateTrailingStop =
            statePosition.side === 'long'
              ? currentPrice - trailDistance
              : currentPrice + trailDistance;

          const nextTrailingStop =
            statePosition.side === 'long'
              ? Math.max(
                  statePosition.stopLossPrice,
                  priorTrailingStop,
                  candidateTrailingStop
                )
              : Math.min(
                  statePosition.stopLossPrice,
                  priorTrailingStop,
                  candidateTrailingStop
                );

          // Не дёргать SL, если сдвиг меньше 0.3 ATR
          const shouldUpdate =
            Math.abs(nextTrailingStop - statePosition.stopLossPrice) / atr >= 0.3 &&
            nextTrailingStop !== statePosition.stopLossPrice;

          if (shouldUpdate) {
            const updated = updatePositionStopLoss(
              statePosition.id,
              nextTrailingStop
            );

            if (!updated) {
              throw new Error(
                `Failed to update trailing stop for ${statePosition.id}`
              );
            }

            position.stopLossPrice = nextTrailingStop;

            updatePositionMetadata(position.id, {
              trailingActive: true,
              trailingStopPrice: nextTrailingStop
            });

            console.log(
              `[${new Date().toISOString()}] 🔁 ${position.symbol}: TRAILING SL @ ` +
                `${formatPrice(nextTrailingStop)} (${trailingStopAtr.toFixed(2)} ATR)`
            );
          }
        }

        const activePosition = getPositions().find(
          item => item.id === position.id
        );

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

        const distanceToTPPercent =
          (distanceToTP / currentPrice) * 100;

        const distanceToSL =
          position.side === 'long'
            ? currentPrice - position.stopLossPrice
            : position.stopLossPrice - currentPrice;

        const distanceToSLPercent =
          (distanceToSL / currentPrice) * 100;

        const hitTakeProfit =
          position.side === 'long'
            ? currentPrice >= position.takeProfitPrice
            : currentPrice <= position.takeProfitPrice;

        const hitStopLoss =
          position.side === 'long'
            ? currentPrice <= position.stopLossPrice
            : currentPrice >= position.stopLossPrice;

        console.log(
          `\n[${new Date().toISOString()}] 📊 ${position.symbol} (${position.side.toUpperCase()}):`
        );
        console.log(
          `   Entry: ${formatPrice(position.entryPrice)}, Current: ${formatPrice(currentPrice)}`
        );
        console.log(
          `   TP: ${formatPrice(position.takeProfitPrice)}, SL: ${formatPrice(position.stopLossPrice)}`
        );
        console.log(
          `   Unrealized: $${unrealizedPnL.toFixed(2)} (${unrealizedPnLPercent.toFixed(2)}%) | ` +
            `MFE: ${maxUnrealizedPnLPercent.toFixed(2)}% (${mfeInAtr.toFixed(2)} ATR)`
        );

        if (hitTakeProfit) {
          const result = closePosition(
            position.id,
            currentPrice,
            'take_profit'
          );

          if (!result.ok) {
            throw new Error(
              `Failed to close TP for ${position.symbol}: ${result.message}`
            );
          }

          console.log(
            `[${new Date().toISOString()}] 🎯 ${position.symbol}: CLOSED AT TP | ` +
              `Net $${result.lastClosedTrade?.netPnL.toFixed(2)}`
          );
        } else if (hitStopLoss) {
          const result = closePosition(
            position.id,
            currentPrice,
            beTriggered ? 'breakeven_stop' : 'stop_loss'
          );

          if (!result.ok) {
            throw new Error(
              `Failed to close SL for ${position.symbol}: ${result.message}`
            );
          }

          console.log(
            `[${new Date().toISOString()}] 🛑 ${position.symbol}: CLOSED AT ${beTriggered ? 'BE' : 'STOP'} | ` +
              `Net $${result.lastClosedTrade?.netPnL.toFixed(2)}`
          );
        } else {
          console.log(
            `[${new Date().toISOString()}] ⏳ ${position.symbol}: HOLDING`
          );
        }

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
          action: hitTakeProfit
            ? 'close_tp'
            : hitStopLoss
              ? beTriggered ? 'close_be' : 'close_sl'
              : 'hold',
          positionAgeSeconds
        });
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : 'Unknown error';

        console.error(
          `[${new Date().toISOString()}] 💥 ${position.symbol}: ERROR - ${errorMsg}`
        );

        logError({
          timestamp: new Date().toISOString(),
          context: 'position_check',
          symbol: position.symbol,
          positionId: position.id,
          error: String(errorMsg),
          stack: undefined
        });

        notifyError({
          context: 'position_check',
          symbol: position.symbol,
          error: errorMsg
        });
      }
    }

    console.log(
      `[${new Date().toISOString()}] ========== POSITION CHECK END ==========\n`
    );
  } finally {
    positionCheckRunning = false;
  }
}

export function startScheduler() {
  console.log(`\n[${new Date().toISOString()}] 🚀 TRADING BOT STARTING...`);
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
    `[${new Date().toISOString()}] Trading pairs: ${[...TRADING_PAIRS].join(', ')}`
  );
  console.log(
    `[${new Date().toISOString()}] Max positions: ${MAX_PARALLEL_POSITIONS}`
  );
  console.log(
    `[${new Date().toISOString()}] Exit management: ` +
      `BE @ +${BE_TRIGGER_ATR} ATR | ` +
      `Partial @ +${PARTIAL_CLOSE_ATR} ATR | ` +
      `Trailing @ ${TRAILING_DISTANCE_ATR} ATR (breakout: 0.8, trend: 1.0) | ` +
      `Time-stop ${BARS_PER_TIME_STOP} bars (${BARS_PER_TIME_STOP * 15}min) @ MFE<${TIME_STOP_MFE_ATR} ATR`
  );

  const positionPercent =
    getBalance() > 0
      ? (getPositionNotional() / getBalance()) * 100
      : 0;

  console.log(
    `[${new Date().toISOString()}] Position size: ${positionPercent.toFixed(0)}% of equity`
  );
  console.log(
    `[${new Date().toISOString()}] Starting equity: $${getBalance().toFixed(2)}\n`
  );

  notifyStartup({
    port: Number(process.env.PORT) || 3002,
    tradingPairs: [...TRADING_PAIRS],
    signalInterval: SIGNAL_CHECK_INTERVAL_MS / 1000,
    positionInterval: POSITION_CHECK_INTERVAL_MS / 1000
  });

  void checkSignals();

  signalCheckInterval = setInterval(() => {
    void checkSignals();
  }, SIGNAL_CHECK_INTERVAL_MS);

  void checkPositions();

  positionCheckInterval = setInterval(() => {
    void checkPositions();
  }, POSITION_CHECK_INTERVAL_MS);
}

export function stopScheduler() {
  console.log(`\n[${new Date().toISOString()}] 🛑 Stopping scheduler...`);

  if (signalCheckInterval) {
    clearInterval(signalCheckInterval);
    signalCheckInterval = null;
  }

  if (positionCheckInterval) {
    clearInterval(positionCheckInterval);
    positionCheckInterval = null;
  }

  console.log(`[${new Date().toISOString()}] Scheduler stopped\n`);
}
