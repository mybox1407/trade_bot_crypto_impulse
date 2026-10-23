import { ATR } from 'technicalindicators';

import {
  getCandles,
  getTrades,
  getTradeFlowBaselineTracker
} from './exchange';

import {
  analyzeTradeFlow,
  type Candle,
  type TradeFlowResult,
  type TradeHistoryEntry
} from './strategy';

import type { LighterTrade } from './lighterWs';

import { getPositions } from './positionState';

const REQUIRED_CANDLE_COUNT = 700;
const ATR_PERIOD = 14;

function calculateAtr(candles: Candle[]): number | null {
  if (candles.length < ATR_PERIOD + 1) return null;

  const atrValues = ATR.calculate({
    period: ATR_PERIOD,
    high: candles.map(candle => candle.high),
    low: candles.map(candle => candle.low),
    close: candles.map(candle => candle.close)
  });

  const atr = atrValues[atrValues.length - 1];

  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

function getClosedTradeHistory(): TradeHistoryEntry[] {
  return getPositions()
    .filter(position => position.status === 'closed')
    .map(position => ({
      symbol: position.symbol,
      side: position.side,
      openedAt: new Date(position.openedAt).getTime(),
      netPnL: position.netPnL ?? 0
    }));
}

export function runTradeFlowOnce(
  symbol: string,
  now = Date.now()
): TradeFlowResult {
  const trades: LighterTrade[] = getTrades(symbol);
  const candles: Candle[] = getCandles(symbol, '1m', REQUIRED_CANDLE_COUNT);
  const atr = calculateAtr(candles);
  const baselineTracker = getTradeFlowBaselineTracker(symbol);
  const tradeHistory = getClosedTradeHistory();

  return analyzeTradeFlow(symbol, trades, {
    now,
    atr,
    baselineTracker,
    candles,
    tradeHistory
  });
}

export function runBotOnce(
  symbol = 'BTC/USDT',
  _timeframe = '15m'
): TradeFlowResult {
  return runTradeFlowOnce(symbol);
}
