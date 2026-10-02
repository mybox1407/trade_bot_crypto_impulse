import { getCandles } from './exchange';
import { Candle } from './lighterWs'; 
import {
  analyzeMarket,
  detectMarketRegime,
  StrategyResult
} from './strategy';
import { logSignalCheck } from './logger';

const TIMEFRAME_15M_MS = 15 * 60 * 1000;
const TOLERANCE_MS = 2 * 60 * 1000;

function getClosedCandles<T extends { time: number }>(
  candles: T[],
  now = Date.now()
): T[] {
  if (candles.length === 0) return [];

  const nowMs = now < 1_000_000_000_000 ? now * 1000 : now;

  return candles.filter(candle => {
    const candleMs = candle.time < 1_000_000_000_000
      ? candle.time * 1000
      : candle.time;

    return candleMs + TIMEFRAME_15M_MS - TOLERANCE_MS <= nowMs;
  });
}

export type BotRunResult =
  | { symbol: string; timeframe: string; ready: false; reason: string }
  | ({ symbol: string; timeframe: string; ready: true } & StrategyResult);

export async function runBotOnce(
  symbol = 'BTC/USDT',
  timeframe = '15m'
): Promise<BotRunResult> {
  const candles = await getCandles(symbol, timeframe, 250);

  if (candles.length < 200) {
    console.log(`[BOTRUNNER] Not enough candles: ${candles.length} < 200 for ${symbol}`);
    return { symbol, timeframe, ready: false, reason: 'not_enough_candles' };
  }

  const closedCandles = getClosedCandles(candles, Date.now());

  if (closedCandles.length < 200) {
    console.log(`[BOTRUNNER] Not enough closed candles: ${closedCandles.length} < 200 for ${symbol}`);
    return { symbol, timeframe, ready: false, reason: 'not_enough_closed_candles' };
  }

  const lastCandle = closedCandles[closedCandles.length - 1];
  const firstCandle = closedCandles[0];
  console.log(`\n[=== BOTRUNNER DEBUG ${symbol} ${timeframe} ===]`);
  console.log(`Candles: total=${candles.length}, closed=${closedCandles.length}`);
  console.log(`First candle: time=${new Date(firstCandle.time).toISOString()}`);
  console.log(`Last candle: time=${new Date(lastCandle.time).toISOString()}, open=${lastCandle.open}, high=${lastCandle.high}, low=${lastCandle.low}, close=${lastCandle.close}`);
  console.log(`Now: ${new Date().toISOString()}`);
  console.log(`[=== END DEBUG ===]\n`);

  const result = await analyzeMarket(closedCandles, symbol, undefined, new Date());

  const indicators = result.indicators;
  console.log(`\n[=== STRATEGY RESULT ${symbol} ===]`);
  console.log(`Side: ${result.side}, Price: ${result.price}`);
  console.log(`SL: ${result.stopLossPrice}, TP: ${result.takeProfitPrice}, Size: ${result.positionSize}`);
  console.log(`Regime: ${result.regime}, Skip: ${result.skipReason ?? 'none'}`);
  console.log(`ATR: ${indicators.lastAtr}, ATR%: ${(indicators.atrPct * 100).toFixed(3)}%`);
  console.log(`RSI: ${indicators.lastRsi.toFixed(2)}, ADX: ${indicators.adx.toFixed(2)}`);
  console.log(`EMA20: ${indicators.ema20}, EMA50: ${indicators.regimeIndicators.ema50}, EMA200: ${indicators.ema200}`);
  
  if (result.stopLossPrice != null && result.takeProfitPrice != null && indicators.lastAtr > 0) {
    const slDistance = Math.abs(result.price - result.stopLossPrice);
    const tpDistance = Math.abs(result.takeProfitPrice - result.price);
    const slAtr = slDistance / indicators.lastAtr;
    const tpAtr = tpDistance / indicators.lastAtr;
    console.log(`SL distance: ${slDistance.toFixed(4)} (${slAtr.toFixed(3)} ATR)`);
    console.log(`TP distance: ${tpDistance.toFixed(4)} (${tpAtr.toFixed(3)} ATR)`);
    console.log(`SL/TP ratio: ${(tpAtr/slAtr).toFixed(3)} (should be ~1.0 for symmetric)`);
    
    if (Math.abs(slAtr - 3.0) > 0.1 || Math.abs(tpAtr - 3.0) > 0.1) {
      console.warn(`⚠️ WARNING: SL/TP multipliers deviate from expected 3.0!`);
    }
  }
  console.log(`[=== END RESULT ===]\n`);

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
    entryDistanceFromEma20: indicators.entryDistanceFromEma20 ?? undefined,
    entryDistanceFromEma20Atr: indicators.entryDistanceFromEma20Atr ?? undefined,
    entryTooExtended: indicators.entryTooExtended,
    pullbackDetected: indicators.pullbackDetected,
    reclaimDetected: indicators.reclaimDetected,
    signalReason: indicators.signalReason ?? undefined,
    signalTimeIso: result.signalTimeIso,
    isTradingWindow: result.skipReason == null,
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

  return { symbol, timeframe, ready: true, ...result };
}

export async function getMarketRegimeOnce(
  symbol = 'BTC/USDT',
  timeframe = '15m'
) {
  const candles = await getCandles(symbol, timeframe, 250);

  if (candles.length < 200) {
    return { symbol, timeframe, ready: false, reason: 'not_enough_candles' };
  }

  const closedCandles = getClosedCandles(candles, Date.now());

  if (closedCandles.length < 200) {
    return { symbol, timeframe, ready: false, reason: 'not_enough_closed_candles' };
  }

  return { symbol, timeframe, ...detectMarketRegime(closedCandles) };
}
