import { ATR } from 'technicalindicators';

import {
  getCandles,
  getMarketTimeframe,
  getTrades,
  getTradeFlowBaselineTracker
} from './exchange';

import {
  analyzeTradeFlow,
  CANDLE_BODY_MIN_RATIO,
  CANDLE_DIR_FILTER_ENABLED,
  CANDLE_WICK_MAX_RATIO,
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
 * Фильтр подтверждающей 15m-свечи:
 * направление, доля тела и размер теней.
 */
function passesCandleFilter(
  candles: Candle[],
  side: 'long' | 'short'
): { pass: boolean; reason: string | null } {
  if (!CANDLE_DIR_FILTER_ENABLED) {
    return { pass: true, reason: null };
  }

  const candle = candles[candles.length - 1];

  if (!candle) {
    return { pass: false, reason: 'No candle data' };
  }

  const range = candle.high - candle.low;

  if (range <= 0) {
    return { pass: false, reason: 'Zero candle range' };
  }

  const candleDir = candle.close > candle.open ? 1 : -1;
  const tradeDir = side === 'long' ? 1 : -1;

  if (candleDir !== tradeDir) {
    return { pass: false, reason: 'Candle direction mismatch' };
  }

  const bodyRatio =
    Math.abs(candle.close - candle.open) / range;

  const upperWick =
    (candle.high - Math.max(candle.open, candle.close)) / range;

  const lowerWick =
    (Math.min(candle.open, candle.close) - candle.low) / range;

  if (bodyRatio < CANDLE_BODY_MIN_RATIO) {
    return {
      pass: false,
      reason: `Body too small: ${bodyRatio.toFixed(3)}`
    };
  }

  if (
    upperWick > CANDLE_WICK_MAX_RATIO ||
    lowerWick > CANDLE_WICK_MAX_RATIO
  ) {
    return {
      pass: false,
      reason:
        `Wick too long: ` +
        `${Math.max(upperWick, lowerWick).toFixed(3)}`
    };
  }

  return { pass: true, reason: null };
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

  const result = analyzeTradeFlow(symbol, trades, {
    now,
    atr,
    baselineTracker
  });

  // Фильтр применяем только к реальным сигналам.
  if (result.ready && result.side !== 'none') {
    const filter = passesCandleFilter(candles, result.side);

    if (!filter.pass) {
      return {
        ...result,
        ready: false,
        buy: false,
        sell: false,
        side: 'none',
        takeProfitPrice: null,
        stopLossPrice: null,
        skipReason: `Candle filter: ${filter.reason}`
      };
    }
  }

  return result;
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
