// src/services/scheduler.ts

import {
  ALL_TRADING_PAIRS,
  TRADING_PAIRS,
  setTradingPairs,
  SIGNAL_CHECK_INTERVAL_MS,
  POSITION_CHECK_INTERVAL_MS
} from '../config/constants';

import { runBotOnce } from './botRunner';

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
  getPositionById,
  setBalance
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
  getTradingFees,
  filterZeroFeePairs
} from './fees';

import { MexcAuthenticatedClient } from './mexcClient';

const mexcClient = new MexcAuthenticatedClient();

async function fetchMexcBalance(): Promise<{
  total: number;
  available: number;
}> {
  const account =
    await mexcClient.getFuturesAccount();

  const total =
    Number(account.total ?? 0);

  const available =
    Number(account.available ?? 0);

  if (
    !Number.isFinite(total) ||
    !Number.isFinite(available)
  ) {
    throw new Error(
      `Invalid Futures balance: total=${account.total}, ` +
      `available=${account.available}`
    );
  }

  console.log(
    `[${new Date().toISOString()}] 💼 ` +
    `MEXC Futures Balance: ` +
    `Total $${total.toFixed(2)}, ` +
    `Available $${available.toFixed(2)}, ` +
    `Unrealized PnL $${Number(
      account.unrealizedPnl ?? 0
    ).toFixed(2)}`
  );

  return {
    total,
    available
  };
}

async function getFuturesMarkPrice(
  symbol: string
): Promise<number> {
  const market =
    await mexcClient.getFuturesMarkPrice(symbol);

  const markPrice =
    Number(market.markPrice);

  if (
    !Number.isFinite(markPrice) ||
    markPrice <= 0
  ) {
    throw new Error(
      `Invalid Futures mark price for ${symbol}: ` +
      `${market.markPrice}`
    );
  }

  return markPrice;
}

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

let signalCheckInterval:
  NodeJS.Timeout | null = null;

let positionCheckInterval:
  NodeJS.Timeout | null = null;

let feeRefreshInterval:
  NodeJS.Timeout | null = null;

let signalCheckRunning = false;
let positionCheckRunning = false;
let isRunning = false;

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
const MIN_LOCKED_PERCENT = 0.25;

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
      const sideEmoji =
        position.side === 'long'
          ? '🟢'
          : '🔴';

      return [
        `${sideEmoji} ${position.symbol}: ` +
        `${position.side.toUpperCase()}`,
        `Entry ${formatPrice(position.entryPrice)}`,
        `TP ${formatPrice(position.takeProfitPrice)}`,
        `SL ${formatPrice(position.stopLossPrice)}`,
        `Qty ${position.quantity.toFixed(8)}`,
        `Notional $${position.notional.toFixed(2)}`,
        `Margin $${position.reservedCapital.toFixed(2)}`,
        `Entry fee $${position.entryFee.toFixed(4)}`
      ].join(' | ');
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
        result.status === 'no_signal' ||
        result.status === 'not_ready' ||
        result.status === 'error'
    );

  const signalsCount =
    signalResults.filter(
      result => result.status === 'signal'
    ).length;

  const noSignalCount =
    signalResults.filter(
      result =>
        result.status === 'no_signal' ||
        result.status === 'not_ready'
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
                `❌ ${result.symbol}: ERROR | ` +
                `${result.reason}`
              );
            }

            if (result.status === 'not_ready') {
              return (
                `⚠️ ${result.symbol}: NOT READY | ` +
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
                  ? ` @ ${formatPrice(result.price)}`
                  : '';

              return (
                `${emoji} ${result.symbol}: ` +
                `${result.regime} | ${side}${price} | ` +
                `${result.reason}`
              );
            }

            return (
              `⏳ ${result.symbol}: ${result.regime} | ` +
              `No signal | ${result.reason}`
            );
          })
          .join('\n')
      : 'No free symbols to analyze';

  const summaryMessage = [
    '📊 Signal Check Summary',
    '',
    `📌 Open positions: ` +
    `${openPositionsCount}/${MAX_PARALLEL_POSITIONS}`,
    formatOpenPositionsForTelegram(),
    '',
    `💼 Futures Equity: $${getBalance().toFixed(2)}`,
    `🔒 Reserved Margin: $${getReservedCapital().toFixed(2)}`,
    `💵 Available Margin: $${getAvailableBalance().toFixed(2)}`,
    '',
    '🔎 Signal scan',
    signalText,
    '',
    `Signals: ${signalsCount} | ` +
    `No signals: ${noSignalCount} | ` +
    `Open: ${openPositionsCount}/` +
    `${MAX_PARALLEL_POSITIONS} | ` +
    `Errors: ${errorCount}`,
    new Date().toISOString()
  ].join('\n');

  const shouldSendSummary =
    signalsCount > 0 ||
    errorCount > 0 ||
    activeResults.length > 0;

  if (!shouldSendSummary) {
    console.log(
      `[${new Date().toISOString()}] 📱 ` +
      'Telegram summary skipped — no active results'
    );

    return;
  }

  try {
    const telegramToken =
      process.env.TELEGRAM_BOT_TOKEN ?? '';

    const telegramChatId =
      process.env.TELEGRAM_CHAT_ID ?? '';

    if (!telegramToken || !telegramChatId) {
      console.warn(
        `[${new Date().toISOString()}] ⚠️ ` +
        'Telegram summary skipped — credentials missing'
      );

      return;
    }

    const url =
      `https://api.telegram.org/bot` +
      `${telegramToken}/sendMessage`;

    await axios.post(url, {
      chat_id: telegramChatId,
      text: summaryMessage
    });

    console.log(
      `[${new Date().toISOString()}] 📱 ` +
      'Telegram summary sent'
    );
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] ` +
      `Failed to send summary: ` +
      `${error instanceof Error ? error.message : 'Unknown'}`
    );
  }
}

async function notifyTradeClosed(trade: {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  notional: number;
  realizedPnL: number;
  netPnL: number;
  netPnLPercent: number;
  entryFee: number;
  exitFee: number;
  totalFee: number;
  reason: string;
  positionAgeSeconds: number;
  positionId: string;
}): Promise<void> {
  const emoji =
    trade.netPnL >= 0
      ? '✅'
      : '❌';

  const pnlEmoji =
    trade.netPnL >= 0
      ? '📈'
      : '📉';

  const sideEmoji =
    trade.side === 'long'
      ? '🟢'
      : '🔴';

  const reasonEmoji =
    trade.reason === 'take_profit'
      ? '🎯'
      : trade.reason === 'stop_loss'
        ? '🛑'
        : trade.reason === 'time_stop'
          ? '⏱️'
          : trade.reason === 'breakeven_stop'
            ? '🛡️'
            : trade.reason === 'dead_trade_mfe'
              ? '✂️'
              : '✋';

  const pnlSign =
    trade.netPnL >= 0
      ? '+'
      : '';

  const hours =
    Math.floor(
      trade.positionAgeSeconds / 3600
    );

  const minutes =
    Math.floor(
      (trade.positionAgeSeconds % 3600) / 60
    );

  const seconds =
    trade.positionAgeSeconds % 60;

  const duration =
    `${hours}h ${minutes}m ${seconds}s`;

  const text = [
    `${emoji} TRADE CLOSED ${emoji}`,
    '',
    `${sideEmoji} ${trade.symbol} ` +
    `${trade.side.toUpperCase()}`,
    '',
    `💰 Entry: $${trade.entryPrice.toFixed(8)}`,
    `💸 Exit: $${trade.exitPrice.toFixed(8)}`,
    `📊 Quantity: ${trade.quantity.toFixed(8)}`,
    `💵 Notional: $${trade.notional.toFixed(2)}`,
    '',
    `${pnlEmoji} PnL: ${pnlSign}$${trade.netPnL.toFixed(4)} ` +
    `(${pnlSign}${trade.netPnLPercent.toFixed(4)}%)`,
    `📈 Realized PnL: ` +
    `${pnlSign}$${trade.realizedPnL.toFixed(4)}`,
    '',
    '💰 Fees:',
    `├ Entry: $${trade.entryFee.toFixed(6)}`,
    `├ Exit: $${trade.exitFee.toFixed(6)}`,
    `└ Total: $${trade.totalFee.toFixed(6)}`,
    '',
    `${reasonEmoji} Reason: ` +
    `${trade.reason.replace(/_/g, ' ').toUpperCase()}`,
    `⏱ Duration: ${duration}`,
    `🆔 ID: ${trade.positionId}`,
    '',
    new Date().toISOString()
  ].join('\n');

  try {
    const telegramToken =
      process.env.TELEGRAM_BOT_TOKEN ?? '';

    const telegramChatId =
      process.env.TELEGRAM_CHAT_ID ?? '';

    if (!telegramToken || !telegramChatId) {
      return;
    }

    const url =
      `https://api.telegram.org/bot` +
      `${telegramToken}/sendMessage`;

    await axios.post(url, {
      chat_id: telegramChatId,
      text
    });

    console.log(
      `[${new Date().toISOString()}] 📱 ` +
      'Trade close notification sent'
    );
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] ` +
      `Failed to send close notification: ` +
      `${error instanceof Error ? error.message : 'Unknown'}`
    );
  }
}

function notifyClosedTradeFromResult(
  result: {
    lastClosedTrade?: {
      id: string;
      symbol: string;
      side: 'long' | 'short';
      entryPrice: number;
      exitPrice: number;
      quantity: number;
      notional: number;
      realizedPnL: number;
      netPnL: number;
      netPnLPercent: number;
      entryFee: number;
      exitFee: number;
      totalFee: number;
      reason: string;
      positionAgeSeconds: number;
    } | null;
  }
): void {
  const trade =
    result.lastClosedTrade;

  if (!trade) {
    return;
  }

  void notifyTradeClosed({
    symbol: trade.symbol,
    side: trade.side,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    quantity: trade.quantity,
    notional: trade.notional,
    realizedPnL: trade.realizedPnL,
    netPnL: trade.netPnL,
    netPnLPercent: trade.netPnLPercent,
    entryFee: trade.entryFee,
    exitFee: trade.exitFee,
    totalFee: trade.totalFee,
    reason: trade.reason,
    positionAgeSeconds:
      trade.positionAgeSeconds,
    positionId: trade.id
  });
}

async function initializeTradingPairs(): Promise<boolean> {
  console.log(
    `\n[${new Date().toISOString()}] ` +
    '========== FEE CHECK START =========='
  );

  console.log(
    `[${new Date().toISOString()}] ` +
    `Checking fees for ${ALL_TRADING_PAIRS.length} pairs...`
  );

  try {
    const allFees =
      await getTradingFees(ALL_TRADING_PAIRS);

    const zeroFeePairs =
      filterZeroFeePairs(allFees);

    if (zeroFeePairs.length === 0) {
      console.error(
        `[${new Date().toISOString()}] ❌ ` +
        'NO ZERO-FEE PAIRS FOUND — stopping bot'
      );

      await notifyError({
        context: 'initialization',
        symbol: 'ALL',
        error:
          'No zero-fee trading pairs available'
      });

      return false;
    }

    setTradingPairs(zeroFeePairs);

    console.log(
      `[${new Date().toISOString()}] ✅ ` +
      `Initialized with ${zeroFeePairs.length} zero-fee pairs`
    );

    return true;
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] 💥 ` +
      `Failed to initialize pairs: ` +
      `${
        error instanceof Error
          ? error.message
          : 'Unknown'
      }`
    );

    return false;
  } finally {
    console.log(
      `[${new Date().toISOString()}] ` +
      '========== FEE CHECK END ==========\n'
    );
  }
}

async function refreshTradingPairs(): Promise<void> {
  console.log(
    `\n[${new Date().toISOString()}] ` +
    '========== FEE REFRESH START =========='
  );

  try {
    const allFees =
      await getTradingFees(ALL_TRADING_PAIRS);

    const newZeroFeePairs =
      filterZeroFeePairs(allFees);

    if (newZeroFeePairs.length === 0) {
      console.error(
        `[${new Date().toISOString()}] ❌ ` +
        'NO ZERO-FEE PAIRS AFTER REFRESH — stopping bot'
      );

      await notifyError({
        context: 'fee_refresh',
        symbol: 'ALL',
        error:
          'No zero-fee trading pairs after refresh'
      });

      stopScheduler();
      return;
    }

    const pairsChanged =
      newZeroFeePairs.length !==
        TRADING_PAIRS.length ||
      newZeroFeePairs.some(
        (pair, index) =>
          pair !== TRADING_PAIRS[index]
      );

    if (pairsChanged) {
      console.log(
        `[${new Date().toISOString()}] 🔄 ` +
        `Trading pairs changed: ` +
        `${TRADING_PAIRS.length} → ` +
        `${newZeroFeePairs.length}`
      );

      setTradingPairs(newZeroFeePairs);

      const futuresBalance =
        await fetchMexcBalance();

      if (futuresBalance.total > 0) {
        setBalance(futuresBalance.total);
      }

      await notifyStartup({
        port: Number(process.env.PORT) || 3002,
        tradingPairs: newZeroFeePairs,
        signalInterval:
          SIGNAL_CHECK_INTERVAL_MS / 1000,
        positionInterval:
          POSITION_CHECK_INTERVAL_MS / 1000,
        balance: futuresBalance
      });
    } else {
      console.log(
        `[${new Date().toISOString()}] ✅ ` +
        `Trading pairs unchanged ` +
        `(${newZeroFeePairs.length})`
      );
    }
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] 💥 ` +
      `Failed to refresh pairs: ` +
      `${
        error instanceof Error
          ? error.message
          : 'Unknown'
      }`
    );
  } finally {
    console.log(
      `[${new Date().toISOString()}] ` +
      '========== FEE REFRESH END ==========\n'
    );
  }
}

async function checkSignals(): Promise<void> {
  if (!isRunning) {
    return;
  }

  if (signalCheckRunning) {
    console.warn(
      `[${new Date().toISOString()}] ⏭ ` +
      'SIGNAL CHECK SKIPPED — previous check is still running'
    );

    return;
  }

  signalCheckRunning = true;

  try {
    console.log(
      `\n[${new Date().toISOString()}] ` +
      '========== SIGNAL CHECK START =========='
    );

    console.log(
      `[${new Date().toISOString()}] ` +
      `Pairs: ${TRADING_PAIRS.length}, ` +
      `Open positions: ${getOpenPositionsCount()}/` +
      `${MAX_PARALLEL_POSITIONS}, ` +
      `Equity: $${getBalance().toFixed(2)}, ` +
      `Reserved: $${getReservedCapital().toFixed(2)}, ` +
      `Available: $${getAvailableBalance().toFixed(2)}`
    );

    const signalResults: SignalResult[] = [];

    for (const symbol of TRADING_PAIRS) {
      try {
        if (hasOpenPosition(symbol)) {
          signalResults.push({
            symbol,
            status: 'position_open',
            regime: 'position_open',
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
            status: 'max_positions',
            regime: 'max_positions',
            hasSignal: false,
            reason:
              `Max positions reached ` +
              `(${MAX_PARALLEL_POSITIONS})`
          });

          continue;
        }

        const result =
          await runBotOnce(symbol, '15m');

        if (!result.ready) {
          const reason =
            result.reason ??
            'Strategy result is not ready';

          signalResults.push({
            symbol,
            status: 'not_ready',
            regime: 'unknown',
            hasSignal: false,
            reason
          });

          continue;
        }

        const buy =
          Boolean((result as any).buy);

        const sell =
          Boolean((result as any).sell);

        const side =
          (result as any).side as
          | 'long'
          | 'short'
          | 'none';

        const price =
          Number((result as any).price);

        const takeProfitPrice =
          Number(
            (result as any).takeProfitPrice
          );

        const stopLossPrice =
          Number(
            (result as any).stopLossPrice
          );

        const positionSize =
          Number(
            (result as any).positionSize
          );

        const regime =
          String(
            (result as any).regime ?? 'unknown'
          );

        const indicators =
          (result as any).indicators as any;

        const skipReason =
          (result as any).skipReason as
          | string
          | null;

        if (skipReason) {
          logSignalCheck({
            timestamp: new Date().toISOString(),
            symbol,
            timeframe: '15m',
            side: 'none',
            price: Number.isFinite(price)
              ? price
              : 0,
            regime,
            takeProfitPrice: null,
            stopLossPrice: null,
            positionSize: null,
            macdCrossUp:
              indicators?.macdCrossUp ?? false,
            macdCrossDown:
              indicators?.macdCrossDown ?? false,
            lastRsi:
              indicators?.lastRsi ?? 0,
            lastAtr:
              indicators?.lastAtr ?? 0,
            rsiBull:
              indicators?.rsiBull ?? false,
            rsiBear:
              indicators?.rsiBear ?? false,
            bbUpper:
              indicators?.bbUpper ?? 0,
            bbMiddle:
              indicators?.bbMiddle ?? 0,
            bbLower:
              indicators?.bbLower ?? 0,
            adx:
              indicators?.regimeIndicators?.adx ?? 0,
            adxRising:
              indicators?.regimeIndicators?.adxRising ??
              false,
            ema20:
              indicators?.regimeIndicators?.ema20 ?? 0,
            ema50:
              indicators?.regimeIndicators?.ema50 ?? 0,
            ema200:
              indicators?.regimeIndicators?.ema200 ?? 0,
            bbWidth:
              indicators?.regimeIndicators?.bbWidth ?? 0,
            atrPct:
              indicators?.regimeIndicators?.atrPct ?? 0,
            signalTriggered: false,
            positionOpened: false
          });

          signalResults.push({
            symbol,
            status: 'no_signal',
            regime,
            hasSignal: false,
            reason: skipReason
          });

          continue;
        }

        if (buy && sell) {
          signalResults.push({
            symbol,
            status: 'error',
            regime,
            hasSignal: true,
            side: 'none',
            price,
            reason:
              'Invalid strategy result: buy and sell are both true'
          });

          continue;
        }

        if (buy || sell) {
          if (
            side !== 'long' &&
            side !== 'short'
          ) {
            signalResults.push({
              symbol,
              status: 'error',
              regime,
              hasSignal: true,
              side: 'none',
              price,
              reason: 'Signal side is invalid'
            });

            continue;
          }

          if (
            !Number.isFinite(price) ||
            price <= 0
          ) {
            signalResults.push({
              symbol,
              status: 'error',
              regime,
              hasSignal: true,
              side,
              price,
              reason:
                `Invalid signal price: ${price}`
            });

            continue;
          }

          if (
            !Number.isFinite(takeProfitPrice) ||
            !Number.isFinite(stopLossPrice) ||
            takeProfitPrice <= 0 ||
            stopLossPrice <= 0
          ) {
            signalResults.push({
              symbol,
              status: 'error',
              regime,
              hasSignal: true,
              side,
              price,
              reason:
                'Invalid take-profit or stop-loss price'
            });

            continue;
          }

          const levelsAreValid =
            side === 'long'
              ? stopLossPrice < price &&
                takeProfitPrice > price
              : stopLossPrice > price &&
                takeProfitPrice < price;

          if (!levelsAreValid) {
            signalResults.push({
              symbol,
              status: 'error',
              regime,
              hasSignal: true,
              side,
              price,
              reason:
                'Stop-loss and take-profit are invalid ' +
                'for position side'
            });

            continue;
          }

          const riskCapital =
            getRiskCapital();

          const maxNotionalByPercent =
            getPositionNotional();

          const stopDistance =
            Math.abs(
              price - stopLossPrice
            );

          const worstCaseFeePerUnit =
            (price + stopLossPrice) *
            TRADE_FEE_RATE;

          const totalRiskPerUnit =
            stopDistance +
            worstCaseFeePerUnit;

          if (
            !Number.isFinite(riskCapital) ||
            riskCapital <= 0 ||
            !Number.isFinite(stopDistance) ||
            stopDistance <= 0 ||
            !Number.isFinite(totalRiskPerUnit) ||
            totalRiskPerUnit <= 0
          ) {
            signalResults.push({
              symbol,
              status: 'error',
              regime,
              hasSignal: true,
              side,
              price,
              reason:
                'Invalid risk calculation inputs'
            });

            continue;
          }

          const calculatedQuantity =
            riskCapital /
            totalRiskPerUnit;

          if (
            !Number.isFinite(calculatedQuantity) ||
            calculatedQuantity <= 0
          ) {
            signalResults.push({
              symbol,
              status: 'error',
              regime,
              hasSignal: true,
              side,
              price,
              reason:
                'Calculated quantity is invalid'
            });

            continue;
          }

          const openResult =
            await openPosition({
              symbol,
              side,
              entryPrice: price,
              takeProfitPrice,
              stopLossPrice,
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
                  indicators?.regimeIndicators?.adx ?? 0,
                bbWidth:
                  indicators?.regimeIndicators?.bbWidth ?? 0,
                atrPct:
                  indicators?.regimeIndicators?.atrPct ?? 0,
                ema20:
                  indicators?.regimeIndicators?.ema20 ?? 0,
                ema50:
                  indicators?.regimeIndicators?.ema50 ?? 0,
                ema200:
                  indicators?.regimeIndicators?.ema200 ?? 0,
                entryExtensionAtr:
                  indicators?.entryExtensionAtr ?? 0,
                maxEntryExtensionAtr:
                  indicators?.maxEntryExtensionAtr ?? 0,
                entryTooExtended:
                  indicators?.entryTooExtended ?? false
              },
              riskCapital,
              maxNotionalByPercent,
              stopDistance,
              totalRiskPerUnit,
              calculatedQuantity
            });

          if (
            openResult.ok &&
            openResult.position
          ) {
            console.log(
              `[${new Date().toISOString()}] ✅ ` +
              `${symbol}: POSITION OPENED`
            );

            console.log(
              `   Position ID: ` +
              `${openResult.position.id}`
            );

            console.log(
              `   Quantity: ` +
              `${openResult.position.quantity.toFixed(8)}`
            );

            console.log(
              `   Notional: $` +
              `${openResult.position.notional.toFixed(2)}`
            );

            console.log(
              `   Equity: $` +
              `${(
                openResult.balance ??
                getBalance()
              ).toFixed(2)}`
            );

            console.log(
              `   Reserved margin: $` +
              `${openResult.reservedCapitalAfter.toFixed(2)}`
            );

            console.log(
              `   Available margin: $` +
              `${openResult.availableBalanceAfter.toFixed(2)}`
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
            signalResults.push({
              symbol,
              status: 'signal',
              regime,
              hasSignal: true,
              side,
              price,
              reason:
                openResult.message ??
                'Unknown error'
            });
          }
        } else {
          let signalReason =
            'Unknown regime';

          if (regime === 'high_volatility') {
            signalReason =
              `High volatility (ATR%: ` +
              `${
                indicators
                  ?.regimeIndicators
                  ?.atrPct
                  ?.toFixed(4)
              })`;
          } else if (regime === 'range') {
            signalReason =
              `Range (ADX: ` +
              `${
                indicators
                  ?.regimeIndicators
                  ?.adx
                  ?.toFixed(2)
              })`;
          } else if (regime === 'trend_up') {
            const reasons: string[] = [];

            if (
              !indicators?.macdCrossUp &&
              !indicators?.macdCrossDown
            ) {
              reasons.push('No MACD cross');
            }

            if (!indicators?.rsiBull) {
              reasons.push(
                `RSI not bull ` +
                `(${indicators?.lastRsi?.toFixed(2)})`
              );
            }

            if (
              price <=
              (
                indicators
                  ?.regimeIndicators
                  ?.ema200 ?? 0
              )
            ) {
              reasons.push(
                'Price below EMA200'
              );
            }

            signalReason =
              reasons.join(', ') ||
              'Trend up - trades disabled';
          } else if (regime === 'trend_down') {
            const reasons: string[] = [];

            if (
              !indicators?.macdCrossUp &&
              !indicators?.macdCrossDown
            ) {
              reasons.push('No MACD cross');
            }

            if (!indicators?.rsiBear) {
              reasons.push(
                `RSI not bear ` +
                `(${indicators?.lastRsi?.toFixed(2)})`
              );
            }

            if (
              price >=
              (
                indicators
                  ?.regimeIndicators
                  ?.ema200 ?? 0
              )
            ) {
              reasons.push(
                'Price above EMA200'
              );
            }

            signalReason =
              reasons.join(', ') ||
              'No MACD cross down';
          } else if (
            regime === 'breakout_watch'
          ) {
            signalReason =
              'Waiting for BB breakout';
          }

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
          side:
            buy || sell
              ? side
              : 'none',
          price: Number.isFinite(price)
            ? price
            : 0,
          regime,
          takeProfitPrice:
            Number.isFinite(takeProfitPrice)
              ? takeProfitPrice
              : null,
          stopLossPrice:
            Number.isFinite(stopLossPrice)
              ? stopLossPrice
              : null,
          positionSize:
            Number.isFinite(positionSize)
              ? positionSize
              : null,
          macdCrossUp:
            indicators?.macdCrossUp ?? false,
          macdCrossDown:
            indicators?.macdCrossDown ?? false,
          lastRsi:
            indicators?.lastRsi ?? 0,
          lastAtr:
            indicators?.lastAtr ?? 0,
          rsiBull:
            indicators?.rsiBull ?? false,
          rsiBear:
            indicators?.rsiBear ?? false,
          bbUpper:
            indicators?.bbUpper ?? 0,
          bbMiddle:
            indicators?.bbMiddle ?? 0,
          bbLower:
            indicators?.bbLower ?? 0,
          adx:
            indicators?.regimeIndicators?.adx ?? 0,
          adxRising:
            indicators?.regimeIndicators?.adxRising ??
            false,
          ema20:
            indicators?.regimeIndicators?.ema20 ?? 0,
          ema50:
            indicators?.regimeIndicators?.ema50 ?? 0,
          ema200:
            indicators?.regimeIndicators?.ema200 ?? 0,
          bbWidth:
            indicators?.regimeIndicators?.bbWidth ?? 0,
          atrPct:
            indicators?.regimeIndicators?.atrPct ?? 0,
          signalTriggered:
            buy || sell,
          positionOpened:
            signalResults.some(
              item =>
                item.symbol === symbol &&
                item.reason === 'Position opened'
            )
        });
      } catch (error) {
        const errorMsg =
          error instanceof Error
            ? error.message
            : 'Unknown error';

        console.error(
          `[${new Date().toISOString()}] 💥 ` +
          `${symbol}: ERROR - ${errorMsg}`
        );

        logError({
          timestamp: new Date().toISOString(),
          context: 'signal_check',
          symbol,
          error: String(errorMsg),
          stack: undefined
        });

        void notifyError({
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
      `[${new Date().toISOString()}] ` +
      '========== SIGNAL CHECK END ==========\n'
    );
  } finally {
    signalCheckRunning = false;
  }
}

async function checkPositions(): Promise<void> {
  if (!isRunning) {
    return;
  }

  if (positionCheckRunning) {
    console.warn(
      `[${new Date().toISOString()}] ⏭ ` +
      'POSITION CHECK SKIPPED — previous check is still running'
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
      `\n[${new Date().toISOString()}] ` +
      '========== POSITION CHECK START =========='
    );

    console.log(
      `[${new Date().toISOString()}] ` +
      `Checking ${positions.length} position(s)...`
    );

    for (const position of positions) {
      try {
        if (!hasOpenPosition(position.symbol)) {
          continue;
        }

        const currentPrice =
          await getFuturesMarkPrice(
            position.symbol
          );

        let unrealizedPnL =
          position.side === 'long'
            ? (
                currentPrice -
                position.entryPrice
              ) * position.quantity
            : (
                position.entryPrice -
                currentPrice
              ) * position.quantity;

        let unrealizedPnLPercent =
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
          new Date(position.openedAt).getTime();

        const positionAgeSeconds =
          Number.isFinite(openedAt)
            ? Math.max(
                0,
                Math.floor(
                  (Date.now() - openedAt) /
                  1000
                )
              )
            : 0;

        let partialClosed =
          position.metadata
            ?.partialClosed ??
          false;

        let trailingActive =
          position.metadata
            ?.trailingActive ??
          false;

        let beTriggered =
          position.metadata
            ?.beTriggered ??
          false;

        if (
          !beTriggered &&
          maxUnrealizedPnLPercent >=
            BE_THRESHOLD_PERCENT
        ) {
          const lockedPercent =
            MIN_LOCKED_PERCENT +
            (
              maxUnrealizedPnLPercent -
              BE_THRESHOLD_PERCENT
            ) * LOCK_RATIO;

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
            const updated =
              updatePositionStopLoss(
                position.id,
                nextStop
              );

            if (!updated) {
              throw new Error(
                `Failed to update ratchet stop for ` +
                `${position.id}`
              );
            }

            position.stopLossPrice =
              nextStop;

            beTriggered = true;

            updatePositionMetadata(
              position.id,
              {
                beTriggered: true,
                trailingStopPrice: nextStop
              }
            );

            console.log(
              `[${new Date().toISOString()}] 🛡 ` +
              `${position.symbol}: RATCHET SL @ ` +
              `${formatPrice(nextStop)} | ` +
              `MFE ${maxUnrealizedPnLPercent.toFixed(2)}% | ` +
              `lock ${lockedPercent.toFixed(2)}%`
            );
          }
        }

        if (
          !partialClosed &&
          maxUnrealizedPnLPercent >=
            PARTIAL_THRESHOLD_PERCENT
        ) {
          const quantityBeforePartial =
            position.quantity;

          const closeQuantity =
            quantityBeforePartial * 0.5;

          const partialResult =
            await partialClosePosition(
              position.id,
              closeQuantity,
              currentPrice
            );

          if (!partialResult.ok) {
            throw new Error(
              `Partial close failed for ` +
              `${position.symbol}: ` +
              `${partialResult.message}`
            );
          }

          const remainingPosition =
            getPositionById(position.id);

          if (!remainingPosition) {
            throw new Error(
              `Position ${position.id} not found ` +
              `after partial close`
            );
          }

          const trailDistance =
            currentPrice *
            (TRAILING_DISTANCE_PERCENT / 100);

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

          const updated =
            updatePositionStopLoss(
              remainingPosition.id,
              initialTrailingStop
            );

          if (!updated) {
            throw new Error(
              `Failed to initialize trailing stop ` +
              `for ${position.id}`
            );
          }

          updatePositionMetadata(
            position.id,
            {
              partialClosed: true,
              trailingActive: true,
              trailingStopPrice:
                initialTrailingStop
            }
          );

          position.quantity =
            remainingPosition.quantity;

          position.notional =
            remainingPosition.notional;

          position.reservedCapital =
            remainingPosition.reservedCapital;

          position.entryFee =
            remainingPosition.entryFee;

          position.stopLossPrice =
            initialTrailingStop;

          position.metadata =
            remainingPosition.metadata;

          partialClosed = true;
          trailingActive = true;

          unrealizedPnL =
            position.side === 'long'
              ? (
                  currentPrice -
                  position.entryPrice
                ) * position.quantity
              : (
                  position.entryPrice -
                  currentPrice
                ) * position.quantity;

          unrealizedPnLPercent =
            position.notional > 0
              ? (
                  unrealizedPnL /
                  position.notional
                ) * 100
              : 0;

          console.log(
            `[${new Date().toISOString()}] 📉 ` +
            `${position.symbol}: PARTIAL CLOSE 50% ` +
            `(${closeQuantity.toFixed(8)}) @ ` +
            `${formatPrice(currentPrice)} | ` +
            `PnL $${partialResult.netPnL.toFixed(4)}`
          );

          console.log(
            `[${new Date().toISOString()}] 🪢 ` +
            `${position.symbol}: TRAILING ON @ ` +
            `${formatPrice(initialTrailingStop)}`
          );
        }

        if (
          DEAD_TRADE_ENABLED &&
          !partialClosed &&
          !beTriggered &&
          positionAgeSeconds >=
            DEAD_TRADE_CHECK_AFTER_SEC
        ) {
          const entryAtr =
            position.metadata?.lastAtr ?? 0;

          const mfeAtr =
            entryAtr > 0 &&
            position.quantity > 0
              ? maxUnrealizedPnL /
                (
                  entryAtr *
                  position.quantity
                )
              : 0;

          if (
            mfeAtr <
            DEAD_TRADE_MIN_MFE_ATR
          ) {
            const result =
              await closePosition(
                position.id,
                currentPrice,
                'dead_trade_mfe'
              );

            if (!result.ok) {
              throw new Error(
                `Failed to dead-trade-close ` +
                `${position.symbol}: ` +
                `${result.message}`
              );
            }

            console.log(
              `[${new Date().toISOString()}] ✂️ ` +
              `${position.symbol}: DEAD TRADE | ` +
              `MFE ${mfeAtr.toFixed(2)} ATR | ` +
              `Net $${(
                result.lastClosedTrade
                  ?.netPnL ?? 0
              ).toFixed(4)}`
            );

            notifyClosedTradeFromResult(result);
            continue;
          }
        }

        if (
          !partialClosed &&
          !beTriggered &&
          positionAgeSeconds >=
            TIME_STOP_SECONDS &&
          maxUnrealizedPnLPercent <
            TIME_STOP_MFE_PERCENT &&
          unrealizedPnLPercent >
            TIME_STOP_MAX_LOSS_PERCENT
        ) {
          const result =
            await closePosition(
              position.id,
              currentPrice,
              'time_stop'
            );

          if (!result.ok) {
            throw new Error(
              `Failed to time-stop ` +
              `${position.symbol}: ` +
              `${result.message}`
            );
          }

          console.log(
            `[${new Date().toISOString()}] ⏱ ` +
            `${position.symbol}: TIME STOP | ` +
            `MFE ${maxUnrealizedPnLPercent.toFixed(2)}% | ` +
            `Net $${(
              result.lastClosedTrade
                ?.netPnL ?? 0
            ).toFixed(4)}`
          );

          notifyClosedTradeFromResult(result);
          continue;
        }

        if (
          trailingActive ||
          partialClosed
        ) {
          const statePosition =
            getPositionById(position.id);

          if (!statePosition) {
            continue;
          }

          const priorTrailingStop =
            statePosition.metadata
              ?.trailingStopPrice ??
            statePosition.stopLossPrice;

          const trailDistance =
            currentPrice *
            (TRAILING_DISTANCE_PERCENT / 100);

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

          if (
            nextTrailingStop !==
            statePosition.stopLossPrice
          ) {
            const updated =
              updatePositionStopLoss(
                statePosition.id,
                nextTrailingStop
              );

            if (!updated) {
              throw new Error(
                `Failed to update trailing stop ` +
                `for ${statePosition.id}`
              );
            }

            updatePositionMetadata(
              position.id,
              {
                trailingActive: true,
                trailingStopPrice:
                  nextTrailingStop
              }
            );

            position.stopLossPrice =
              nextTrailingStop;

            console.log(
              `[${new Date().toISOString()}] 🔁 ` +
              `${position.symbol}: TRAILING SL @ ` +
              `${formatPrice(nextTrailingStop)}`
            );
          }
        }

        const activePosition =
          getPositionById(position.id);

        if (!activePosition) {
          continue;
        }

        position.stopLossPrice =
          activePosition.stopLossPrice;

        position.quantity =
          activePosition.quantity;

        position.notional =
          activePosition.notional;

        position.reservedCapital =
          activePosition.reservedCapital;

        position.entryFee =
          activePosition.entryFee;

        position.metadata =
          activePosition.metadata;

        const distanceToTP =
          position.side === 'long'
            ? position.takeProfitPrice -
              currentPrice
            : currentPrice -
              position.takeProfitPrice;

        const distanceToTPPercent =
          currentPrice > 0
            ? (
                distanceToTP /
                currentPrice
              ) * 100
            : 0;

        const distanceToSL =
          position.side === 'long'
            ? currentPrice -
              position.stopLossPrice
            : position.stopLossPrice -
              currentPrice;

        const distanceToSLPercent =
          currentPrice > 0
            ? (
                distanceToSL /
                currentPrice
              ) * 100
            : 0;

        const hitTakeProfit =
          position.side === 'long'
            ? currentPrice >=
              position.takeProfitPrice
            : currentPrice <=
              position.takeProfitPrice;

        const hitStopLoss =
          position.side === 'long'
            ? currentPrice <=
              position.stopLossPrice
            : currentPrice >=
              position.stopLossPrice;

        console.log(
          `\n[${new Date().toISOString()}] 📊 ` +
          `${position.symbol} ` +
          `(${position.side.toUpperCase()}):`
        );

        console.log(
          `   Entry: ` +
          `${formatPrice(position.entryPrice)}, ` +
          `Mark: ${formatPrice(currentPrice)}`
        );

        console.log(
          `   TP: ` +
          `${formatPrice(position.takeProfitPrice)}, ` +
          `SL: ${formatPrice(position.stopLossPrice)}`
        );

        console.log(
          `   Unrealized: $${unrealizedPnL.toFixed(4)} ` +
          `(${unrealizedPnLPercent.toFixed(4)}%) | ` +
          `MFE: ` +
          `${maxUnrealizedPnLPercent.toFixed(4)}%`
        );

        if (hitTakeProfit) {
          const result =
            await closePosition(
              position.id,
              currentPrice,
              'take_profit'
            );

          if (!result.ok) {
            throw new Error(
              `Failed to close TP ` +
              `for ${position.symbol}: ` +
              `${result.message}`
            );
          }

          console.log(
            `[${new Date().toISOString()}] 🎯 ` +
            `${position.symbol}: CLOSED AT TP | ` +
            `Net $${(
              result.lastClosedTrade
                ?.netPnL ?? 0
            ).toFixed(4)}`
          );

          notifyClosedTradeFromResult(result);
          continue;
        }

        if (hitStopLoss) {
          const result =
            await closePosition(
              position.id,
              currentPrice,
              beTriggered
                ? 'breakeven_stop'
                : 'stop_loss'
            );

          if (!result.ok) {
            throw new Error(
              `Failed to close SL ` +
              `for ${position.symbol}: ` +
              `${result.message}`
            );
          }

          console.log(
            `[${new Date().toISOString()}] 🛑 ` +
            `${position.symbol}: CLOSED AT ` +
            `${beTriggered ? 'BE' : 'STOP'} | ` +
            `Net $${(
              result.lastClosedTrade
                ?.netPnL ?? 0
            ).toFixed(4)}`
          );

          notifyClosedTradeFromResult(result);
          continue;
        }

        console.log(
          `[${new Date().toISOString()}] ⏳ ` +
          `${position.symbol}: HOLDING`
        );

        logPositionCheck({
          timestamp: new Date().toISOString(),
          positionId: position.id,
          symbol: position.symbol,
          side: position.side,
          entryPrice: position.entryPrice,
          currentPrice,
          takeProfitPrice:
            position.takeProfitPrice,
          stopLossPrice:
            position.stopLossPrice,
          unrealizedPnL,
          unrealizedPnLPercent,
          distanceToTP,
          distanceToTPPercent,
          distanceToSL,
          distanceToSLPercent,
          hitTakeProfit: false,
          hitStopLoss: false,
          action: 'hold',
          positionAgeSeconds
        });
      } catch (error) {
        const errorMsg =
          error instanceof Error
            ? error.message
            : 'Unknown error';

        console.error(
          `[${new Date().toISOString()}] 💥 ` +
          `${position.symbol}: ERROR - ${errorMsg}`
        );

        logError({
          timestamp: new Date().toISOString(),
          context: 'position_check',
          symbol: position.symbol,
          positionId: position.id,
          error: String(errorMsg),
          stack: undefined
        });

        void notifyError({
          context: 'position_check',
          symbol: position.symbol,
          error: errorMsg
        });
      }
    }

    console.log(
      `[${new Date().toISOString()}] ` +
      '========== POSITION CHECK END ==========\n'
    );
  } finally {
    positionCheckRunning = false;
  }
}

export async function startScheduler(): Promise<void> {
  console.log(
    `\n[${new Date().toISOString()}] 🚀 ` +
    'TRADING BOT STARTING...'
  );

  const initialized =
    await initializeTradingPairs();

  if (!initialized) {
    console.error(
      `[${new Date().toISOString()}] ❌ ` +
      'Initialization failed — bot will not start'
    );

    return;
  }

  let mexcBalance:
    | { total: number; available: number }
    | undefined;

  try {
    mexcBalance =
      await fetchMexcBalance();

    if (mexcBalance.total > 0) {
      setBalance(mexcBalance.total);
    }
  } catch (error) {
    console.warn(
      `[${new Date().toISOString()}] ⚠️ ` +
      `Failed to fetch MEXC Futures balance: ` +
      `${
        error instanceof Error
          ? error.message
          : 'Unknown'
      }`
    );
  }

  isRunning = true;

  console.log(
    `[${new Date().toISOString()}] Port: ` +
    `${Number(process.env.PORT) || 3002}`
  );

  console.log(
    `[${new Date().toISOString()}] Signal check interval: ` +
    `${SIGNAL_CHECK_INTERVAL_MS / 1000}s`
  );

  console.log(
    `[${new Date().toISOString()}] Position check interval: ` +
    `${POSITION_CHECK_INTERVAL_MS / 1000}s`
  );

  console.log(
    `[${new Date().toISOString()}] Trading pairs: ` +
    `${[...TRADING_PAIRS].join(', ')}`
  );

  console.log(
    `[${new Date().toISOString()}] Max positions: ` +
    `${MAX_PARALLEL_POSITIONS}`
  );

  const positionPercent =
    getBalance() > 0
      ? (
          getPositionNotional() /
          getBalance()
        ) * 100
      : 0;

  console.log(
    `[${new Date().toISOString()}] Position size: ` +
    `${positionPercent.toFixed(0)}% of equity`
  );

  console.log(
    `[${new Date().toISOString()}] Starting Futures equity: ` +
    `$${getBalance().toFixed(2)}`
  );

  if (mexcBalance) {
    console.log(
      `[${new Date().toISOString()}] MEXC Futures Balance: ` +
      `$${mexcBalance.total.toFixed(2)} ` +
      `(Available: $${mexcBalance.available.toFixed(2)})`
    );
  }

  await notifyStartup({
    port: Number(process.env.PORT) || 3002,
    tradingPairs: [...TRADING_PAIRS],
    signalInterval:
      SIGNAL_CHECK_INTERVAL_MS / 1000,
    positionInterval:
      POSITION_CHECK_INTERVAL_MS / 1000,
    balance: mexcBalance
  });

  void checkSignals();

  signalCheckInterval =
    setInterval(() => {
      void checkSignals();
    }, SIGNAL_CHECK_INTERVAL_MS);

  void checkPositions();

  positionCheckInterval =
    setInterval(() => {
      void checkPositions();
    }, POSITION_CHECK_INTERVAL_MS);

  feeRefreshInterval =
    setInterval(() => {
      void refreshTradingPairs();
    }, 24 * 60 * 60 * 1000);

  console.log(
    `[${new Date().toISOString()}] ✅ ` +
    'Bot started successfully\n'
  );
}

export function stopScheduler(): void {
  console.log(
    `\n[${new Date().toISOString()}] 🛑 ` +
    'Stopping scheduler...'
  );

  isRunning = false;

  if (signalCheckInterval) {
    clearInterval(signalCheckInterval);
    signalCheckInterval = null;
  }

  if (positionCheckInterval) {
    clearInterval(positionCheckInterval);
    positionCheckInterval = null;
  }

  if (feeRefreshInterval) {
    clearInterval(feeRefreshInterval);
    feeRefreshInterval = null;
  }

  console.log(
    `[${new Date().toISOString()}] Scheduler stopped\n`
  );
}
