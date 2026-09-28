import { getCandles } from './exchange';
import { Candle } from './lighterWs'; 
import {
  analyzeMarket,
  detectMarketRegime,
  StrategyResult
} from './strategy';
import { logSignalCheck } from './logger';

// 15m в миллисекундах
const TIMEFRAME_15M_MS = 15 * 60 * 1000;

/**
 * Оставляет только закрытые 15m-свечи.
 * time — время открытия свечи.
 * Свеча считается закрытой, когда наступило время открытия следующей свечи.
 */
function getClosedCandles<T extends { time: number }>(
  candles: T[],
  now = Date.now()
): T[] {
  if (candles.length === 0) return [];

  const nowMs = now < 1_000_000_000_000
    ? now * 1000
    : now;

  return candles.filter(candle => {
    const candleMs = candle.time < 1_000_000_000_000
      ? candle.time * 1000
      : candle.time;

    // time — открытие свечи. Закрыта, если уже наступило время следующей 15m-свечи.
    return candleMs + TIMEFRAME_15M_MS <= nowMs;
  });
}

export type BotRunResult =
  | {
      symbol: string;
      timeframe: string;
      ready: false;
      reason: string;
    }
  | ({
      symbol: string;
      timeframe: string;
      ready: true;
    } & StrategyResult);

export async function runBotOnce(
  symbol = 'BTC/USDT',
  timeframe = '15m'
): Promise<BotRunResult> {
  const candles = await getCandles(
    symbol,
    timeframe,
    250
  );

  if (candles.length < 200) {
    return {
      symbol,
      timeframe,
      ready: false,
      reason: 'not_enough_candles'
    };
  }

  // Оставляем только закрытые свечи — текущую незакрытую не используем.
  const closedCandles = getClosedCandles(candles, Date.now());

  if (closedCandles.length < 200) {
    return {
      symbol,
      timeframe,
      ready: false,
      reason: 'not_enough_closed_candles'
    };
  }

  const result = await analyzeMarket(
    closedCandles,
    symbol,
    undefined,
    new Date()
  );

  const indicators = result.indicators;
  const hasSignal = result.buy || result.sell;

  const tce = indicators.tce ?? null;

  logSignalCheck({
    timestamp: new Date().toISOString(),
    symbol,
    timeframe,
    side: result.side,
    price: result.price,
    regime: result.regime,
    takeProfitPrice: result.takeProfitPrice,
    stopLossPrice: result.stopLossPrice,
    positionSize: result.positionSize,
    macdCrossUp: indicators.macdCrossUp,
    macdCrossDown: indicators.macdCrossDown,
    lastRsi: indicators.lastRsi,
    lastAtr: indicators.lastAtr,
    rsiBull: false,
    rsiBear: false,
    bbUpper: indicators.bbUpper,
    bbMiddle: indicators.bbMiddle,
    bbLower: indicators.bbLower,
    adx: indicators.adx,
    adxRising: indicators.regimeIndicators.adxRising,
    ema20: indicators.ema20,
    ema50: indicators.regimeIndicators.ema50,
    ema200: indicators.ema200,
    bbWidth: indicators.bbWidth,
    atrPct: indicators.atrPct,
    signalTriggered: hasSignal,
    positionOpened: false,
    openPositionError: result.skipReason ?? undefined,
    entryDistanceFromEma20: indicators.entryDistanceFromEma20 ?? undefined,
    entryDistanceFromEma20Atr: indicators.entryDistanceFromEma20Atr ?? undefined,
    entryTooExtended: indicators.entryTooExtended,
    signalTimeIso: result.signalTimeIso,
    isTradingWindow: result.skipReason == null,
    mlProbability: result.mlProbability,
    mlThreshold: result.mlThreshold,
    mlPassed: result.mlPassed,
    mlTrainedAt: result.mlTrainedAt,
    // TCE
    tceScore: tce?.tceScore ?? null,
    tceRegime: tce?.tceRegime ?? null,
    tceReason: tce?.tceReason ?? null,
    tceTrendAligned: tce?.tceTrendAligned ?? null,
    tceErFast: tce?.tceErFast ?? null,
    tceErSlow: tce?.tceErSlow ?? null,
    tceRoomAtr: tce?.tceRoomAtr ?? null,
    tceEntryExtensionAtr: tce?.tceEntryExtensionAtr ?? null,
    tceCandleRangeAtr: tce?.tceCandleRangeAtr ?? null,
    tceBodyRatio: tce?.tceBodyRatio ?? null
  });

  return {
    symbol,
    timeframe,
    ready: true,
    ...result
  };
}

export async function getMarketRegimeOnce(
  symbol = 'BTC/USDT',
  timeframe = '15m'
) {
  const candles = await getCandles(
    symbol,
    timeframe,
    250
  );

  if (candles.length < 200) {
    return {
      symbol,
      timeframe,
      ready: false,
      reason: 'not_enough_candles'
    };
  }

  const closedCandles = getClosedCandles(candles, Date.now());

  if (closedCandles.length < 200) {
    return {
      symbol,
      timeframe,
      ready: false,
      reason: 'not_enough_closed_candles'
    };
  }

  return {
    symbol,
    timeframe,
    ...detectMarketRegime(closedCandles)
  };
}
