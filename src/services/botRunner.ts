import { getCandles } from './exchange';
import { analyzeMarket, detectMarketRegime, StrategyResult } from './strategy';
import { logSignalCheck } from './logger';

export async function runBotOnce(symbol = 'BTC/USDT', timeframe = '15m') {
  const candles = await getCandles(symbol, timeframe, 250);

  if (candles.length < 200) {
    return { symbol, timeframe, ready: false, reason: 'not_enough_candles' };
  }

  const result = analyzeMarket(candles, symbol);
  
  if (result.buy || result.sell) {
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
      macdCrossUp: result.indicators.macdCrossUp,
      macdCrossDown: result.indicators.macdCrossDown,
      lastRsi: result.indicators.lastRsi,
      lastAtr: result.indicators.lastAtr,
      rsiBull: false, // удалено из стратегии
      rsiBear: false, // удалено из стратегии
      bbUpper: result.indicators.bbUpper,
      bbMiddle: result.indicators.bbMiddle,
      bbLower: result.indicators.bbLower,
      adx: result.indicators.adx,
      adxRising: result.indicators.regimeIndicators.adxRising,
      ema20: result.indicators.ema20,
      ema50: result.indicators.regimeIndicators.ema50,
      ema200: result.indicators.ema200,
      bbWidth: result.indicators.bbWidth,
      atrPct: result.indicators.atrPct,
      signalTriggered: true,
      positionOpened: false
    });
  }

  return { symbol, timeframe, ready: true, ...result };
}

export async function getMarketRegimeOnce(symbol = 'BTC/USDT', timeframe = '15m') {
  const candles = await getCandles(symbol, timeframe, 250);

  if (candles.length < 200) {
    return { symbol, timeframe, ready: false, reason: 'not_enough_candles' };
  }

  return { symbol, timeframe, ...detectMarketRegime(candles) };
}
