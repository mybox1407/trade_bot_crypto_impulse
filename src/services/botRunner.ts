import { ATR } from 'technicalindicators';

import {
  getCandles,
  getMarketTimeframe,
  getTrades,
  getTradeFlowBaselineTracker,
  getTickerPrice,
  getAllTradeHistory
} from './exchange';

import {
  analyzeTradeFlow,
  type TradeFlowResult,
  type TradeHistoryEntry
} from './strategy';

import {
  loadVirtualTradeHistory,
  getVirtualTradeHistory,
  getActiveVirtualTrade,
  openVirtualTrade,
  checkVirtualTrade
} from './virtualTrade';

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

const VIRTUAL_TRADE_CHECK_INTERVAL_MS = 5_000;

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

/**
 * Реальная история сделок.
 * Оставлена для диагностики и совместимости.
 */
function buildRealTradeHistory(): TradeHistoryEntry[] {
  return getAllTradeHistory()
    .sort((a, b) => a.openedAt - b.openedAt);
}

/**
 * История для S2.
 *
 * Теперь S2 использует закрытые виртуальные сделки,
 * а не только реально исполненные сделки бота.
 */
function buildVirtualTradeHistory(): TradeHistoryEntry[] {
  return getVirtualTradeHistory()
    .filter(trade => trade.status !== 'open')
    .map(trade => ({
      symbol: trade.symbol,
      side: trade.side,
      openedAt: trade.openedAt,
      netPnL: trade.netPnL ?? 0
    }))
    .sort((a, b) => a.openedAt - b.openedAt);
}

/**
 * Открывает виртуальную сделку на сыром trade-flow сигнале.
 *
 * Правило старого бота сохраняется:
 * один символ — одна открытая виртуальная позиция.
 */
function maybeOpenVirtualTrade(
  symbol: string,
  result: TradeFlowResult,
  slTpAtr: number | null
): void {
  if (!result.rawSignal) return;

  if (result.side !== 'long' && result.side !== 'short') return;

  if (
    !Number.isFinite(result.price) ||
    result.price <= 0 ||
    result.stopLossPrice == null ||
    !Number.isFinite(result.stopLossPrice) ||
    result.takeProfitPrice == null ||
    !Number.isFinite(result.takeProfitPrice) ||
    slTpAtr == null ||
    !Number.isFinite(slTpAtr) ||
    slTpAtr <= 0
  ) {
    return;
  }

  const activeTrade = getActiveVirtualTrade(symbol);

  if (activeTrade) return;

  openVirtualTrade({
    symbol,
    side: result.side,
    entryPrice: result.price,
    stopLossPrice: result.stopLossPrice,
    takeProfitPrice: result.takeProfitPrice,
    slTpAtr
  });
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

  // S2 теперь работает по виртуальной истории сырых импульсов.
  const tradeHistory = buildVirtualTradeHistory();

  const result = analyzeTradeFlow(symbol, trades, {
    now,
    atr: filterAtr,
    slTpAtr,
    candles: filterCandles,
    tradeHistory,
    baselineTracker
  });

  maybeOpenVirtualTrade(
    symbol,
    result,
    slTpAtr
  );

  return result;
}

/**
 * Проверяет открытые виртуальные сделки по текущей REST-цене.
 * Закрытая виртуальная сделка попадает в virtual_trade_log.csv
 * и становится доступной для будущего S2-решения.
 */
export async function checkOpenVirtualTrades(): Promise<void> {
  const symbols = new Set<string>();

  for (const trade of getVirtualTradeHistory()) {
    symbols.add(trade.symbol);
  }

  for (const symbol of symbols) {
    const activeTrade = getActiveVirtualTrade(symbol);

    if (!activeTrade) continue;

    try {
      const price = await getTickerPrice(symbol);

      if (
        price == null ||
        !Number.isFinite(price) ||
        price <= 0
      ) {
        continue;
      }

      checkVirtualTrade(symbol, price);
    } catch (error) {
      console.error(
        `[virtual-trade] Failed to check ${symbol}:`,
        error
      );
    }
  }
}

/**
 * Запускает периодическую проверку открытых виртуальных сделок.
 */
export function startVirtualTradeMonitor(): void {
  setInterval(() => {
    void checkOpenVirtualTrades();
  }, VIRTUAL_TRADE_CHECK_INTERVAL_MS);
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

/**
 * Инициализация виртуального S2.
 * Вызывать один раз при старте приложения.
 */
export function initializeVirtualTradeSystem(): void {
  loadVirtualTradeHistory();
  startVirtualTradeMonitor();
}
