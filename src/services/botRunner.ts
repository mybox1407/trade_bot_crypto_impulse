import {
  getCandles,
  getMarketTimeframe,
  getTrades,
  getTradeFlowBaselineTracker,
  getTradeHistory
} from './exchange';

import {
  analyzeTradeFlow,
  type TradeFlowResult
} from './strategy';

import type {
  Candle,
  LighterTrade
} from './lighterWs';

const CANDLE_LIMIT = 700;
const DEFAULT_TIMEFRAME = '1m';
const ATR_PERIOD = 14;

function calculateAtr(candles: Candle[], period = ATR_PERIOD): number | null {
  if (candles.length < period + 1) {
    return null;
  }

  const trueRanges: number[] = [];

  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const previousClose = candles[i - 1].close;

    trueRanges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previousClose),
      Math.abs(current.low - previousClose)
    ));
  }

  const window = trueRanges.slice(-period);

  if (window.length < period) {
    return null;
  }

  const atr = window.reduce((sum, value) => sum + value, 0) / period;

  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

/**
 * Анализирует текущий rolling-буфер сделок.
 * Вызывать из обработчика новой WebSocket-сделки.
 */
export function runTradeFlowOnce(
  symbol: string,
  now = Date.now()
): TradeFlowResult {
  const trades: LighterTrade[] = getTrades(symbol);
  const timeframe = getMarketTimeframe(symbol) ?? DEFAULT_TIMEFRAME;
  const candles: Candle[] = getCandles(symbol, timeframe, CANDLE_LIMIT);
  const atr = calculateAtr(candles);
  const baselineTracker = getTradeFlowBaselineTracker(symbol);
  const tradeHistory = getTradeHistory(symbol);

  return analyzeTradeFlow(symbol, trades, {
    now,
    atr,
    candles,
    tradeHistory,
    baselineTracker
  });
}

/**
 * Совместимость со старым route /bot.
 * Вход по-прежнему анализируется по потоку сделок.
 */
export function runBotOnce(
  symbol = 'BTC/USDT',
  _timeframe = '1m'
): TradeFlowResult {
  return runTradeFlowOnce(symbol);
}
