import { ATR } from 'technicalindicators';

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

const FILTER_CANDLE_LIMIT = 700;
const SLTP_CANDLE_LIMIT = 250;
const DEFAULT_TIMEFRAME = '1m';
const SLTP_TIMEFRAME = '15m';
const ATR_PERIOD = 14;

function calculateAtrSma(candles: Candle[], period = ATR_PERIOD): number | null {
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

function calculateAtrWilder(candles: Candle[], period = ATR_PERIOD): number | null {
  if (candles.length < period + 1) {
    return null;
  }

  const atrValues = ATR.calculate({
    period,
    high: candles.map(candle => candle.high),
    low: candles.map(candle => candle.low),
    close: candles.map(candle => candle.close)
  });

  const atr = atrValues[atrValues.length - 1];

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

  // Фильтры v6.41 — строго 1m свечи и SMA ATR, как в скрипте.
  const filterCandles: Candle[] = getCandles(symbol, DEFAULT_TIMEFRAME, FILTER_CANDLE_LIMIT);
  const filterAtr = calculateAtrSma(filterCandles);

  // SL/TP — 15m свечи и Wilder ATR, как в ранней версии бота.
  const slTpCandles: Candle[] = getCandles(symbol, SLTP_TIMEFRAME, SLTP_CANDLE_LIMIT);
  const slTpAtr = calculateAtrWilder(slTpCandles);

  const baselineTracker = getTradeFlowBaselineTracker(symbol);
  const tradeHistory = getTradeHistory(symbol);

  return analyzeTradeFlow(symbol, trades, {
    now,
    atr: filterAtr,
    slTpAtr,
    candles: filterCandles,
    tradeHistory,
    baselineTracker
  });
}

/**
 * Совместимость со старым route /bot.
 */
export function runBotOnce(
  symbol = 'BTC/USDT',
  _timeframe = '1m'
): TradeFlowResult {
  return runTradeFlowOnce(symbol);
}
