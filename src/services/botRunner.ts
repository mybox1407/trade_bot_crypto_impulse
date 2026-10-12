import { ATR } from 'technicalindicators';

import {
  getCandles,
  getTrades
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
  const candles: Candle[] = getCandles(symbol, '1m', 250);
  const atr = calculateAtr(candles);

  return analyzeTradeFlow(symbol, trades, {
    now,
    atr
  });
}
