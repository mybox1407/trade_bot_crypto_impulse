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

function isClosedPosition(position: unknown): boolean {
  const value = position as Record<string, unknown>;

  return Boolean(
    value.closedAt ||
    value.closedAtIso ||
    value.closePrice ||
    value.closed === true ||
    value.status === 'closed'
  );
}

function getPositionPnL(position: unknown): number {
  const value = position as Record<string, unknown>;

  const candidates = [
    value.netPnL,
    value.realizedPnL,
    value.pnl,
    value.unrealizedPnL
  ];

  for (const candidate of candidates) {
    const parsed = Number(candidate);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function getClosedTradeHistory(): TradeHistoryEntry[] {
  return getPositions()
    .filter(isClosedPosition)
    .map(position => {
      const value = position as Record<string, unknown>;

      return {
        symbol: String(value.symbol),
        side: value.side === 'short' ? 'short' : 'long',
        openedAt: new Date(String(value.openedAt)).getTime(),
        netPnL: getPositionPnL(position)
      };
    });
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
