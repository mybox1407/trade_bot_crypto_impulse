import {
  FLOW_WINDOW_MS,
  analyzeTradeFlow,
  isValidTrade,
  type TradeFlowResult
} from './strategy';

import {
  getTrades,
  getTradeFlowBaselineTracker
} from './exchange';

import type {
  LighterTrade
} from './lighterWs';

/**
 * Микро-ATR по тикам.
 *
 * 1. Группирует сделки за последние lookbackMs в посекундные buckets.
 * 2. Считает средний диапазон (high - low) за 1 секунду.
 * 3. Масштабирует на длительность торгового окна по sqrt-правилу:
 *    microAtr = avgRange1s * sqrt(windowMs / 1000)
 *
 * Для windowMs = 5000 это avgRange1s * 2.236.
 */
export function calculateMicroAtr(
  trades: LighterTrade[],
  now: number,
  windowMs: number = FLOW_WINDOW_MS,
  lookbackMs: number = 60_000,
  minSeconds: number = 30
): number | null {
  const from = now - lookbackMs;

  const buckets = new Map<number, {
    high: number;
    low: number;
  }>();

  for (const trade of trades) {
    if (!isValidTrade(trade)) {
      continue;
    }

    if (
      trade.receivedAt < from ||
      trade.receivedAt > now
    ) {
      continue;
    }

    const second =
      Math.floor(trade.receivedAt / 1_000);

    const bucket = buckets.get(second);

    if (!bucket) {
      buckets.set(second, {
        high: trade.price,
        low: trade.price
      });
    } else {
      bucket.high = Math.max(
        bucket.high,
        trade.price
      );
      bucket.low = Math.min(
        bucket.low,
        trade.price
      );
    }
  }

  const activeSeconds = buckets.size;

  if (activeSeconds < minSeconds) {
    return null;
  }

  let sumRange = 0;

  for (const bucket of buckets.values()) {
    sumRange += bucket.high - bucket.low;
  }

  const avgRangePerSecond =
    sumRange / activeSeconds;

  if (
    !Number.isFinite(avgRangePerSecond) ||
    avgRangePerSecond <= 0
  ) {
    return null;
  }

  const microAtr =
    avgRangePerSecond *
    Math.sqrt(windowMs / 1_000);

  return Number.isFinite(microAtr) && microAtr > 0
    ? microAtr
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
  const baselineTracker =
    getTradeFlowBaselineTracker(symbol);

  const atr = calculateMicroAtr(
    trades,
    now,
    FLOW_WINDOW_MS,
    60_000,
    30
  );

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
