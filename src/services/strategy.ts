import { MACD, RSI, ATR, ADX, BollingerBands, EMA } from 'technicalindicators';
import { calculateTce, TCE_STRONG_MIN, type TceMetrics } from './tce';
import type { Candle } from './lighterWs';

export const STARTING_BALANCE = 150;
export const MAX_RISK_PER_TRADE = 0.01;
export const TRADE_FEE_RATE = 0.0;
export const ENABLE_TREND_UP_TRADES = true;
export const ENABLE_TREND_DOWN_TRADES = true;
export const ENABLE_BREAKOUT_TRADES = false;
export const ENABLE_IMPULSE_CONTINUATION_TRADES = false;
export const IMPULSE_MAX_RISK_PER_TRADE = 0.005;
export const ENABLE_TCE_FILTER = false;
export const TCE_REQUIRED_CANDLES = 200;
export const SYMBOL_COOLDOWN_MS = 60 * 60 * 1000;
export const SIGNAL_TIMEFRAME_MS = 15 * 60 * 1000;
export const MAX_SIGNAL_DRIFT_ATR = 0.35;
export const MAX_ADVERSE_SIGNAL_MOVE_ATR = 0.5;

const TRADING_HOUR_WINDOWS_UTC_PLUS_4: ReadonlyArray<readonly [number, number]> = [[0, 24]];

export const MIN_ENTRY_RSI_LONG = 40;
export const MAX_ENTRY_RSI_LONG = 65;
export const MIN_ENTRY_RSI_SHORT = 35;
export const MAX_ENTRY_RSI_SHORT = 60;
export const MIN_ENTRY_ADX_LONG = 22;
export const MIN_ENTRY_ADX_SHORT = 22;
export const MAX_ENTRY_ADX = 45;
export const HIGH_ADX_THRESHOLD = 45;
export const HIGH_ADX_MAX_ENTRY_DISTANCE_ATR = 0.65;
export const MIN_LAST_ATR_PCT = 0.001;
export const MAX_LAST_ATR_PCT_LONG = 0.04;
export const MAX_LAST_ATR_PCT_SHORT = 0.05;
export const MIN_BB_WIDTH_LONG = 0.0;
export const MAX_BB_WIDTH_LONG = 0.12;
export const MIN_BB_WIDTH_SHORT = 0.0;
export const MAX_BB_WIDTH_SHORT = 0.12;
export const MAX_ENTRY_DISTANCE_FROM_EMA20_ATR = 0.85;
export const MAX_SIGNAL_CANDLE_ATR = 1.2;
export const MIN_SIGNAL_BODY_ATR = 0.35;
export const REQUIRE_ADX_RISING = false;
export const REQUIRE_BB_WIDTH_RISING = false;
export const REQUIRE_DI_DIRECTION = true;
export const REJECT_ENTRY_TOO_EXTENDED = true;
export const LONG_BLACKLIST = [''];

export const PULLBACK_LOOKBACK_CANDLES = 4;
export const PULLBACK_MAX_DEPTH_EMA20_ATR = 1.5;
export const PULLBACK_MAX_DEPTH_EMA50_ATR = 2.5;
export const RECLAIM_MIN_BODY_ATR = 0.35;
export const RECLAIM_MIN_CLOSE_POSITION = 0.6;
export const RECLAIM_VOLUME_VS_LAST_PULLBACK = 1.3;

export const STOP_LOSS_ATR_MULTIPLIER = 3.0;
export const TAKE_PROFIT_ATR_MULTIPLIER = 3.0;
export const ENABLE_TRAILING_STOP = false;

export const IMPULSE_MIN_RSI_LONG = 45;
export const IMPULSE_MAX_RSI_LONG = 72;
export const IMPULSE_MIN_RSI_SHORT = 22;
export const IMPULSE_MAX_RSI_SHORT = 55;
export const IMPULSE_MIN_FILTER_ADX = 22;
export const IMPULSE_MAX_FILTER_ADX = 39;
export const IMPULSE_MAX_ENTRY_DISTANCE_FROM_EMA20_ATR = 2.5;
export const IMPULSE_MAX_SIGNAL_CANDLE_ATR = 1.8;
export const IMPULSE_MIN_BREAKOUT_ATR = 0.15;
export const IMPULSE_MIN_BREAKOUT_VOLUME_RATIO = 1.2;

const IMPULSE_MIN_BODY_ATR = 0.6;
const IMPULSE_MAX_BODY_ATR = 1.6;
const IMPULSE_MIN_CLOSE_POSITION = 0.7;
const IMPULSE_MAX_CONSOLIDATION_RANGE_ATR = 1.2;
const IMPULSE_MAX_BREAKOUT_DRIFT_ATR = 0.65;
const IMPULSE_MIN_ADX = 21;
const IMPULSE_MAX_ADX = 55;
const IMPULSE_STOP_BUFFER_ATR = 0.4;
const IMPULSE_TAKE_PROFIT_ATR_MULTIPLIER = 2.5;

const symbolCooldowns = new Map<string, number>();
const lastProcessedSignalCandleBySymbol = new Map<string, number>();

const getUtcPlus4 = (date = new Date()): number => (date.getUTCHours() + 4) % 24;
const formatHour = (h: number): string => `${String(h).padStart(2, '0')}:00`;
const normalizeTimestamp = (t: number): number => t < 1e12 ? t * 1000 : t;
const getClosedCandles = (c: Candle[]): Candle[] => c;
const last = <T,>(arr: T[]): T => arr[arr.length - 1];
const mean = (v: number[]): number => v.length === 0 ? 0 : v.reduce((s, x) => s + x, 0) / v.length;
const getVolumeSpike = (vols: number[], avg: number): boolean => avg > 0 && (vols[vols.length - 1] ?? 0) >= avg * 1.3;
const getBodySize = (c: Candle): number => Math.abs(c.close - c.open);
const getBodyAtr = (c: Candle, atr: number): number => atr <= 0 ? 0 : getBodySize(c) / atr;
const getCandleRangeAtr = (c: Candle, atr: number): number => atr <= 0 ? 0 : (c.high - c.low) / atr;
const getBbWidth = (bb: { upper: number; middle: number; lower: number }): number => bb.middle !== 0 ? (bb.upper - bb.lower) / bb.middle : 0;
const isPriceOnCorrectSideOfEma20 = (side: 'long' | 'short', price: number, ema20: number): boolean => side === 'long' ? price > ema20 : price < ema20;
const getEntryDistanceFromEma20 = (price: number, ema20: number): number => Math.abs(price - ema20);
const getEntryDistanceFromEma20Atr = (price: number, ema20: number, atr: number): number => atr <= 0 ? Number.POSITIVE_INFINITY : Math.abs(price - ema20) / atr;

function findLocalExtremum(candles: Candle[], side: 'long' | 'short', lookback: number): { extremePrice: number } {
  const slice = candles.slice(-lookback);
  if (slice.length === 0) return { extremePrice: 0 };
  return { extremePrice: side === 'long' ? Math.min(...slice.map(c => c.low)) : Math.max(...slice.map(c => c.high)) };
}

export function shouldProcess15mSignal(symbol: string, candles: Candle[]): boolean {
  const closed = getClosedCandles(candles);
  const candle = closed[closed.length - 1];
  if (candle == null) return false;
  const t = normalizeTimestamp(candle.time);
  const key = symbol.toUpperCase();
  if (lastProcessedSignalCandleBySymbol.get(key) === t) return false;
  lastProcessedSignalCandleBySymbol.set(key, t);
  return true;
}

export function reset15mSignalState(symbol?: string): void {
  if (symbol == null) { lastProcessedSignalCandleBySymbol.clear(); return; }
  lastProcessedSignalCandleBySymbol.delete(symbol.toUpperCase());
}

export type TradingWindowCheck = { allowed: boolean; utcHour: number; utcPlus4Hour: number; message: string | null };

export function isTradingTimeUtcPlus4(date = new Date()): boolean {
  const h = getUtcPlus4(date);
  return TRADING_HOUR_WINDOWS_UTC_PLUS_4.some(([s, e]) => h >= s && h < e);
}

export function getTradingWindowCheck(date = new Date()): TradingWindowCheck {
  const utcHour = date.getUTCHours(), utcPlus4Hour = getUtcPlus4(date);
  const allowed = isTradingTimeUtcPlus4(date);
  return allowed
    ? { allowed: true, utcHour, utcPlus4Hour, message: null }
    : { allowed: false, utcHour, utcPlus4Hour, message: `Сигнал вне торговых часов: UTC ${formatHour(utcHour)}, UTC+4 ${formatHour(utcPlus4Hour)}. Сделка не открыта.` };
}

export const getTradingTimeSkipReason = (date = new Date()): string | null => getTradingWindowCheck(date).message;

export function getCooldownRemainingMs(lastTradeAt: Date | number | string | null | undefined, now = new Date()): number {
  if (lastTradeAt == null) return 0;
  const ms = lastTradeAt instanceof Date ? lastTradeAt.getTime() : typeof lastTradeAt === 'number' ? lastTradeAt : new Date(lastTradeAt).getTime();
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, ms + SYMBOL_COOLDOWN_MS - now.getTime());
}

export function isSymbolOnCooldown(symbol: string, now = new Date()): boolean {
  const end = symbolCooldowns.get(symbol.toUpperCase());
  return end != null && now.getTime() < end;
}

export function setSymbolCooldown(symbol: string, now = new Date()): void { symbolCooldowns.set(symbol.toUpperCase(), now.getTime() + SYMBOL_COOLDOWN_MS); }
export function clearSymbolCooldown(symbol: string): void { symbolCooldowns.delete(symbol.toUpperCase()); }

export function getRemainingCooldownMs(symbol: string, now = new Date()): number {
  const end = symbolCooldowns.get(symbol.toUpperCase());
  if (end == null) return 0;
  return Math.max(0, end - now.getTime());
}

export type MarketRegime = 'trend_up' | 'trend_down' | 'range' | 'breakout_watch' | 'high_volatility' | 'unknown';

type RegimeIndicators = {
  lastClose: number; lastAtr: number; atrPct: number; adx: number; previousAdx: number; adxRising: boolean;
  plusDi: number; minusDi: number; ema20: number; ema50: number; ema200: number; previousEma20: number;
  previousEma50: number; bbWidth: number; previousBbWidth: number; bbWidthRising: boolean; avgVol20: number; candleRangeAtr: number;
};

type FilterCheckResult = { passed: boolean; failedFilter?: string };

export type StrategyIndicators = {
  macdCrossUp: boolean; macdCrossDown: boolean; lastRsi: number; lastAtr: number;
  bbUpper: number; bbMiddle: number; bbLower: number; regimeReady: boolean; regimeIndicators: RegimeIndicators;
  entryExtensionAtr: number | null; maxEntryExtensionAtr: number | null; entryTooExtended: boolean; tradeFeeRate: number; ready: boolean;
  atrPct: number; adx: number; adxRising: boolean; plusDi: number; minusDi: number; bbWidth: number; bbWidthRising: boolean;
  candleRangeAtr: number; ema20: number; ema200: number; priceVsEma200: number | null;
  entryDistanceFromEma20: number | null; entryDistanceFromEma20Atr: number | null; isCandleClosed: boolean;
  pullbackDetected: boolean; reclaimDetected: boolean; signalReason: string | null;
  pullbackLongContext: boolean; pullbackShortContext: boolean;
  pullbackEma20Rising: boolean; pullbackEma20Falling: boolean;
  pullbackLongZone: boolean; pullbackShortZone: boolean;
  pullbackTouchedEma: 'ema20' | 'ema50' | 'both' | 'none';
  pullbackDepthAtr: number;
  bullishReclaim: boolean; bearishReclaim: boolean;
  pullbackValidCandle: boolean; pullbackNotExtended: boolean; pullbackVolumeOk: boolean;
  pullbackCandleRangeAtr: number; pullbackBodyAtr: number; pullbackVolumeRatio: number; pullbackEntryDistanceAtr: number;
  entryPattern: 'pullback_reclaim' | 'impulse_continuation' | 'breakout' | null;
  diagnosticPattern: 'pullback_reclaim' | 'impulse_continuation' | 'breakout' | null;
  diagnosticFailedFilter: string | null;
  impulseDetected: boolean; consolidationDetected: boolean; impulseBreakoutDetected: boolean; tce: TceMetrics | null;
};

export type StrategyResult = {
  price: number; buy: boolean; sell: boolean; side: 'long' | 'short' | 'none';
  takeProfitPrice: number | null; stopLossPrice: number | null; positionSize: number | null;
  regime: MarketRegime; skipReason: string | null; signalTime: number; signalTimeIso: string;
  indicators: StrategyIndicators;
  atrUsedForExit?: number; slMultiplierUsed?: number; tpMultiplierUsed?: number;
};

const MIN_ADX_TREND = 21, MIN_ADX_RANGE = 20, BB_SQUEEZE_THRESHOLD = 0.05;
const BREAKOUT_ATR_BUFFER_K = 0.2, BREAKOUT_BODY_ATR_MIN = 0.6, MAX_EXTREMUM_DISTANCE_ATR = 2.5;
const EXTREMUM_LOOKBACK = 30, BREAKOUT_MIN_ATR_PCT = 0.015, BREAKOUT_MAX_ATR_PCT = 0.035;
const BREAKOUT_MIN_BB_WIDTH = 0.03, BREAKOUT_MAX_BB_WIDTH = 0.08;

type SignalState = { buy: boolean; sell: boolean; side: 'long' | 'short' | 'none'; takeProfitPrice: number | null; stopLossPrice: number | null; positionSize: number | null };
const resetSignalState = (s: SignalState): SignalState => ({ ...s, buy: false, sell: false, side: 'none', takeProfitPrice: null, stopLossPrice: null, positionSize: null });

type PullbackSignal = {
  long: boolean; short: boolean; pullbackDetected: boolean; reclaimDetected: boolean; reason: string | null;
  longContext: boolean; shortContext: boolean; ema20Rising: boolean; ema20Falling: boolean;
  longPullbackZone: boolean; shortPullbackZone: boolean;
  touchedEma: 'ema20' | 'ema50' | 'both' | 'none'; depthOk: boolean; pullbackDepthAtr: number;
  bullishReclaim: boolean; bearishReclaim: boolean;
  validCandle: boolean; notExtended: boolean; volumeOk: boolean;
  candleRangeAtr: number; bodyAtr: number; volumeRatio: number; entryDistanceAtr: number;
};

const noPullbackSignal = (reason: string | null): PullbackSignal => ({
  long: false, short: false, pullbackDetected: false, reclaimDetected: false, reason,
  longContext: false, shortContext: false, ema20Rising: false, ema20Falling: false,
  longPullbackZone: false, shortPullbackZone: false, touchedEma: 'none', depthOk: false, pullbackDepthAtr: 0,
  bullishReclaim: false, bearishReclaim: false, validCandle: false, notExtended: false, volumeOk: false,
  candleRangeAtr: 0, bodyAtr: 0, volumeRatio: 0, entryDistanceAtr: Number.POSITIVE_INFINITY
});

function detectPullbackReclaimSignal(params: { candles: Candle[]; ema20: number[]; ema50: number[]; ema200: number[]; atr: number[]; regimeIndicators: RegimeIndicators }): PullbackSignal {
  const { candles, ema20, ema50, ema200, atr, regimeIndicators } = params;
  const minCandles = 21 + PULLBACK_LOOKBACK_CANDLES;
  if (candles.length < minCandles || ema20.length < minCandles || ema50.length < minCandles || ema200.length < 1 || atr.length < 3) return noPullbackSignal('not_enough_trigger_data');

  const current = last(candles);
  const currentEma20 = last(ema20), previousEma20 = ema20[ema20.length - 2];
  const currentEma50 = last(ema50);
  const currentEma200 = last(ema200);
  const currentAtr = last(atr);
  if (!Number.isFinite(currentAtr) || currentAtr <= 0) return noPullbackSignal('invalid_trigger_atr');

  const ema20Rising = currentEma20 > previousEma20;
  const ema20Falling = currentEma20 < previousEma20;

  const lookback = PULLBACK_LOOKBACK_CANDLES;
  const recent = candles.slice(-1 - lookback, -1);
  const recentEma20 = ema20.slice(-1 - lookback, -1);
  const recentEma50 = ema50.slice(-1 - lookback, -1);

  let touchedEma20Long = false, touchedEma50Long = false, touchedEma20Short = false, touchedEma50Short = false;
  for (let i = 0; i < recent.length; i++) {
    const c = recent[i];
    if (c.low <= recentEma20[i]) touchedEma20Long = true;
    if (c.low <= recentEma50[i]) touchedEma50Long = true;
    if (c.high >= recentEma20[i]) touchedEma20Short = true;
    if (c.high >= recentEma50[i]) touchedEma50Short = true;
  }

  const longPullbackZone = touchedEma20Long || touchedEma50Long;
  const shortPullbackZone = touchedEma20Short || touchedEma50Short;

  let touchedEma: 'ema20' | 'ema50' | 'both' | 'none' = 'none';
  if (touchedEma20Long && touchedEma50Long) touchedEma = 'both';
  else if (touchedEma20Long) touchedEma = 'ema20';
  else if (touchedEma50Long) touchedEma = 'ema50';

  const lowestLow = Math.min(...recent.map(c => c.low));
  const highestHigh = Math.max(...recent.map(c => c.high));

  // ИСПРАВЛЕНО: глубина от min/max EMA20 за окно отката, а не от текущей EMA20
  const minRecentEma20 = Math.min(...recentEma20);
  const maxRecentEma20 = Math.max(...recentEma20);
  const longDepthAtr = (minRecentEma20 - lowestLow) / currentAtr;
  const shortDepthAtr = (highestHigh - maxRecentEma20) / currentAtr;

  const longDepthOk = touchedEma20Long ? longDepthAtr <= PULLBACK_MAX_DEPTH_EMA20_ATR : longDepthAtr <= PULLBACK_MAX_DEPTH_EMA50_ATR;
  const shortDepthOk = touchedEma20Short ? shortDepthAtr <= PULLBACK_MAX_DEPTH_EMA20_ATR : shortDepthAtr <= PULLBACK_MAX_DEPTH_EMA50_ATR;
  const depthOk = longDepthOk || shortDepthOk;
  const pullbackDepthAtr = longDepthOk ? longDepthAtr : shortDepthAtr;

  const recentHigh = Math.max(...recent.map(c => c.high));
  const recentLow = Math.min(...recent.map(c => c.low));
  const candleRange = current.high - current.low;
  const candleRangeAtr = getCandleRangeAtr(current, currentAtr);
  const bodyAtr = getBodyAtr(current, currentAtr);
  const closePosition = candleRange > 0 ? (current.close - current.low) / candleRange : 0.5;

  const volumes = candles.map(c => Number(c.volume) || 0);
  const avgVolume20 = mean(volumes.slice(-21, -1));
  const currentVolume = Number(current.volume) || 0;
  const volumeRatio = avgVolume20 > 0 ? currentVolume / avgVolume20 : 0;
  const lastPullbackVolume = recent.length > 0 ? Number(recent[recent.length - 1].volume) || 0 : 0;
  const volumeVsLastPullback = lastPullbackVolume > 0 ? currentVolume / lastPullbackVolume : volumeRatio;

  const bullishReclaim = current.close > current.open && current.close > currentEma20 && current.close > recentHigh && bodyAtr >= RECLAIM_MIN_BODY_ATR && closePosition >= RECLAIM_MIN_CLOSE_POSITION && volumeVsLastPullback >= RECLAIM_VOLUME_VS_LAST_PULLBACK;
  const bearishReclaim = current.close < current.open && current.close < currentEma20 && current.close < recentLow && bodyAtr >= RECLAIM_MIN_BODY_ATR && closePosition <= 1 - RECLAIM_MIN_CLOSE_POSITION && volumeVsLastPullback >= RECLAIM_VOLUME_VS_LAST_PULLBACK;
  const validCandle = candleRangeAtr <= MAX_SIGNAL_CANDLE_ATR && bodyAtr >= MIN_SIGNAL_BODY_ATR;
  const entryDistanceAtr = getEntryDistanceFromEma20Atr(current.close, currentEma20, currentAtr);
  const notExtended = entryDistanceAtr <= MAX_ENTRY_DISTANCE_FROM_EMA20_ATR;

  const longContext = current.close > currentEma200 && currentEma20 > currentEma50 && currentEma50 > currentEma200 && ema20Rising && regimeIndicators.plusDi > regimeIndicators.minusDi && regimeIndicators.adx >= MIN_ENTRY_ADX_LONG && regimeIndicators.adx <= MAX_ENTRY_ADX;
  const shortContext = current.close < currentEma200 && currentEma20 < currentEma50 && currentEma50 < currentEma200 && ema20Falling && regimeIndicators.minusDi > regimeIndicators.plusDi && regimeIndicators.adx >= MIN_ENTRY_ADX_SHORT && regimeIndicators.adx <= MAX_ENTRY_ADX;

  const long = longContext && longPullbackZone && longDepthOk && bullishReclaim && validCandle && notExtended;
  const short = shortContext && shortPullbackZone && shortDepthOk && bearishReclaim && validCandle && notExtended;
  const reason = long ? `long_pullback_reclaim_${touchedEma}` : short ? `short_pullback_reclaim_${touchedEma}` : null;

  return {
    long, short,
    pullbackDetected: longPullbackZone || shortPullbackZone,
    reclaimDetected: bullishReclaim || bearishReclaim,
    reason, longContext, shortContext, ema20Rising, ema20Falling,
    longPullbackZone, shortPullbackZone, touchedEma, depthOk, pullbackDepthAtr,
    bullishReclaim, bearishReclaim, validCandle, notExtended,
    volumeOk: volumeVsLastPullback >= RECLAIM_VOLUME_VS_LAST_PULLBACK,
    candleRangeAtr, bodyAtr, volumeRatio, entryDistanceAtr
  };
}

type ImpulseContinuationSignal = { long: boolean; short: boolean; reason: string | null; impulseDetected: boolean; consolidationDetected: boolean; breakoutDetected: boolean; breakoutLevel: number | null; consolidationLow: number | null; consolidationHigh: number | null };
const noImpulseSignal = (reason: string | null = null): ImpulseContinuationSignal => ({ long: false, short: false, reason, impulseDetected: false, consolidationDetected: false, breakoutDetected: false, breakoutLevel: null, consolidationLow: null, consolidationHigh: null });

function detectImpulseContinuationSignal(params: { candles: Candle[]; ema20: number[]; ema50: number[]; ema200: number[]; atr: number[]; regimeIndicators: RegimeIndicators }): ImpulseContinuationSignal {
  const { candles, ema20, ema50, ema200, atr, regimeIndicators } = params;
  if (candles.length < 5 || ema20.length < 2 || ema50.length < 1 || ema200.length < 1 || atr.length < 4) return noImpulseSignal('not_enough_impulse_data');

  const impulse = candles[candles.length - 4], pauseOne = candles[candles.length - 3], pauseTwo = candles[candles.length - 2], current = candles[candles.length - 1];
  const currentAtr = last(atr), currentEma20 = last(ema20), currentEma50 = last(ema50), currentEma200 = last(ema200);
  if (!Number.isFinite(currentAtr) || currentAtr <= 0) return noImpulseSignal('invalid_impulse_atr');

  const impulseRange = impulse.high - impulse.low;
  const impulseBodyAtr = getBodySize(impulse) / currentAtr;
  const impulseClosePosition = impulseRange > 0 ? (impulse.close - impulse.low) / impulseRange : 0.5;

  const bullishImpulse = impulse.close > impulse.open && impulseBodyAtr >= IMPULSE_MIN_BODY_ATR && impulseBodyAtr <= IMPULSE_MAX_BODY_ATR && impulseClosePosition >= IMPULSE_MIN_CLOSE_POSITION;
  const bearishImpulse = impulse.close < impulse.open && impulseBodyAtr >= IMPULSE_MIN_BODY_ATR && impulseBodyAtr <= IMPULSE_MAX_BODY_ATR && impulseClosePosition <= 1 - IMPULSE_MIN_CLOSE_POSITION;

  const consolidationHigh = Math.max(pauseOne.high, pauseTwo.high);
  const consolidationLow = Math.min(pauseOne.low, pauseTwo.low);
  const consolidationDetected = consolidationHigh - consolidationLow <= currentAtr * IMPULSE_MAX_CONSOLIDATION_RANGE_ATR;

  const longContext = current.close > currentEma200 && currentEma20 > currentEma50 && currentEma50 > currentEma200 && regimeIndicators.plusDi > regimeIndicators.minusDi && regimeIndicators.adx >= IMPULSE_MIN_ADX && regimeIndicators.adx <= IMPULSE_MAX_ADX && pauseOne.close >= currentEma20 && pauseTwo.close >= currentEma20;
  const shortContext = current.close < currentEma200 && currentEma20 < currentEma50 && currentEma50 < currentEma200 && regimeIndicators.minusDi > regimeIndicators.plusDi && regimeIndicators.adx >= IMPULSE_MIN_ADX && regimeIndicators.adx <= IMPULSE_MAX_ADX && pauseOne.close <= currentEma20 && pauseTwo.close <= currentEma20;

  const volumes = candles.map(c => Number(c.volume) || 0);
  const avgVolume20 = mean(volumes.slice(-21, -1));
  const volumeRatio = avgVolume20 > 0 ? (Number(current.volume) || 0) / avgVolume20 : 0;

  const breakoutUpDistanceAtr = (current.close - consolidationHigh) / currentAtr;
  const breakoutDownDistanceAtr = (consolidationLow - current.close) / currentAtr;
  const breakoutUp = current.close > consolidationHigh && current.close > current.open && breakoutUpDistanceAtr >= IMPULSE_MIN_BREAKOUT_ATR && breakoutUpDistanceAtr <= IMPULSE_MAX_BREAKOUT_DRIFT_ATR && volumeRatio >= IMPULSE_MIN_BREAKOUT_VOLUME_RATIO;
  const breakoutDown = current.close < consolidationLow && current.close < current.open && breakoutDownDistanceAtr >= IMPULSE_MIN_BREAKOUT_ATR && breakoutDownDistanceAtr <= IMPULSE_MAX_BREAKOUT_DRIFT_ATR && volumeRatio >= IMPULSE_MIN_BREAKOUT_VOLUME_RATIO;

  const long = bullishImpulse && consolidationDetected && longContext && breakoutUp;
  const short = bearishImpulse && consolidationDetected && shortContext && breakoutDown;

  if (long) return { long: true, short: false, reason: 'long_impulse_continuation', impulseDetected: true, consolidationDetected: true, breakoutDetected: true, breakoutLevel: consolidationHigh, consolidationLow, consolidationHigh };
  if (short) return { long: false, short: true, reason: 'short_impulse_continuation', impulseDetected: true, consolidationDetected: true, breakoutDetected: true, breakoutLevel: consolidationLow, consolidationLow, consolidationHigh };
  return { long: false, short: false, reason: null, impulseDetected: bullishImpulse || bearishImpulse, consolidationDetected, breakoutDetected: breakoutUp || breakoutDown, breakoutLevel: null, consolidationLow, consolidationHigh };
}

export function detectMarketRegime(candles: Candle[]): { regime: MarketRegime; ready: boolean; indicators: RegimeIndicators | null } {
  const closes = candles.map(c => c.close), highs = candles.map(c => c.high), lows = candles.map(c => c.low);
  const volumes = candles.map(c => Number(c.volume) || 0);
  const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const adx = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
  const ema20 = EMA.calculate({ period: 20, values: closes }), ema50 = EMA.calculate({ period: 50, values: closes });
  const ema200 = EMA.calculate({ period: 200, values: closes });
  const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  if (atr.length < 2 || adx.length < 2 || ema20.length < 2 || ema50.length < 2 || ema200.length < 1 || bb.length < 2) return { regime: 'unknown', ready: false, indicators: null };

  const lastClose = last(closes), lastAtr = last(atr), lastAdx = last(adx), previousAdx = adx[adx.length - 2];
  const lastEma20 = last(ema20), previousEma20 = ema20[ema20.length - 2], lastEma50 = last(ema50), previousEma50 = ema50[ema50.length - 2];
  const lastEma200 = last(ema200), lastBb = last(bb), previousBb = bb[bb.length - 2];
  const avgVol20 = mean(volumes.slice(-20)), bbWidth = getBbWidth(lastBb), previousBbWidth = getBbWidth(previousBb);
  const adxValue = Number(lastAdx.adx) || 0, previousAdxValue = Number(previousAdx.adx) || 0;
  const plusDi = Number(lastAdx.pdi) || 0, minusDi = Number(lastAdx.mdi) || 0;
  const adxRising = adxValue > previousAdxValue, bbWidthRising = bbWidth > previousBbWidth;
  const atrPct = lastClose > 0 ? lastAtr / lastClose : 0;
  const candleRangeAtr = candles.length > 0 ? getCandleRangeAtr(candles[candles.length - 1], lastAtr) : 0;
  const compression = bbWidth <= BB_SQUEEZE_THRESHOLD;
  const strongTrendUp = lastClose > lastEma200 && lastEma20 > lastEma50 && lastEma50 > lastEma200 && lastEma20 > previousEma20 && adxValue >= MIN_ADX_TREND && plusDi > minusDi;
  const strongTrendDown = lastClose < lastEma200 && lastEma20 < lastEma50 && lastEma50 < lastEma200 && lastEma20 < previousEma20 && adxValue >= MIN_ADX_TREND && minusDi > plusDi;
  const range = adxValue < MIN_ADX_RANGE && bbWidth < 0.08;
  const breakoutWatch = compression && adxValue >= 15 && adxValue <= 28 && getVolumeSpike(volumes, avgVol20);
  const highVolatility = atrPct > 0.025 || bbWidth > 0.12;

  let regime: MarketRegime = 'unknown';
  if (highVolatility) regime = 'high_volatility';
  else if (strongTrendUp) regime = 'trend_up';
  else if (strongTrendDown) regime = 'trend_down';
  else if (breakoutWatch) regime = 'breakout_watch';
  else if (range) regime = 'range';

  return { regime, ready: true, indicators: { lastClose, lastAtr, atrPct, adx: adxValue, previousAdx: previousAdxValue, adxRising, plusDi, minusDi, ema20: lastEma20, ema50: lastEma50, ema200: lastEma200, previousEma20, previousEma50, bbWidth, previousBbWidth, bbWidthRising, avgVol20, candleRangeAtr } };
}

export function canOpenTrade(params: {
  symbol: string; side: 'long' | 'short' | 'none'; price: number; ema20: number; lastRsi: number; atrPct: number; adx: number;
  adxRising?: boolean; plusDi?: number; minusDi?: number; bbWidth: number; bbWidthRising?: boolean; candleRangeAtr?: number;
  entryDistanceFromEma20: number; entryDistanceFromEma20Atr: number; entryTooExtended: boolean;
  pullbackDetected: boolean; reclaimDetected: boolean;
  entryPattern?: 'pullback_reclaim' | 'impulse_continuation' | 'breakout'; now?: Date;
}): FilterCheckResult {
  const { symbol, side, price, ema20, lastRsi, atrPct, adx, adxRising = true, plusDi = 0, minusDi = 0, bbWidth, bbWidthRising = true, candleRangeAtr = 0, entryDistanceFromEma20Atr, entryTooExtended, pullbackDetected, reclaimDetected, entryPattern = 'pullback_reclaim', now = new Date() } = params;

  const isImpulse = entryPattern === 'impulse_continuation';
  const isPullback = entryPattern === 'pullback_reclaim';

  if (!isTradingTimeUtcPlus4(now)) return { passed: false, failedFilter: 'trading_window' };
  if (isSymbolOnCooldown(symbol, now)) return { passed: false, failedFilter: 'cooldown' };
  if (side !== 'long' && side !== 'short') return { passed: false, failedFilter: 'invalid_side' };

  if (side === 'long') {
    const base = symbol.split('/')[0].toUpperCase();
    if (LONG_BLACKLIST.includes(base)) return { passed: false, failedFilter: 'blacklist' };
  }

  if (isPullback && !pullbackDetected) return { passed: false, failedFilter: 'pullback_not_detected' };
  if (isPullback && !reclaimDetected) return { passed: false, failedFilter: 'reclaim_not_detected' };
  if (!isPriceOnCorrectSideOfEma20(side, price, ema20)) return { passed: false, failedFilter: 'ema20_direction' };

  if (isPullback) {
    if (side === 'long' && (lastRsi < MIN_ENTRY_RSI_LONG || lastRsi > MAX_ENTRY_RSI_LONG)) return { passed: false, failedFilter: 'rsi' };
    if (side === 'short' && (lastRsi < MIN_ENTRY_RSI_SHORT || lastRsi > MAX_ENTRY_RSI_SHORT)) return { passed: false, failedFilter: 'rsi' };
  }

  if (isImpulse) {
    if (side === 'long' && (lastRsi < IMPULSE_MIN_RSI_LONG || lastRsi > IMPULSE_MAX_RSI_LONG)) return { passed: false, failedFilter: 'impulse_rsi' };
    if (side === 'short' && (lastRsi < IMPULSE_MIN_RSI_SHORT || lastRsi > IMPULSE_MAX_RSI_SHORT)) return { passed: false, failedFilter: 'impulse_rsi' };
  }

  const maxAtrPct = side === 'long' ? MAX_LAST_ATR_PCT_LONG : MAX_LAST_ATR_PCT_SHORT;
  if (atrPct < MIN_LAST_ATR_PCT || atrPct > maxAtrPct) return { passed: false, failedFilter: 'atr_pct' };

  const minAdx = isImpulse ? IMPULSE_MIN_FILTER_ADX : side === 'long' ? MIN_ENTRY_ADX_LONG : MIN_ENTRY_ADX_SHORT;
  const maxAdx = isImpulse ? IMPULSE_MAX_FILTER_ADX : MAX_ENTRY_ADX;
  if (adx < minAdx || adx > maxAdx) return { passed: false, failedFilter: isImpulse ? 'impulse_adx' : 'adx' };

  if (REQUIRE_ADX_RISING && !adxRising) return { passed: false, failedFilter: 'adx_not_rising' };

  if (REQUIRE_DI_DIRECTION) {
    if (side === 'long' && plusDi <= minusDi) return { passed: false, failedFilter: 'di_direction' };
    if (side === 'short' && minusDi <= plusDi) return { passed: false, failedFilter: 'di_direction' };
  }

  const minBbWidth = side === 'long' ? MIN_BB_WIDTH_LONG : MIN_BB_WIDTH_SHORT;
  const maxBbWidth = side === 'long' ? MAX_BB_WIDTH_LONG : MAX_BB_WIDTH_SHORT;
  if (bbWidth < minBbWidth || bbWidth > maxBbWidth) return { passed: false, failedFilter: 'bb_width' };
  if (REQUIRE_BB_WIDTH_RISING && !bbWidthRising) return { passed: false, failedFilter: 'bb_width_not_rising' };

  const maxSignalCandleAtr = isImpulse ? IMPULSE_MAX_SIGNAL_CANDLE_ATR : MAX_SIGNAL_CANDLE_ATR;
  if (candleRangeAtr > 0 && candleRangeAtr > maxSignalCandleAtr) return { passed: false, failedFilter: isImpulse ? 'impulse_signal_candle_too_large' : 'signal_candle_too_large' };

  if (!Number.isFinite(entryDistanceFromEma20Atr)) return { passed: false, failedFilter: 'entry_distance_atr_invalid' };
  const maxDistanceAtr = isImpulse ? IMPULSE_MAX_ENTRY_DISTANCE_FROM_EMA20_ATR : MAX_ENTRY_DISTANCE_FROM_EMA20_ATR;
  if (entryDistanceFromEma20Atr > maxDistanceAtr) return { passed: false, failedFilter: isImpulse ? 'impulse_entry_distance_atr_high' : 'entry_distance_atr_high' };

  if (isPullback && REJECT_ENTRY_TOO_EXTENDED && entryTooExtended) return { passed: false, failedFilter: 'entry_too_extended' };
  return { passed: true };
}

export async function analyzeMarket(candles: Candle[], symbol: string, signalPrice?: number, now = new Date()): Promise<StrategyResult> {
  const closedCandles = candles;
  const closes = closedCandles.map(c => c.close), highs = closedCandles.map(c => c.high), lows = closedCandles.map(c => c.low);
  const regimeInfo = detectMarketRegime(closedCandles);
  const tradingWindow = getTradingWindowCheck(now);

  const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
  const rsi = RSI.calculate({ period: 14, values: closes });
  const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  const ema20 = EMA.calculate({ period: 20, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const ema200 = EMA.calculate({ period: 200, values: closes });

  const lastCandle = closedCandles[closedCandles.length - 1];
  const signalTime = lastCandle?.time ?? Date.now();
  const signalTimeIso = new Date(normalizeTimestamp(signalTime)).toISOString();

  const emptyIndicators = (): StrategyIndicators => ({
    macdCrossUp: false, macdCrossDown: false, lastRsi: 0, lastAtr: 0,
    bbUpper: 0, bbMiddle: 0, bbLower: 0, regimeReady: false,
    regimeIndicators: regimeInfo.indicators ?? ({} as RegimeIndicators),
    entryExtensionAtr: null, maxEntryExtensionAtr: MAX_ENTRY_DISTANCE_FROM_EMA20_ATR,
    entryTooExtended: false, tradeFeeRate: TRADE_FEE_RATE, ready: false,
    atrPct: 0, adx: 0, adxRising: false, plusDi: 0, minusDi: 0,
    bbWidth: 0, bbWidthRising: false, candleRangeAtr: 0,
    ema20: 0, ema200: 0, priceVsEma200: null,
    entryDistanceFromEma20: null, entryDistanceFromEma20Atr: null, isCandleClosed: false,
    pullbackDetected: false, reclaimDetected: false, signalReason: null, entryPattern: null,
    pullbackLongContext: false, pullbackShortContext: false,
    pullbackEma20Rising: false, pullbackEma20Falling: false,
    pullbackLongZone: false, pullbackShortZone: false,
    pullbackTouchedEma: 'none', pullbackDepthAtr: 0,
    bullishReclaim: false, bearishReclaim: false,
    pullbackValidCandle: false, pullbackNotExtended: false, pullbackVolumeOk: false,
    pullbackCandleRangeAtr: 0, pullbackBodyAtr: 0, pullbackVolumeRatio: 0,
    pullbackEntryDistanceAtr: Number.POSITIVE_INFINITY,
    impulseDetected: false, diagnosticPattern: null, diagnosticFailedFilter: null,
    consolidationDetected: false, impulseBreakoutDetected: false, tce: null
  });

  if (closedCandles.length < TCE_REQUIRED_CANDLES || !regimeInfo.ready || !regimeInfo.indicators || macd.length < 2 || rsi.length < 1 || atr.length < 1 || bb.length < 1 || ema20.length < 3 || ema50.length < 3 || ema200.length < 1) {
    return { price: closes[closes.length - 1] ?? 0, buy: false, sell: false, side: 'none', takeProfitPrice: null, stopLossPrice: null, positionSize: null, regime: 'unknown', skipReason: 'Indicators not ready', signalTime, signalTimeIso, indicators: emptyIndicators() };
  }

  const price = last(closes);
  const lastMacd = last(macd), previousMacd = macd[macd.length - 2];
  const macdCrossUp = previousMacd.MACD != null && previousMacd.signal != null && lastMacd.MACD != null && lastMacd.signal != null && previousMacd.MACD < previousMacd.signal && lastMacd.MACD > lastMacd.signal;
  const macdCrossDown = previousMacd.MACD != null && previousMacd.signal != null && lastMacd.MACD != null && lastMacd.signal != null && previousMacd.MACD > previousMacd.signal && lastMacd.MACD < lastMacd.signal;

  const lastRsi = last(rsi), lastAtr = last(atr), lastBb = last(bb);
  const regime = regimeInfo.regime;
  const regimeIndicators = regimeInfo.indicators!;

  const trigger = detectPullbackReclaimSignal({ candles: closedCandles, ema20, ema50, ema200, atr, regimeIndicators });
  const impulseTrigger = detectImpulseContinuationSignal({ candles: closedCandles, ema20, ema50, ema200, atr, regimeIndicators });

  const riskCapital = STARTING_BALANCE * MAX_RISK_PER_TRADE;
  const impulseRiskCapital = STARTING_BALANCE * IMPULSE_MAX_RISK_PER_TRADE;

  let side: 'long' | 'short' | 'none' = 'none';
  let buy = false, sell = false;
  let takeProfitPrice: number | null = null;
  let stopLossPrice: number | null = null;
  let positionSize: number | null = null;
  let skipReason: string | null = null;
  let entryExtensionAtr: number | null = null;
  const maxEntryExtensionAtr = MAX_ENTRY_DISTANCE_FROM_EMA20_ATR;
  let entryTooExtended = false;
  let tce: TceMetrics | null = null;
  let entryPattern: 'pullback_reclaim' | 'impulse_continuation' | 'breakout' | null = null;
  let diagnosticPattern: 'pullback_reclaim' | 'impulse_continuation' | 'breakout' | null = null;
  let diagnosticFailedFilter: string | null = null;

  const impulseDetected = impulseTrigger.impulseDetected;
  const consolidationDetected = impulseTrigger.consolidationDetected;
  const impulseBreakoutDetected = impulseTrigger.breakoutDetected;

  if (!tradingWindow.allowed) skipReason = tradingWindow.message;
  else if (regime === 'high_volatility' || regime === 'range') skipReason = `Trading disabled for regime: ${regime}`;
  else if (ENABLE_IMPULSE_CONTINUATION_TRADES && regime === 'trend_up' && impulseTrigger.long) { side = 'long'; buy = true; entryPattern = 'impulse_continuation'; }
  else if (ENABLE_IMPULSE_CONTINUATION_TRADES && regime === 'trend_down' && impulseTrigger.short) { side = 'short'; sell = true; entryPattern = 'impulse_continuation'; }
  else if (ENABLE_TREND_UP_TRADES && regime === 'trend_up' && trigger.long) { side = 'long'; buy = true; entryPattern = 'pullback_reclaim'; }
  else if (ENABLE_TREND_DOWN_TRADES && regime === 'trend_down' && trigger.short) { side = 'short'; sell = true; entryPattern = 'pullback_reclaim'; }
  else { diagnosticPattern = 'pullback_reclaim'; skipReason = 'No pullback/reclaim or impulse continuation signal'; }

  let atrUsedForExit: number | undefined;
  let slMultiplierUsed: number | undefined;
  let tpMultiplierUsed: number | undefined;

  if (side !== 'none' && lastAtr > 0) {
    entryExtensionAtr = getEntryDistanceFromEma20Atr(price, regimeIndicators.ema20, lastAtr);
    entryTooExtended = entryExtensionAtr > MAX_ENTRY_DISTANCE_FROM_EMA20_ATR;

    const cLow = impulseTrigger.consolidationLow;
    const cHigh = impulseTrigger.consolidationHigh;
    const useImpulseExits = entryPattern === 'impulse_continuation' && cLow != null && cHigh != null;

    if (useImpulseExits) {
      stopLossPrice = side === 'long' ? cLow! - lastAtr * IMPULSE_STOP_BUFFER_ATR : cHigh! + lastAtr * IMPULSE_STOP_BUFFER_ATR;
      takeProfitPrice = side === 'long' ? price + lastAtr * IMPULSE_TAKE_PROFIT_ATR_MULTIPLIER : price - lastAtr * IMPULSE_TAKE_PROFIT_ATR_MULTIPLIER;
      slMultiplierUsed = IMPULSE_STOP_BUFFER_ATR;
      tpMultiplierUsed = IMPULSE_TAKE_PROFIT_ATR_MULTIPLIER;
    } else {
      stopLossPrice = side === 'long' ? price - lastAtr * STOP_LOSS_ATR_MULTIPLIER : price + lastAtr * STOP_LOSS_ATR_MULTIPLIER;
      takeProfitPrice = side === 'long' ? price + lastAtr * TAKE_PROFIT_ATR_MULTIPLIER : price - lastAtr * TAKE_PROFIT_ATR_MULTIPLIER;
      slMultiplierUsed = STOP_LOSS_ATR_MULTIPLIER;
      tpMultiplierUsed = TAKE_PROFIT_ATR_MULTIPLIER;
    }

    atrUsedForExit = lastAtr;

    if (entryPattern === 'impulse_continuation' && (cLow == null || cHigh == null)) {
      const r = resetSignalState({ buy, sell, side, takeProfitPrice, stopLossPrice, positionSize });
      buy = r.buy; sell = r.sell; side = r.side;
      takeProfitPrice = r.takeProfitPrice; stopLossPrice = r.stopLossPrice; positionSize = r.positionSize;
      entryPattern = null;
      skipReason = 'Impulse continuation rejected: consolidation boundaries unavailable';
    }
  }

  if (ENABLE_BREAKOUT_TRADES && tradingWindow.allowed && regime === 'breakout_watch') {
    const lastSignalCandle = closedCandles[closedCandles.length - 1];
    if (lastSignalCandle == null) skipReason = 'No closed candle for breakout';
    else {
      const candleBody = Math.abs(lastSignalCandle.close - lastSignalCandle.open);
      const atrBuffer = lastAtr * BREAKOUT_ATR_BUFFER_K;
      const minBody = lastAtr * BREAKOUT_BODY_ATR_MIN;
      const breakoutUp = lastSignalCandle.close > lastBb.upper + atrBuffer && candleBody >= minBody && lastRsi > 45 && lastRsi < 75;
      const breakoutDown = lastSignalCandle.close < lastBb.lower - atrBuffer && candleBody >= minBody && lastRsi < 55 && lastRsi > 25;
      const atrPct = price > 0 ? lastAtr / price : 0;
      const bbWidth = getBbWidth(lastBb);
      const volatilityOk = atrPct >= BREAKOUT_MIN_ATR_PCT && atrPct <= BREAKOUT_MAX_ATR_PCT && bbWidth >= BREAKOUT_MIN_BB_WIDTH && bbWidth <= BREAKOUT_MAX_BB_WIDTH;

      let extremumOk = true;
      if (breakoutUp || breakoutDown) {
        const s = breakoutUp ? 'long' : 'short';
        const { extremePrice } = findLocalExtremum(closedCandles, s, EXTREMUM_LOOKBACK);
        if (extremePrice !== 0 && lastAtr > 0) {
          const dist = s === 'long' ? price - extremePrice : extremePrice - price;
          if (Math.abs(dist) / lastAtr > MAX_EXTREMUM_DISTANCE_ATR) extremumOk = false;
        }
      }

      if (volatilityOk && extremumOk) {
        if (breakoutUp) { side = 'long'; buy = true; sell = false; entryPattern = 'breakout'; stopLossPrice = price - lastAtr * 1.5; takeProfitPrice = price + lastAtr * 2.2; atrUsedForExit = lastAtr; slMultiplierUsed = 1.5; tpMultiplierUsed = 2.2; }
        else if (breakoutDown) { side = 'short'; sell = true; buy = false; entryPattern = 'breakout'; stopLossPrice = price + lastAtr * 1.5; takeProfitPrice = price - lastAtr * 2.2; atrUsedForExit = lastAtr; slMultiplierUsed = 1.5; tpMultiplierUsed = 2.2; }
      }
    }
  }

  if ((buy || sell) && signalPrice != null && lastAtr > 0) {
    const favorableMoveAtr = (side === 'long' ? price - signalPrice : signalPrice - price) / lastAtr;
    const adverseMoveAtr = (side === 'long' ? signalPrice - price : price - signalPrice) / lastAtr;

    if (adverseMoveAtr > MAX_ADVERSE_SIGNAL_MOVE_ATR || favorableMoveAtr > MAX_SIGNAL_DRIFT_ATR) {
      const r = resetSignalState({ buy, sell, side, takeProfitPrice, stopLossPrice, positionSize });
      buy = r.buy; sell = r.sell; side = r.side;
      takeProfitPrice = r.takeProfitPrice; stopLossPrice = r.stopLossPrice; positionSize = r.positionSize;
      entryPattern = null;
      skipReason = adverseMoveAtr > MAX_ADVERSE_SIGNAL_MOVE_ATR ? `Price moved ${adverseMoveAtr.toFixed(2)} ATR against signal` : `Entry too late: price moved ${favorableMoveAtr.toFixed(2)} ATR in signal direction`;
    }
  }

  let entryDistanceFromEma20ForTrade: number | null = null;
  let entryDistanceFromEma20AtrForTrade: number | null = null;

  if (side !== 'none' && stopLossPrice != null) {
    const entryDistanceFromEma20 = getEntryDistanceFromEma20(price, regimeIndicators.ema20);
    const entryDistanceFromEma20Atr = getEntryDistanceFromEma20Atr(price, regimeIndicators.ema20, lastAtr);
    entryDistanceFromEma20ForTrade = entryDistanceFromEma20;
    entryDistanceFromEma20AtrForTrade = entryDistanceFromEma20Atr;

    const filterResult = canOpenTrade({
      symbol, side, price, ema20: regimeIndicators.ema20, lastRsi,
      atrPct: regimeIndicators.atrPct, adx: regimeIndicators.adx,
      adxRising: regimeIndicators.adxRising, plusDi: regimeIndicators.plusDi, minusDi: regimeIndicators.minusDi,
      bbWidth: regimeIndicators.bbWidth, bbWidthRising: regimeIndicators.bbWidthRising,
      candleRangeAtr: regimeIndicators.candleRangeAtr,
      entryDistanceFromEma20, entryDistanceFromEma20Atr, entryTooExtended,
      pullbackDetected: trigger.pullbackDetected, reclaimDetected: trigger.reclaimDetected,
      entryPattern: entryPattern ?? 'pullback_reclaim', now
    });

    if (!filterResult.passed) {
      diagnosticPattern = entryPattern ?? diagnosticPattern ?? 'pullback_reclaim';
      diagnosticFailedFilter = filterResult.failedFilter ?? 'unknown';
      const rejectedSide = side, rejectedPattern = entryPattern;
      const isRejectedImpulse = rejectedPattern === 'impulse_continuation';

      const r = resetSignalState({ buy, sell, side, takeProfitPrice, stopLossPrice, positionSize });
      buy = r.buy; sell = r.sell; side = r.side;
      takeProfitPrice = r.takeProfitPrice; stopLossPrice = r.stopLossPrice; positionSize = r.positionSize;
      entryPattern = null;

      if (skipReason == null) {
        const failedFilter = filterResult.failedFilter ?? 'unknown';
        const isShortSide = rejectedSide === 'short';
        const rsiRange = isRejectedImpulse
          ? isShortSide ? `${IMPULSE_MIN_RSI_SHORT}–${IMPULSE_MAX_RSI_SHORT}` : `${IMPULSE_MIN_RSI_LONG}–${IMPULSE_MAX_RSI_LONG}`
          : isShortSide ? `${MIN_ENTRY_RSI_SHORT}–${MAX_ENTRY_RSI_SHORT}` : `${MIN_ENTRY_RSI_LONG}–${MAX_ENTRY_RSI_LONG}`;
        const adxRange = isRejectedImpulse
          ? `${IMPULSE_MIN_FILTER_ADX}–${IMPULSE_MAX_FILTER_ADX}`
          : isShortSide ? `${MIN_ENTRY_ADX_SHORT}–${MAX_ENTRY_ADX}` : `${MIN_ENTRY_ADX_LONG}–${MAX_ENTRY_ADX}`;
        const atrRange = isShortSide ? `${MIN_LAST_ATR_PCT}–${MAX_LAST_ATR_PCT_SHORT}` : `${MIN_LAST_ATR_PCT}–${MAX_LAST_ATR_PCT_LONG}`;
        const maxDistanceAtr = isRejectedImpulse ? IMPULSE_MAX_ENTRY_DISTANCE_FROM_EMA20_ATR : MAX_ENTRY_DISTANCE_FROM_EMA20_ATR;
        const maxCandleAtr = isRejectedImpulse ? IMPULSE_MAX_SIGNAL_CANDLE_ATR : MAX_SIGNAL_CANDLE_ATR;
        const signalReason = isRejectedImpulse ? impulseTrigger.reason ?? '-' : trigger.reason ?? '-';

        skipReason = [
          `Filter failed: ${failedFilter}`, `Signal: ${signalReason}`, `Entry pattern: ${rejectedPattern ?? '-'}`,
          `Pullback: ${trigger.pullbackDetected}`, `Reclaim: ${trigger.reclaimDetected}`,
          `Touched EMA: ${trigger.touchedEma}`, `Pullback depth ATR: ${trigger.pullbackDepthAtr.toFixed(2)}`, `Depth OK: ${trigger.depthOk}`,
          `Impulse: ${impulseTrigger.impulseDetected}`, `Consolidation: ${impulseTrigger.consolidationDetected}`, `Impulse breakout: ${impulseTrigger.breakoutDetected}`,
          `RSI: ${lastRsi.toFixed(2)} [${rsiRange}]`, `ADX: ${regimeIndicators.adx.toFixed(2)} [${adxRange}]`,
          `ADX rising: ${regimeIndicators.adxRising}`, `+DI/-DI: ${regimeIndicators.plusDi.toFixed(2)}/${regimeIndicators.minusDi.toFixed(2)}`,
          `ATR%: ${(regimeIndicators.atrPct * 100).toFixed(3)} [${atrRange}]`,
          `BB Width: ${regimeIndicators.bbWidth.toFixed(5)}`, `BB rising: ${regimeIndicators.bbWidthRising}`,
          `Candle ATR: ${regimeIndicators.candleRangeAtr.toFixed(2)} [max ${maxCandleAtr}]`,
          `EMA20 direction: ${failedFilter === 'ema20_direction' ? 'wrong side' : 'OK'}`,
          `Dist EMA20 ATR: ${entryDistanceFromEma20Atr.toFixed(3)} [0–${maxDistanceAtr}]`,
          `Too Extended: ${entryTooExtended}`
        ].join('\n');
      }
    }
  }

  if (ENABLE_TCE_FILTER && side !== 'none' && stopLossPrice != null) {
    const sideBeforeTce = side;
    try {
      tce = calculateTce(closedCandles, sideBeforeTce, price, regimeIndicators.ema20, regimeIndicators.ema50, regimeIndicators.ema200);
      const tcePassed = tce.tceRegime === 'strong' && Number.isFinite(tce.tceScore) && tce.tceScore >= TCE_STRONG_MIN;
      if (!tcePassed) {
        const r = resetSignalState({ buy, sell, side, takeProfitPrice, stopLossPrice, positionSize });
        buy = r.buy; sell = r.sell; side = r.side;
        takeProfitPrice = r.takeProfitPrice; stopLossPrice = r.stopLossPrice; positionSize = r.positionSize;
        entryPattern = null;
        skipReason = `TCE filter rejected ${sideBeforeTce}: score=${Number.isFinite(tce.tceScore) ? tce.tceScore : '-'}, regime=${tce.tceRegime}, reason=${tce.tceReason}`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const r = resetSignalState({ buy, sell, side, takeProfitPrice, stopLossPrice, positionSize });
      buy = r.buy; sell = r.sell; side = r.side;
      takeProfitPrice = r.takeProfitPrice; stopLossPrice = r.stopLossPrice; positionSize = r.positionSize;
      entryPattern = null;
      skipReason = `TCE filter failed: ${message}`;
    }
  }

  if (side !== 'none' && stopLossPrice != null) {
    const riskPerUnit = Math.abs(price - stopLossPrice);
    const capitalForTrade = entryPattern === 'impulse_continuation' ? impulseRiskCapital : riskCapital;
    positionSize = riskPerUnit > 0 ? capitalForTrade / riskPerUnit : null;
  }

  const entryDistanceFromEma20ForLog = side !== 'none' ? getEntryDistanceFromEma20(price, regimeIndicators.ema20) : entryDistanceFromEma20ForTrade;
  const entryDistanceFromEma20AtrForLog = side !== 'none' && lastAtr > 0 && entryDistanceFromEma20ForLog != null ? entryDistanceFromEma20ForLog / lastAtr : entryDistanceFromEma20AtrForTrade;

  return {
    price, buy, sell, side, takeProfitPrice, stopLossPrice, positionSize,
    regime, skipReason, signalTime, signalTimeIso,
    indicators: {
      macdCrossUp, macdCrossDown, lastRsi, lastAtr,
      bbUpper: lastBb.upper, bbMiddle: lastBb.middle, bbLower: lastBb.lower,
      regimeReady: regimeInfo.ready, regimeIndicators,
      entryExtensionAtr, maxEntryExtensionAtr, entryTooExtended, tradeFeeRate: TRADE_FEE_RATE, ready: regimeInfo.ready,
      atrPct: regimeIndicators.atrPct, adx: regimeIndicators.adx, adxRising: regimeIndicators.adxRising,
      plusDi: regimeIndicators.plusDi, minusDi: regimeIndicators.minusDi,
      bbWidth: regimeIndicators.bbWidth, bbWidthRising: regimeIndicators.bbWidthRising,
      candleRangeAtr: regimeIndicators.candleRangeAtr,
      ema20: regimeIndicators.ema20, ema200: regimeIndicators.ema200,
      priceVsEma200: regimeIndicators.ema200 > 0 ? (price - regimeIndicators.ema200) / regimeIndicators.ema200 : null,
      entryDistanceFromEma20: entryDistanceFromEma20ForLog,
      entryDistanceFromEma20Atr: entryDistanceFromEma20AtrForLog,
      isCandleClosed: closedCandles.length > 0,
      pullbackDetected: trigger.pullbackDetected, reclaimDetected: trigger.reclaimDetected,
      pullbackLongContext: trigger.longContext, pullbackShortContext: trigger.shortContext,
      pullbackEma20Rising: trigger.ema20Rising, pullbackEma20Falling: trigger.ema20Falling,
      pullbackLongZone: trigger.longPullbackZone, pullbackShortZone: trigger.shortPullbackZone,
      pullbackTouchedEma: trigger.touchedEma, pullbackDepthAtr: trigger.pullbackDepthAtr,
      bullishReclaim: trigger.bullishReclaim, bearishReclaim: trigger.bearishReclaim,
      pullbackValidCandle: trigger.validCandle, pullbackNotExtended: trigger.notExtended, pullbackVolumeOk: trigger.volumeOk,
      pullbackCandleRangeAtr: trigger.candleRangeAtr, pullbackBodyAtr: trigger.bodyAtr,
      pullbackVolumeRatio: trigger.volumeRatio, pullbackEntryDistanceAtr: trigger.entryDistanceAtr,
      signalReason: entryPattern === 'impulse_continuation' ? impulseTrigger.reason : trigger.reason,
      entryPattern, impulseDetected, diagnosticPattern, diagnosticFailedFilter,
      consolidationDetected, impulseBreakoutDetected, tce
    },
    atrUsedForExit, slMultiplierUsed, tpMultiplierUsed
  };
}

export type TelegramSender = (message: string) => Promise<void>;

export function formatStrategyDiagnostics(result: StrategyResult): string {
  const i = result.indicators;
  const r = i.regimeIndicators;
  const pattern = i.diagnosticPattern ?? i.entryPattern ?? 'pullback_reclaim';
  const isImpulse = pattern === 'impulse_continuation';
  const side = result.side === 'short' ? 'short' : 'long';

  const rsiRange = isImpulse
    ? side === 'short' ? `${IMPULSE_MIN_RSI_SHORT}–${IMPULSE_MAX_RSI_SHORT}` : `${IMPULSE_MIN_RSI_LONG}–${IMPULSE_MAX_RSI_LONG}`
    : side === 'short' ? `${MIN_ENTRY_RSI_SHORT}–${MAX_ENTRY_RSI_SHORT}` : `${MIN_ENTRY_RSI_LONG}–${MAX_ENTRY_RSI_LONG}`;
  const adxRange = isImpulse
    ? `${IMPULSE_MIN_FILTER_ADX}–${IMPULSE_MAX_FILTER_ADX}`
    : side === 'short' ? `${MIN_ENTRY_ADX_SHORT}–${MAX_ENTRY_ADX}` : `${MIN_ENTRY_ADX_LONG}–${MAX_ENTRY_ADX}`;
  const maxAtrPct = side === 'short' ? MAX_LAST_ATR_PCT_SHORT : MAX_LAST_ATR_PCT_LONG;
  const maxDistanceAtr = isImpulse ? IMPULSE_MAX_ENTRY_DISTANCE_FROM_EMA20_ATR : MAX_ENTRY_DISTANCE_FROM_EMA20_ATR;
  const maxCandleAtr = isImpulse ? IMPULSE_MAX_SIGNAL_CANDLE_ATR : MAX_SIGNAL_CANDLE_ATR;

  // ИСПРАВЛЕНО: нейтральный расчёт, всегда заполнен
  const ema20Direction = r.lastClose > r.ema20 ? 'above EMA20' : 'below EMA20';
  const distEma20Atr = r.lastAtr > 0 ? (Math.abs(r.lastClose - r.ema20) / r.lastAtr).toFixed(3) : '-';

  return [
    `Signal: ${i.signalReason ?? '-'}`, `Entry pattern: ${pattern}`, `Filter failed: ${i.diagnosticFailedFilter ?? '-'}`,
    '', '--- Pullback + Reclaim checks ---',
    `Pullback detected: ${i.pullbackDetected}`,
    `Long pullback zone: ${i.pullbackLongZone ? 'OK' : 'FAILED'}`,
    `Short pullback zone: ${i.pullbackShortZone ? 'OK' : 'FAILED'}`,
    `Touched EMA: ${i.pullbackTouchedEma}`,
    `Pullback depth ATR: ${i.pullbackDepthAtr.toFixed(2)} [max ${PULLBACK_MAX_DEPTH_EMA20_ATR}/${PULLBACK_MAX_DEPTH_EMA50_ATR}]`,
    `Long context: ${i.pullbackLongContext ? 'OK' : 'FAILED'}`,
    `Short context: ${i.pullbackShortContext ? 'OK' : 'FAILED'}`,
    `EMA20 rising: ${i.pullbackEma20Rising ? 'OK' : 'FAILED'}`,
    `EMA20 falling: ${i.pullbackEma20Falling ? 'OK' : 'FAILED'}`,
    `Bullish reclaim: ${i.bullishReclaim ? 'OK' : 'FAILED'}`,
    `Bearish reclaim: ${i.bearishReclaim ? 'OK' : 'FAILED'}`,
    `Reclaim detected: ${i.reclaimDetected}`,
    `Candle filter: ${i.pullbackValidCandle ? 'OK' : 'FAILED'}`,
    `Candle ATR: ${i.pullbackCandleRangeAtr.toFixed(2)} [max ${MAX_SIGNAL_CANDLE_ATR}]`,
    `Body ATR: ${i.pullbackBodyAtr.toFixed(2)} [min ${MIN_SIGNAL_BODY_ATR}]`,
    `Volume ratio (vs avg20): ${i.pullbackVolumeRatio.toFixed(2)}`,
    `Volume filter (vs last pullback): ${i.pullbackVolumeOk ? 'OK' : 'FAILED'}`,
    `Distance EMA20 ATR: ${Number.isFinite(i.pullbackEntryDistanceAtr) ? i.pullbackEntryDistanceAtr.toFixed(3) : '-'} [max ${MAX_ENTRY_DISTANCE_FROM_EMA20_ATR}]`,
    `Extension filter: ${i.pullbackNotExtended ? 'OK' : 'FAILED'}`,
    '', '--- General filters ---',
    `Impulse: ${i.impulseDetected}`, `Consolidation: ${i.consolidationDetected}`, `Impulse breakout: ${i.impulseBreakoutDetected}`,
    `RSI: ${i.lastRsi.toFixed(2)} [${rsiRange}]`, `ADX: ${i.adx.toFixed(2)} [${adxRange}]`,
    `ADX rising: ${i.adxRising}`, `+DI/-DI: ${i.plusDi.toFixed(2)}/${i.minusDi.toFixed(2)}`,
    `ATR%: ${(i.atrPct * 100).toFixed(3)} [${(MIN_LAST_ATR_PCT * 100).toFixed(1)}–${(maxAtrPct * 100).toFixed(1)}]`,
    `BB Width: ${i.bbWidth.toFixed(5)}`, `BB rising: ${i.bbWidthRising}`,
    `Candle ATR: ${i.candleRangeAtr.toFixed(2)} [max ${maxCandleAtr}]`,
    `EMA20 direction: ${ema20Direction}`,
    `Dist EMA20 ATR: ${distEma20Atr} [0–${maxDistanceAtr}]`,
    `Too Extended: ${i.entryTooExtended}`,
    `MACD: Up=${i.macdCrossUp}, Down=${i.macdCrossDown}`
  ].join('\n');
}

export async function notifyStrategyResult(result: StrategyResult, symbol: string, sendTelegramMessage: TelegramSender): Promise<void> {
  const diagnostics = formatStrategyDiagnostics(result);
  const tce = result.indicators.tce;
  const tceText = tce == null ? 'TCE: -' : [`TCE score: ${Number.isFinite(tce.tceScore) ? tce.tceScore : '-'}`, `TCE regime: ${tce.tceRegime}`, `TCE reason: ${tce.tceReason}`].join('\n');

  if (result.skipReason != null) {
    await sendTelegramMessage(`${symbol} [${result.regime}]: No signal\n━━━━━━━━━━━━━━━━━━━━━━\n${diagnostics}\n━━━━━━━━━━━━━━━━━━━━━━\nReason: ${result.skipReason}\n━━━━━━━━━━━━━━━━━━━━━━\n${tceText}`);
    return;
  }

  if (result.buy || result.sell) {
    const direction = result.buy ? 'LONG' : 'SHORT';
    const tceDetails = tce == null ? '' : [`TCE room ATR: ${Number.isFinite(tce.tceRoomAtr) ? tce.tceRoomAtr.toFixed(3) : '-'}`, `TCE ER fast/slow: ${Number.isFinite(tce.tceErFast) ? tce.tceErFast.toFixed(3) : '-'} / ${Number.isFinite(tce.tceErSlow) ? tce.tceErSlow.toFixed(3) : '-'}`].join('\n');
    const exitDebug = result.atrUsedForExit != null ? [`[DEBUG] ATR: ${result.atrUsedForExit.toFixed(6)}`, `SL_mult: ${result.slMultiplierUsed?.toFixed(2) ?? '-'}`, `TP_mult: ${result.tpMultiplierUsed?.toFixed(2) ?? '-'}`].join(', ') : '';

    await sendTelegramMessage(
      `📊 ${symbol} ${direction} [${result.regime}]\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      `Причина: ${result.indicators.signalReason ?? '-'}\nЦена: ${result.price}\nTP: ${result.takeProfitPrice ?? '-'}\nSL: ${result.stopLossPrice ?? '-'}\nРазмер: ${result.positionSize ?? '-'}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n${diagnostics}\n━━━━━━━━━━━━━━━━━━━━━━\n${tceText}` +
      (tceDetails ? `\n${tceDetails}` : '') + (exitDebug ? `\n${exitDebug}` : '')
    );
  }
}
