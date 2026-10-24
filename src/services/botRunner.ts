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

const CANDLE_LIMIT = 700;
const DEFAULT_TIMEFRAME = '1m';

function calculateAtr(candles: Candle[]): number | null {
  if (candles.length < 15) {
    return null;
  }

  const atrValues = ATR.calculate({
    period: 14,
    high: candles.map(candle => candle.high),
    low: candles.map(candle => candle.low),
    close: candles.map(candle => candle.close)
  });

  const atr = atrValues[atrValues.length - 1];

  return Number.isFinite(atr) && atr > 0
    ? atr
    : null;
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
