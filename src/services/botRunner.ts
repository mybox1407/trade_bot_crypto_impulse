import { ATR } from 'technicalindicators';

import {
  getCandles,
  getMarketTimeframe,
  getTrades,
  getTradeFlowBaselineTracker
} from './exchange';

import {
  analyzeTradeFlow,
  type TradeFlowResult
} from './strategy';

import type {
  Candle,
  LighterTrade
} from './lighterWs';

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
  const timeframe = getMarketTimeframe(symbol) ?? '15m';
  const candles: Candle[] =
    getCandles(symbol, timeframe, 250);
  const atr = calculateAtr(candles);
  const baselineTracker =
    getTradeFlowBaselineTracker(symbol);

  return analyzeTradeFlow(symbol, trades, {
    now,
    atr,
    baselineTracker
  });
}

/**
 * Совместимость со старым route /bot.
 * Вход по-прежнему анализируется по потоку сделок.
 */
export function runBotOnce(
  symbol = 'BTC/USDT',
  _timeframe = '15m'
): TradeFlowResult {
  return runTradeFlowOnce(symbol);
}
