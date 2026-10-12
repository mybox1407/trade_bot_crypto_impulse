import {
  getCandles,
  getTrades
} from './exchange';

import {
  analyzeTradeFlow,
  type TradeFlowResult
} from './strategy';

import {
  ATR
} from 'technicalindicators';

export type TradeFlowRunResult =
  | TradeFlowResult
  | {
      symbol: string;
      ready: false;
      buy: false;
      sell: false;
      side: 'none';
      price: number;
      takeProfitPrice: null;
      stopLossPrice: null;
      positionSize: null;
      regime: 'trade_flow';
      skipReason: string;
      signalTime: number;
      signalTimeIso: string;
      indicators: null;
    };

function getLatestAtr(symbol: string): number | null {
  const candles = getCandles(symbol, '1m', 250);

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
 * Вызывать на событии новой сделки из WebSocket.
 * Свечи используются только для ATR стопа/цели, не для сигнала входа.
 */
export function runTradeFlowOnce(
  symbol: string,
  now = Date.now()
): TradeFlowRunResult {
  const trades = getTrades(symbol);
  const latestTrade = trades[trades.length - 1];
  const atr = getLatestAtr(symbol);

  if (!latestTrade) {
    return {
      symbol,
      ready: false,
      buy: false,
      sell: false,
      side: 'none',
      price: 0,
      takeProfitPrice: null,
      stopLossPrice: null,
      positionSize: null,
      regime: 'trade_flow',
      skipReason: 'No trades received for market',
      signalTime: now,
      signalTimeIso: new Date(now).toISOString(),
      indicators: null
    };
  }

  if (atr == null) {
    return {
      symbol,
      ready: false,
      buy: false,
      sell: false,
      side: 'none',
      price: latestTrade.price,
      takeProfitPrice: null,
      stopLossPrice: null,
      positionSize: null,
      regime: 'trade_flow',
      skipReason: 'ATR unavailable: insufficient candle history',
      signalTime: latestTrade.time,
      signalTimeIso: new Date(latestTrade.time).toISOString(),
      indicators: null
    };
  }

  return analyzeTradeFlow(symbol, trades, {
    now,
    atr
  });
}

/**
 * Старая функция удалена намеренно:
 * бот больше не сканирует входы по 15m свечам.
 */
