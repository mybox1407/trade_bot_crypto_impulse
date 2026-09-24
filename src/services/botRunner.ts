import { getCandles } from './exchange';
import {
  analyzeMarket,
  detectMarketRegime,
  StrategyResult
} from './strategy';
import { logSignalCheck } from './logger';

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

  const result = await analyzeMarket(
    candles,
    symbol,
    undefined,
    new Date()
  );

  const indicators = result.indicators;
  const hasSignal = result.buy || result.sell;

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
    mlTrainedAt: result.mlTrainedAt
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

  return {
    symbol,
    timeframe,
    ...detectMarketRegime(candles)
  };
}
