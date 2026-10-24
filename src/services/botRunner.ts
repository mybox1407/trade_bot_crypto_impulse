import { ATR } from 'technicalindicators';

import {
  getCandles,
  getMarketTimeframe,
  getTrades,
  getTradeFlowBaselineTracker,
  getTradeHistory
} from './exchange';

import {
  getLastClosedTrade
} from './positionState';

import {
  analyzeTradeFlow,
  type TradeFlowResult,
  type TradeHistoryEntry
} from './strategy';

import type {
  Candle,
  LighterTrade
} from './lighterWs';

const FILTER_CANDLE_LIMIT = 700;
const SLTP_15M_CANDLE_LIMIT = 250;
const DEFAULT_TIMEFRAME = '1m';
const ATR_PERIOD = 14;
const MINUTE_MS = 60_000;
const FIFTEEN_MINUTE_MS = 15 * MINUTE_MS;

function calculateAtrWilder(candles: Candle[], period = ATR_PERIOD): number | null {
  if (candles.length < period + 1) return null;

  const atrValues = ATR.calculate({
    period,
    high: candles.map(candle => candle.high),
    low: candles.map(candle => candle.low),
    close: candles.map(candle => candle.close)
  });

  const atr = atrValues[atrValues.length - 1];

  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

function resampleTo15m(candles: Candle[], limit = SLTP_15M_CANDLE_LIMIT): Candle[] {
  const now = Date.now();
  const buckets = new Map<number, Candle>();

  for (const candle of candles) {
    const bucketTime = Math.floor(candle.time / FIFTEEN_MINUTE_MS) * FIFTEEN_MINUTE_MS;
    const existing = buckets.get(bucketTime);

    if (!existing) {
      buckets.set(bucketTime, { ...candle, time: bucketTime });
      continue;
    }

    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += candle.volume;
  }

  return [...buckets.values()]
    .filter(candle => candle.time + FIFTEEN_MINUTE_MS <= now)
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

function normalizeHistorySymbol(symbol: string): string {
  const value = symbol.trim().toUpperCase();

  return value.endsWith('/USDT') ? value : `${value}/USDT`;
}

function buildTradeHistory(symbol: string): TradeHistoryEntry[] {
  const normalizedSymbol = normalizeHistorySymbol(symbol);
  const history = getTradeHistory(symbol);
  const lastClosedTrade = getLastClosedTrade();

  const merged = [...history];

  if (lastClosedTrade) {
    const entry: TradeHistoryEntry = {
      symbol: normalizeHistorySymbol(lastClosedTrade.symbol),
      side: lastClosedTrade.side,
      openedAt: new Date(lastClosedTrade.openedAt).getTime(),
      netPnL: lastClosedTrade.netPnL
    };

    const duplicate = merged.some(item =>
      item.symbol === entry.symbol &&
      item.side === entry.side &&
      item.openedAt === entry.openedAt &&
      item.netPnL === entry.netPnL
    );

    if (!duplicate) {
      merged.push(entry);
    }
  }

  return merged
    .filter(item => item.symbol === normalizedSymbol)
    .sort((a, b) => a.openedAt - b.openedAt);
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

  // Входной фильтр v6.41 — 1m свечи и Wilder ATR, как в рабочей версии.
  const filterCandles: Candle[] = getCandles(symbol, DEFAULT_TIMEFRAME, FILTER_CANDLE_LIMIT);
  const filterAtr = calculateAtrWilder(filterCandles);

  // SL/TP — только закрытые 15m свечи (ресемплинг из 1m) и Wilder ATR.
  const slTpCandles: Candle[] = resampleTo15m(filterCandles);
  const slTpAtr = calculateAtrWilder(slTpCandles);

  const baselineTracker = getTradeFlowBaselineTracker(symbol);
  const tradeHistory = buildTradeHistory(symbol);

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
