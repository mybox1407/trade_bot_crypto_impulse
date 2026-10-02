import { MACD, RSI, ATR, ADX, BollingerBands, EMA } from 'technicalindicators';
import { calculateTce, TCE_STRONG_MIN, type TceMetrics } from './tce';
import type { Candle } from './lighterWs';

export const STARTING_BALANCE = 150;
export const MAX_RISK_PER_TRADE = 0.01;
export const TRADE_FEE_RATE = 0.0;
export const ENABLE_TREND_UP_TRADES = true;
export const ENABLE_TREND_DOWN_TRADES = true;
export const ENABLE_BREAKOUT_TRADES = false;
export const ENABLE_IMPULSE_CONTINUATION_TRADES = true;
export const IMPULSE_MAX_RISK_PER_TRADE = 0.005;
export const ENABLE_TCE_FILTER = false;
export const TCE_REQUIRED_CANDLES = 200;
export const SYMBOL_COOLDOWN_MS = 60 * 60 * 1000;
export const SIGNAL_TIMEFRAME_MS = 15 * 60 * 1000;
export const MAX_SIGNAL_DRIFT_ATR = 0.35;
export const MAX_ADVERSE_SIGNAL_MOVE_ATR = 0.5;

const TRADING_HOUR_WINDOWS_UTC_PLUS_4: ReadonlyArray<readonly [number, number]> = [[0, 24]];
export const MIN_ENTRY_RSI_SHORT = 32;
export const MAX_ENTRY_RSI_SHORT = 52;
export const MIN_ENTRY_RSI_LONG = 48;
export const MAX_ENTRY_RSI_LONG = 68;
export const MIN_ENTRY_ADX_SHORT = 21;
export const MIN_ENTRY_ADX_LONG = 21;
export const MAX_ENTRY_ADX = 55;
export const HIGH_ADX_THRESHOLD = 45;
export const HIGH_ADX_MAX_ENTRY_DISTANCE_ATR = 0.65;
export const MIN_LAST_ATR_PCT = 0.001;
export const MAX_LAST_ATR_PCT_LONG = 0.04;
export const MAX_LAST_ATR_PCT_SHORT = 0.05;
export const MIN_BB_WIDTH_LONG = 0.0;
export const MAX_BB_WIDTH_LONG = 0.12;
export const MIN_BB_WIDTH_SHORT = 0.0;
export const MAX_BB_WIDTH_SHORT = 0.12;
export const MAX_ENTRY_DISTANCE_FROM_EMA20_ATR = 0.8;
export const MAX_SIGNAL_CANDLE_ATR = 1.5;
export const MIN_SIGNAL_BODY_ATR = 0.2;
export const REQUIRE_ADX_RISING = false;
export const REQUIRE_BB_WIDTH_RISING = false;
export const REQUIRE_DI_DIRECTION = true;
export const REJECT_ENTRY_TOO_EXTENDED = true;
export const LONG_BLACKLIST = [''];

// === ГЛАВНЫЕ КОНСТАНТЫ SL/TP ===
export const STOP_LOSS_ATR_MULTIPLIER = 3.0;
export const TAKE_PROFIT_ATR_MULTIPLIER = 3.0;
export const ENABLE_TRAILING_STOP = false;

const IMPULSE_MIN_BODY_ATR = 0.7;
const IMPULSE_MAX_BODY_ATR = 1.5;
const IMPULSE_MIN_CLOSE_POSITION = 0.7;
const IMPULSE_MAX_CONSOLIDATION_RANGE_ATR = 1.2;
const IMPULSE_MAX_BREAKOUT_DRIFT_ATR = 0.8;
const IMPULSE_MIN_ADX = 21;
const IMPULSE_MAX_ADX = 55;
const IMPULSE_STOP_BUFFER_ATR = 0.2;
const IMPULSE_TAKE_PROFIT_ATR_MULTIPLIER = 3.0;

const symbolCooldowns = new Map<string, number>();
const lastProcessedSignalCandleBySymbol = new Map<string, number>();

function getUtcPlus4(date = new Date()): number { return (date.getUTCHours() + 4) % 24; }
function formatHour(hour: number): string { return `${String(hour).padStart(2, '0')}:00`; }
function normalizeTimestamp(time: number): number { return time < 1_000_000_000_000 ? time * 1000 : time; }
function getClosedCandles(candles: Candle[]): Candle[] { return candles; }

export function shouldProcess15mSignal(symbol: string, candles: Candle[]): boolean {
  const closedCandles = getClosedCandles(candles);
  const closedCandle = closedCandles[closedCandles.length - 1];
  if (closedCandle == null) return false;
  const candleTime = normalizeTimestamp(closedCandle.time);
  const key = symbol.toUpperCase();
  const lastProcessed = lastProcessedSignalCandleBySymbol.get(key);
  if (lastProcessed === candleTime) return false;
  lastProcessedSignalCandleBySymbol.set(key, candleTime);
  return true;
}

export function reset15mSignalState(symbol?: string): void {
  if (symbol == null) { lastProcessedSignalCandleBySymbol.clear(); return; }
  lastProcessedSignalCandleBySymbol.delete(symbol.toUpperCase());
}

export type TradingWindowCheck = { allowed: boolean; utcHour: number; utcPlus4Hour: number; message: string | null };

export function isTradingTimeUtcPlus4(date = new Date()): boolean {
  const hour = getUtcPlus4(date);
  return TRADING_HOUR_WINDOWS_UTC_PLUS_4.some(([startHour, endHour]) => hour >= startHour && hour < endHour);
}

export function getTradingWindowCheck(date = new Date()): TradingWindowCheck {
  const utcHour = date.getUTCHours();
  const utcPlus4Hour = getUtcPlus4(date);
  const allowed = isTradingTimeUtcPlus4(date);
  if (allowed) return { allowed: true, utcHour, utcPlus4Hour, message: null };
  return { allowed: false, utcHour, utcPlus4Hour, message: `Сигнал вне торговых часов: UTC ${formatHour(utcHour)}, UTC+4 ${formatHour(utcPlus4Hour)}. Сделка не открыта.` };
}

export function getTradingTimeSkipReason(date = new Date()): string | null { return getTradingWindowCheck(date).message; }

export function getCooldownRemainingMs(lastTradeAt: Date | number | string | null | undefined, now = new Date()): number {
  if (lastTradeAt == null) return 0;
  const lastTradeMs = lastTradeAt instanceof Date ? lastTradeAt.getTime() : typeof lastTradeAt === 'number' ? lastTradeAt : new Date(lastTradeAt).getTime();
  if (!Number.isFinite(lastTradeMs)) return 0;
  return Math.max(0, lastTradeMs + SYMBOL_COOLDOWN_MS - now.getTime());
}

export function isSymbolOnCooldown(symbol: string, now = new Date()): boolean {
  const key = symbol.toUpperCase();
  const cooldownEnd = symbolCooldowns.get(key);
  if (cooldownEnd == null) return false;
  return now.getTime() < cooldownEnd;
}

export function setSymbolCooldown(symbol: string, now = new Date()): void {
  const key = symbol.toUpperCase();
  symbolCooldowns.set(key, now.getTime() + SYMBOL_COOLDOWN_MS);
}

export function clearSymbolCooldown(symbol: string): void { symbolCooldowns.delete(symbol.toUpperCase()); }

export function getRemainingCooldownMs(symbol: string, now = new Date()): number {
  const cooldownEnd = symbolCooldowns.get(symbol.toUpperCase());
  if (cooldownEnd == null) return 0;
  const remaining = cooldownEnd - now.getTime();
  return remaining > 0 ? remaining : 0;
}

function last<T>(arr: T[]): T { return arr[arr.length - 1]; }
function mean(values: number[]): number { if (values.length === 0) return 0; return values.reduce((sum, value) => sum + value, 0) / values.length; }
function getVolumeSpike(volumes: number[], avgVol20: number): boolean { const latestVolume = volumes[volumes.length - 1] ?? 0; return avgVol20 > 0 && latestVolume >= avgVol20 * 1.3; }

function findLocalExtremum(candles: Candle[], side: 'long' | 'short', lookback: number): { extremePrice: number } {
  const slice = candles.slice(-lookback);
  if (slice.length === 0) return { extremePrice: 0 };
  const extremePrice = side === 'long' ? Math.min(...slice.map(c => c.low)) : Math.max(...slice.map(c => c.high));
  return { extremePrice };
}

function getBodySize(candle: Candle): number { return Math.abs(candle.close - candle.open); }
function getBodyAtr(candle: Candle, atr: number): number { if (atr <= 0) return 0; return getBodySize(candle) / atr; }
function getCandleRangeAtr(candle: Candle, atr: number): number { if (atr <= 0) return 0; return (candle.high - candle.low) / atr; }
function getBbWidth(bb: { upper: number; middle: number; lower: number }): number { return bb.middle !== 0 ? (bb.upper - bb.lower) / bb.middle : 0; }
function isPriceOnCorrectSideOfEma20(side: 'long' | 'short', price: number, ema20: number): boolean { return side === 'long' ? price > ema20 : price < ema20; }
function getEntryDistanceFromEma20(price: number, ema20: number): number { return Math.abs(price - ema20); }
function getEntryDistanceFromEma20Atr(price: number, ema20: number, atr: number): number { if (atr <= 0) return Number.POSITIVE_INFINITY; return getEntryDistanceFromEma20(price, ema20) / atr; }

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
  entryPattern: 'pullback_reclaim' | 'impulse_continuation' | 'breakout' | null;
  impulseDetected: boolean; consolidationDetected: boolean; impulseBreakoutDetected: boolean; tce: TceMetrics | null;
};

export type StrategyResult = {
  price: number; buy: boolean; sell: boolean; side: 'long' | 'short' | 'none';
  takeProfitPrice: number | null; stopLossPrice: number | null; positionSize: number | null;
  regime: MarketRegime; skipReason: string | null; signalTime: number; signalTimeIso: string;
  indicators: StrategyIndicators;
  atrUsedForExit?: number; slMultiplierUsed?: number; tpMultiplierUsed?: number;
};

const MIN_ADX_TREND = 21; const MIN_ADX_RANGE = 20; const BB_SQUEEZE_THRESHOLD = 0.05;
const BREAKOUT_ATR_BUFFER_K = 0.2; const BREAKOUT_BODY_ATR_MIN = 0.6; const MAX_EXTREMUM_DISTANCE_ATR = 2.5;
const EXTREMUM_LOOKBACK = 30; const BREAKOUT_MIN_ATR_PCT = 0.015; const BREAKOUT_MAX_ATR_PCT = 0.035;
const BREAKOUT_MIN_BB_WIDTH = 0.03; const BREAKOUT_MAX_BB_WIDTH = 0.08;

type SignalState = { buy: boolean; sell: boolean; side: 'long' | 'short' | 'none'; takeProfitPrice: number | null; stopLossPrice: number | null; positionSize: number | null };
function resetSignalState(state: SignalState): SignalState { return { ...state, buy: false, sell: false, side: 'none', takeProfitPrice: null, stopLossPrice: null, positionSize: null }; }

type PullbackSignal = { long: boolean; short: boolean; pullbackDetected: boolean; reclaimDetected: boolean; reason: string | null };

function detectPullbackReclaimSignal(params: { candles: Candle[]; ema20: number[]; ema50: number[]; ema200: number[]; atr: number[]; regimeIndicators: RegimeIndicators }): PullbackSignal {
  const { candles, ema20, ema50, ema200, atr, regimeIndicators } = params;
  if (candles.length < 3 || ema20.length < 3 || ema50.length < 3 || ema200.length < 1 || atr.length < 3) {
    return { long: false, short: false, pullbackDetected: false, reclaimDetected: false, reason: 'not_enough_trigger_data' };
  }
  const current = candles[candles.length - 1], previous = candles[candles.length - 2];
  const currentEma20 = ema20[ema20.length - 1], previousEma20 = ema20[ema20.length - 2];
  const currentEma50 = ema50[ema50.length - 1], previousEma50 = ema50[ema50.length - 2];
  const currentEma200 = ema200[ema200.length - 1], currentAtr = atr[atr.length - 1];
  const ema20Rising = currentEma20 > previousEma20, ema20Falling = currentEma20 < previousEma20;
  const previousTouchedLongZone = previous.low <= previousEma20 || previous.low <= previousEma50;
  const previousTouchedShortZone = previous.high >= previousEma20 || previous.high >= previousEma50;
  const bullishReclaim = current.close > current.open && current.close > currentEma20 && current.close > previous.close;
  const bearishReclaim = current.close < current.open && current.close < currentEma20 && current.close < previous.close;
  const candleRangeAtr = getCandleRangeAtr(current, currentAtr), bodyAtr = getBodyAtr(current, currentAtr);
  const validCandle = candleRangeAtr <= MAX_SIGNAL_CANDLE_ATR && bodyAtr >= MIN_SIGNAL_BODY_ATR;
  const entryDistanceAtr = getEntryDistanceFromEma20Atr(current.close, currentEma20, currentAtr);
  const notExtended = entryDistanceAtr <= MAX_ENTRY_DISTANCE_FROM_EMA20_ATR;
  const longContext = current.close > currentEma200 && currentEma20 > currentEma50 && currentEma50 > currentEma200 && ema20Rising && regimeIndicators.plusDi > regimeIndicators.minusDi && regimeIndicators.adx >= MIN_ENTRY_ADX_LONG && regimeIndicators.adx <= MAX_ENTRY_ADX;
  const shortContext = current.close < currentEma200 && currentEma20 < currentEma50 && currentEma50 < currentEma200 && ema20Falling && regimeIndicators.minusDi > regimeIndicators.plusDi && regimeIndicators.adx >= MIN_ENTRY_ADX_SHORT && regimeIndicators.adx <= MAX_ENTRY_ADX;
  const long = longContext && previousTouchedLongZone && bullishReclaim && validCandle && notExtended;
  const short = shortContext && previousTouchedShortZone && bearishReclaim && validCandle && notExtended;
  if (long) return { long: true, short: false, pullbackDetected: true, reclaimDetected: true, reason: 'long_pullback_reclaim' };
  if (short) return { long: false, short: true, pullbackDetected: true, reclaimDetected: true, reason: 'short_pullback_reclaim' };
  return { long: false, short: false, pullbackDetected: previousTouchedLongZone || previousTouchedShortZone, reclaimDetected: bullishReclaim || bearishReclaim, reason: null };
}

type ImpulseContinuationSignal = { long: boolean; short: boolean; reason: string | null; impulseDetected: boolean; consolidationDetected: boolean; breakoutDetected: boolean; breakoutLevel: number | null; consolidationLow: number | null; consolidationHigh: number | null };
function noImpulseSignal(reason: string | null = null): ImpulseContinuationSignal { return { long: false, short: false, reason, impulseDetected: false, consolidationDetected: false, breakoutDetected: false, breakoutLevel: null, consolidationLow: null, consolidationHigh: null }; }

function detectImpulseContinuationSignal(params: { candles: Candle[]; ema20: number[]; ema50: number[]; ema200: number[]; atr: number[]; regimeIndicators: RegimeIndicators }): ImpulseContinuationSignal {
  const { candles, ema20, ema50, ema200, atr, regimeIndicators } = params;
  if (candles.length < 5 || ema20.length < 2 || ema50.length < 1 || ema200.length < 1 || atr.length < 4) return noImpulseSignal('not_enough_impulse_data');
  const impulse = candles[candles.length - 4], pauseOne = candles[candles.length - 3], pauseTwo = candles[candles.length - 2], current = candles[candles.length - 1];
  const currentAtr = atr[atr.length - 1], currentEma20 = ema20[ema20.length - 1], currentEma50 = ema50[ema50.length - 1], currentEma200 = ema200[ema200.length - 1];
  if (!Number.isFinite(currentAtr) || currentAtr <= 0) return noImpulseSignal('invalid_impulse_atr');
  const impulseRange = impulse.high - impulse.low, impulseBody = getBodySize(impulse);
  const impulseClosePosition = impulseRange > 0 ? (impulse.close - impulse.low) / impulseRange : 0.5;
  const impulseBodyAtr = impulseBody / currentAtr;
  const bullishImpulse = impulse.close > impulse.open && impulseBodyAtr >= IMPULSE_MIN_BODY_ATR && impulseBodyAtr <= IMPULSE_MAX_BODY_ATR && impulseClosePosition >= IMPULSE_MIN_CLOSE_POSITION;
  const bearishImpulse = impulse.close < impulse.open && impulseBodyAtr >= IMPULSE_MIN_BODY_ATR && impulseBodyAtr <= IMPULSE_MAX_BODY_ATR && impulseClosePosition <= 1 - IMPULSE_MIN_CLOSE_POSITION;
  const consolidationHigh = Math.max(pauseOne.high, pauseTwo.high), consolidationLow = Math.min(pauseOne.low, pauseTwo.low);
  const consolidationRange = consolidationHigh - consolidationLow;
  const consolidationDetected = consolidationRange <= currentAtr * IMPULSE_MAX_CONSOLIDATION_RANGE_ATR;
  const longContext = current.close > currentEma200 && currentEma20 > currentEma50 && currentEma50 > currentEma200 && regimeIndicators.plusDi > regimeIndicators.minusDi && regimeIndicators.adx >= IMPULSE_MIN_ADX && regimeIndicators.adx <= IMPULSE_MAX_ADX && pauseOne.close >= currentEma20 && pauseTwo.close >= currentEma20;
  const shortContext = current.close < currentEma200 && currentEma20 < currentEma50 && currentEma50 < currentEma200 && regimeIndicators.minusDi > regimeIndicators.plusDi && regimeIndicators.adx >= IMPULSE_MIN_ADX && regimeIndicators.adx <= IMPULSE_MAX_ADX && pauseOne.close <= currentEma20 && pauseTwo.close <= currentEma20;
  const breakoutUp = current.close > consolidationHigh && current.close > current.open && current.close - consolidationHigh <= currentAtr * IMPULSE_MAX_BREAKOUT_DRIFT_ATR;
  const breakoutDown = current.close < consolidationLow && current.close < current.open && consolidationLow - current.close <= currentAtr * IMPULSE_MAX_BREAKOUT_DRIFT_ATR;
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

export function canOpenTrade(params: { symbol: string; side: 'long' | 'short' | 'none'; price: number; ema20: number; lastRsi: number; atrPct: number; adx: number; adxRising?: boolean; plusDi?: number; minusDi?: number; bbWidth: number; bbWidthRising?: boolean; candleRangeAtr?: number; entryDistanceFromEma20: number; entryDistanceFromEma20Atr: number; entryTooExtended: boolean; pullbackDetected: boolean; reclaimDetected: boolean; entryPattern?: 'pullback_reclaim' | 'impulse_continuation' | 'breakout'; now?: Date }): FilterCheckResult {
  const { symbol, side, price, ema20, lastRsi, atrPct, adx, adxRising = true, plusDi = 0, minusDi = 0, bbWidth, bbWidthRising = true, candleRangeAtr = 0, entryDistanceFromEma20Atr, entryTooExtended, pullbackDetected, reclaimDetected, entryPattern = 'pullback_reclaim', now = new Date() } = params;
  if (!isTradingTimeUtcPlus4(now)) return { passed: false, failedFilter: 'trading_window' };
  if (isSymbolOnCooldown(symbol, now)) return { passed: false, failedFilter: 'cooldown' };
  if (side === 'long') { const baseSymbol = symbol.split('/')[0].toUpperCase(); if (LONG_BLACKLIST.includes(baseSymbol)) return { passed: false, failedFilter: 'blacklist' }; }
  if (side !== 'long' && side !== 'short') return { passed: false, failedFilter: 'invalid_side' };
  if (entryPattern === 'pullback_reclaim' && !pullbackDetected) return { passed: false, failedFilter: 'pullback_not_detected' };
  if (entryPattern === 'pullback_reclaim' && !reclaimDetected) return { passed: false, failedFilter: 'reclaim_not_detected' };
  if (!isPriceOnCorrectSideOfEma20(side, price, ema20)) return { passed: false, failedFilter: 'ema20_direction' };
  if (side === 'short' && (lastRsi < MIN_ENTRY_RSI_SHORT || lastRsi > MAX_ENTRY_RSI_SHORT)) return { passed: false, failedFilter: 'rsi' };
  if (side === 'long' && (lastRsi < MIN_ENTRY_RSI_LONG || lastRsi > MAX_ENTRY_RSI_LONG)) return { passed: false, failedFilter: 'rsi' };
  const maxAtrPct = side === 'long' ? MAX_LAST_ATR_PCT_LONG : MAX_LAST_ATR_PCT_SHORT;
  if (atrPct < MIN_LAST_ATR_PCT || atrPct > maxAtrPct) return { passed: false, failedFilter: 'atr_pct' };
  const minAdx = side === 'short' ? MIN_ENTRY_ADX_SHORT : MIN_ENTRY_ADX_LONG;
  if (adx < minAdx) return { passed: false, failedFilter: 'adx' };
  if (entryPattern === 'pullback_reclaim' && adx > MAX_ENTRY_ADX) return { passed: false, failedFilter: 'adx' };
  if (adx > HIGH_ADX_THRESHOLD && entryDistanceFromEma20Atr > HIGH_ADX_MAX_ENTRY_DISTANCE_ATR) return { passed: false, failedFilter: 'high_adx_entry_extended' };
  if (REQUIRE_ADX_RISING && !adxRising) return { passed: false, failedFilter: 'adx_not_rising' };
  if (REQUIRE_DI_DIRECTION) { if (side === 'long' && plusDi <= minusDi) return { passed: false, failedFilter: 'di_direction' }; if (side === 'short' && minusDi <= plusDi) return { passed: false, failedFilter: 'di_direction' }; }
  const minBbWidth = side === 'long' ? MIN_BB_WIDTH_LONG : MIN_BB_WIDTH_SHORT, maxBbWidth = side === 'long' ? MAX_BB_WIDTH_LONG : MAX_BB_WIDTH_SHORT;
  if (bbWidth < minBbWidth || bbWidth > maxBbWidth) return { passed: false, failedFilter: 'bb_width' };
  if (REQUIRE_BB_WIDTH_RISING && !bbWidthRising) return { passed: false, failedFilter: 'bb_width_not_rising' };
  if (candleRangeAtr > 0 && candleRangeAtr > MAX_SIGNAL_CANDLE_ATR) return { passed: false, failedFilter: 'signal_candle_too_large' };
  if (!Number.isFinite(entryDistanceFromEma20Atr)) return { passed: false, failedFilter: 'entry_distance_atr_invalid' };
  if (entryPattern === 'pullback_reclaim' && entryDistanceFromEma20Atr > MAX_ENTRY_DISTANCE_FROM_EMA20_ATR) return { passed: false, failedFilter: 'entry_distance_atr_high' };
  if (entryPattern === 'pullback_reclaim' && REJECT_ENTRY_TOO_EXTENDED && entryTooExtended) return { passed: false, failedFilter: 'entry_too_extended' };
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
  const ema20 = EMA.calculate({ period: 20, values: closes }), ema50 = EMA.calculate({ period: 50, values: closes });
  const ema200 = EMA.calculate({ period: 200, values: closes });
  const lastCandle = closedCandles[closedCandles.length - 1];
  const signalTime = lastCandle?.time ?? Date.now();
  const signalTimeIso = new Date(normalizeTimestamp(signalTime)).toISOString();
  const emptyIndicators = (): StrategyIndicators => ({ macdCrossUp: false, macdCrossDown: false, lastRsi: 0, lastAtr: 0, bbUpper: 0, bbMiddle: 0, bbLower: 0, regimeReady: false, regimeIndicators: regimeInfo.indicators ?? ({} as RegimeIndicators), entryExtensionAtr: null, maxEntryExtensionAtr: MAX_ENTRY_DISTANCE_FROM_EMA20_ATR, entryTooExtended: false, tradeFeeRate: TRADE_FEE_RATE, ready: false, atrPct: 0, adx: 0, adxRising: false, plusDi: 0, minusDi: 0, bbWidth: 0, bbWidthRising: false, candleRangeAtr: 0, ema20: 0, ema200: 0, priceVsEma200: null, entryDistanceFromEma20: null, entryDistanceFromEma20Atr: null, isCandleClosed: false, pullbackDetected: false, reclaimDetected: false, signalReason: null, entryPattern: null, impulseDetected: false, consolidationDetected: false, impulseBreakoutDetected: false, tce: null });
  if (closedCandles.length < TCE_REQUIRED_CANDLES || !regimeInfo.ready || !regimeInfo.indicators || macd.length < 2 || rsi.length < 1 || atr.length < 1 || bb.length < 1 || ema20.length < 3 || ema50.length < 3 || ema200.length < 1) {
    return { price: closes[closes.length - 1] ?? 0, buy: false, sell: false, side: 'none', takeProfitPrice: null, stopLossPrice: null, positionSize: null, regime: 'unknown', skipReason: 'Indicators not ready', signalTime, signalTimeIso, indicators: emptyIndicators() };
  }
  const price = last(closes);
  const lastMacd = macd[macd.length - 1], previousMacd = macd[macd.length - 2];
  const macdCrossUp = previousMacd.MACD != null && previousMacd.signal != null && lastMacd.MACD != null && lastMacd.signal != null && previousMacd.MACD < previousMacd.signal && lastMacd.MACD > lastMacd.signal;
  const macdCrossDown = previousMacd.MACD != null && previousMacd.signal != null && lastMacd.MACD != null && lastMacd.signal != null && previousMacd.MACD > previousMacd.signal && lastMacd.MACD < lastMacd.signal;
  const lastRsi = last(rsi), lastAtr = last(atr), lastBb = last(bb);
  const regime = regimeInfo.regime, regimeIndicators = regimeInfo.indicators;
  const trigger = detectPullbackReclaimSignal({ candles: closedCandles, ema20, ema50, ema200, atr, regimeIndicators });
  const impulseTrigger = detectImpulseContinuationSignal({ candles: closedCandles, ema20, ema50, ema200, atr, regimeIndicators });
  const riskCapital = STARTING_BALANCE * MAX_RISK_PER_TRADE, impulseRiskCapital = STARTING_BALANCE * IMPULSE_MAX_RISK_PER_TRADE;
  let side: 'long' | 'short' | 'none' = 'none', buy = false, sell = false;
  let takeProfitPrice: number | null = null, stopLossPrice: number | null = null, positionSize: number | null = null;
  let skipReason: string | null = null, entryExtensionAtr: number | null = null;
  const maxEntryExtensionAtr = MAX_ENTRY_DISTANCE_FROM_EMA20_ATR;
  let entryTooExtended = false, tce: TceMetrics | null = null;
  let entryPattern: 'pullback_reclaim' | 'impulse_continuation' | 'breakout' | null = null;
  const impulseDetected = impulseTrigger.impulseDetected, consolidationDetected = impulseTrigger.consolidationDetected, impulseBreakoutDetected = impulseTrigger.breakoutDetected;
  if (!tradingWindow.allowed) skipReason = tradingWindow.message;
  else if (regime === 'high_volatility' || regime === 'range') skipReason = `Trading disabled for regime: ${regime}`;
  else if (ENABLE_TREND_UP_TRADES && regime === 'trend_up' && trigger.long) { side = 'long'; buy = true; entryPattern = 'pullback_reclaim'; }
  else if (ENABLE_TREND_DOWN_TRADES && regime === 'trend_down' && trigger.short) { side = 'short'; sell = true; entryPattern = 'pullback_reclaim'; }
  else if (ENABLE_IMPULSE_CONTINUATION_TRADES && regime === 'trend_up' && impulseTrigger.long) { side = 'long'; buy = true; entryPattern = 'impulse_continuation'; }
  else if (ENABLE_IMPULSE_CONTINUATION_TRADES && regime === 'trend_down' && impulseTrigger.short) { side = 'short'; sell = true; entryPattern = 'impulse_continuation'; }
  else skipReason = trigger.reason == null ? 'No pullback/reclaim or impulse continuation signal' : `No valid signal: ${trigger.reason}`;
  // === SL/TP расчет - как в старой версии ===
  let atrUsedForExit: number | undefined = undefined;
  let slMultiplierUsed: number | undefined = undefined;
  let tpMultiplierUsed: number | undefined = undefined;
  if (side !== 'none' && lastAtr > 0) {
    entryExtensionAtr = getEntryDistanceFromEma20Atr(price, regimeIndicators.ema20, lastAtr);
    entryTooExtended = entryExtensionAtr > MAX_ENTRY_DISTANCE_FROM_EMA20_ATR;
    const consolidationLow = impulseTrigger.consolidationLow, consolidationHigh = impulseTrigger.consolidationHigh;
    const useImpulseExits = entryPattern === 'impulse_continuation' && consolidationLow != null && consolidationHigh != null;
    if (useImpulseExits) {
      stopLossPrice = side === 'long' ? consolidationLow - lastAtr * IMPULSE_STOP_BUFFER_ATR : consolidationHigh + lastAtr * IMPULSE_STOP_BUFFER_ATR;
      takeProfitPrice = side === 'long' ? price + lastAtr * IMPULSE_TAKE_PROFIT_ATR_MULTIPLIER : price - lastAtr * IMPULSE_TAKE_PROFIT_ATR_MULTIPLIER;
    } else {
      stopLossPrice = side === 'long' ? price - lastAtr * STOP_LOSS_ATR_MULTIPLIER : price + lastAtr * STOP_LOSS_ATR_MULTIPLIER;
      takeProfitPrice = side === 'long' ? price + lastAtr * TAKE_PROFIT_ATR_MULTIPLIER : price - lastAtr * TAKE_PROFIT_ATR_MULTIPLIER;
    }
    atrUsedForExit = lastAtr;
    slMultiplierUsed = useImpulseExits ? IMPULSE_STOP_BUFFER_ATR : STOP_LOSS_ATR_MULTIPLIER;
    tpMultiplierUsed = useImpulseExits ? IMPULSE_TAKE_PROFIT_ATR_MULTIPLIER : TAKE_PROFIT_ATR_MULTIPLIER;
    if (entryPattern === 'impulse_continuation' && (consolidationLow == null || consolidationHigh == null)) {
      const resetState = resetSignalState({ buy, sell, side, takeProfitPrice, stopLossPrice, positionSize });
      buy = resetState.buy; sell = resetState.sell; side = resetState.side; takeProfitPrice = resetState.takeProfitPrice; stopLossPrice = resetState.stopLossPrice; positionSize = resetState.positionSize;
      entryPattern = null;
      skipReason = 'Impulse continuation rejected: consolidation boundaries unavailable';
    }
  }
  if (ENABLE_BREAKOUT_TRADES && tradingWindow.allowed && regime === 'breakout_watch') {
    const lastSignalCandle = closedCandles[closedCandles.length - 1];
    if (lastSignalCandle == null) skipReason = 'No closed candle for breakout';
    else {
      const candleBody = Math.abs(lastSignalCandle.close - lastSignalCandle.open);
      const atrBuffer = lastAtr * BREAKOUT_ATR_BUFFER_K, minBody = lastAtr * BREAKOUT_BODY_ATR_MIN;
      const breakoutUp = lastSignalCandle.close > lastBb.upper + atrBuffer && candleBody >= minBody && lastRsi > 45 && lastRsi < 75;
      const breakoutDown = lastSignalCandle.close < lastBb.lower - atrBuffer && candleBody >= minBody && lastRsi < 55 && lastRsi > 25;
      const atrPct = price > 0 ? lastAtr / price : 0, bbWidth = getBbWidth(lastBb);
      const volatilityOkForBreakout = atrPct >= BREAKOUT_MIN_ATR_PCT && atrPct <= BREAKOUT_MAX_ATR_PCT && bbWidth >= BREAKOUT_MIN_BB_WIDTH && bbWidth <= BREAKOUT_MAX_BB_WIDTH;
      let extremumOk = true;
      if (breakoutUp || breakoutDown) {
        const sideForExtremum = breakoutUp ? 'long' : 'short';
        const { extremePrice } = findLocalExtremum(closedCandles, sideForExtremum, EXTREMUM_LOOKBACK);
        if (extremePrice !== 0 && lastAtr > 0) {
          const distanceFromExtremum = sideForExtremum === 'long' ? price - extremePrice : extremePrice - price;
          const distanceAtr = Math.abs(distanceFromExtremum) / lastAtr;
          if (distanceAtr > MAX_EXTREMUM_DISTANCE_ATR) extremumOk = false;
        }
      }
      if (volatilityOkForBreakout && extremumOk) {
        if (breakoutUp) {
          side = 'long'; buy = true; sell = false; entryPattern = 'breakout';
          stopLossPrice = price - lastAtr * 1.5; takeProfitPrice = price + lastAtr * 2.2;
          atrUsedForExit = lastAtr; slMultiplierUsed = 1.5; tpMultiplierUsed = 2.2;
        } else if (breakoutDown) {
          side = 'short'; sell = true; buy = false; entryPattern = 'breakout';
          stopLossPrice = price + lastAtr * 1.5; takeProfitPrice = price - lastAtr * 2.2;
          atrUsedForExit = lastAtr; slMultiplierUsed = 1.5; tpMultiplierUsed = 2.2;
        }
      }
    }
  }
  if ((buy || sell) && signalPrice != null && lastAtr > 0) {
    const favorableMove = side === 'long' ? price - signalPrice : signalPrice - price;
    const adverseMove = side === 'long' ? signalPrice - price : price - signalPrice;
    const favorableMoveAtr = favorableMove / lastAtr, adverseMoveAtr = adverseMove / lastAtr;
    if (adverseMoveAtr > MAX_ADVERSE_SIGNAL_MOVE_ATR) {
      const resetState = resetSignalState({ buy, sell, side, takeProfitPrice, stopLossPrice, positionSize });
      buy = resetState.buy; sell = resetState.sell; side = resetState.side; takeProfitPrice = resetState.takeProfitPrice; stopLossPrice = resetState.stopLossPrice; positionSize = resetState.positionSize;
      entryPattern = null;
      skipReason = `Price moved ${adverseMoveAtr.toFixed(2)} ATR against signal`;
    } else if (favorableMoveAtr > MAX_SIGNAL_DRIFT_ATR) {
      const resetState = resetSignalState({ buy, sell, side, takeProfitPrice, stopLossPrice, positionSize });
      buy = resetState.buy; sell = resetState.sell; side = resetState.side; takeProfitPrice = resetState.takeProfitPrice; stopLossPrice = resetState.stopLossPrice; positionSize = resetState.positionSize;
      entryPattern = null;
      skipReason = `Entry too late: price moved ${favorableMoveAtr.toFixed(2)} ATR in signal direction`;
    }
  }
  let entryDistanceFromEma20ForTrade: number | null = null, entryDistanceFromEma20AtrForTrade: number | null = null;
  if (side !== 'none' && stopLossPrice != null) {
    const entryDistanceFromEma20 = getEntryDistanceFromEma20(price, regimeIndicators.ema20);
    const entryDistanceFromEma20Atr = getEntryDistanceFromEma20Atr(price, regimeIndicators.ema20, lastAtr);
    entryDistanceFromEma20ForTrade = entryDistanceFromEma20; entryDistanceFromEma20AtrForTrade = entryDistanceFromEma20Atr;
    const filterResult = canOpenTrade({ symbol, side, price, ema20: regimeIndicators.ema20, lastRsi, atrPct: regimeIndicators.atrPct, adx: regimeIndicators.adx, adxRising: regimeIndicators.adxRising, plusDi: regimeIndicators.plusDi, minusDi: regimeIndicators.minusDi, bbWidth: regimeIndicators.bbWidth, bbWidthRising: regimeIndicators.bbWidthRising, candleRangeAtr: regimeIndicators.candleRangeAtr, entryDistanceFromEma20, entryDistanceFromEma20Atr, entryTooExtended, pullbackDetected: trigger.pullbackDetected, reclaimDetected: trigger.reclaimDetected, entryPattern: entryPattern ?? 'pullback_reclaim', now });
    if (!filterResult.passed) {
      const rejectedSide = side;
      const resetState = resetSignalState({ buy, sell, side, takeProfitPrice, stopLossPrice, positionSize });
      buy = resetState.buy; sell = resetState.sell; side = resetState.side; takeProfitPrice = resetState.takeProfitPrice; stopLossPrice = resetState.stopLossPrice; positionSize = resetState.positionSize;
      entryPattern = null;
      if (skipReason == null) {
        const failedFilter = filterResult.failedFilter ?? 'unknown';
        const isShortSide = rejectedSide === 'short';
        const rsiRange = isShortSide ? `${MIN_ENTRY_RSI_SHORT}–${MAX_ENTRY_RSI_SHORT}` : `${MIN_ENTRY_RSI_LONG}–${MAX_ENTRY_RSI_LONG}`;
        const adxRange = isShortSide ? `${MIN_ENTRY_ADX_SHORT}–${MAX_ENTRY_ADX}` : `${MIN_ENTRY_ADX_LONG}–${MAX_ENTRY_ADX}`;
        const atrRange = isShortSide ? `${MIN_LAST_ATR_PCT}–${MAX_LAST_ATR_PCT_SHORT}` : `${MIN_LAST_ATR_PCT}–${MAX_LAST_ATR_PCT_LONG}`;
        const distRange = `0–${MAX_ENTRY_DISTANCE_FROM_EMA20_ATR}`;
        skipReason = `Filter failed: ${failedFilter}\nSignal: ${trigger.reason ?? '-'}\nPullback: ${trigger.pullbackDetected}\nReclaim: ${trigger.reclaimDetected}\nRSI: ${lastRsi.toFixed(2)} [${rsiRange}]\nADX: ${regimeIndicators.adx.toFixed(2)} [${adxRange}]\nADX rising: ${regimeIndicators.adxRising}\n+DI/-DI: ${regimeIndicators.plusDi.toFixed(2)}/${regimeIndicators.minusDi.toFixed(2)}\nATR%: ${(regimeIndicators.atrPct * 100).toFixed(3)} [${atrRange}]\nBB Width: ${regimeIndicators.bbWidth.toFixed(5)}\nBB rising: ${regimeIndicators.bbWidthRising}\nCandle ATR: ${regimeIndicators.candleRangeAtr.toFixed(2)} [max ${MAX_SIGNAL_CANDLE_ATR}]\nEMA20 direction: ${failedFilter === 'ema20_direction' ? '❌ wrong side' : 'OK'}\nDist EMA20 ATR: ${entryDistanceFromEma20Atr.toFixed(3)} [${distRange}]\nToo Extended: ${entryTooExtended}`;
      }
    }
  }
  if (ENABLE_TCE_FILTER && side !== 'none' && stopLossPrice != null) {
    const sideBeforeTce = side;
    try {
      tce = calculateTce(closedCandles, sideBeforeTce, price, regimeIndicators.ema20, regimeIndicators.ema50, regimeIndicators.ema200);
      const tcePassed = tce.tceRegime === 'strong' && Number.isFinite(tce.tceScore) && tce.tceScore >= TCE_STRONG_MIN;
      if (!tcePassed) {
        const resetState = resetSignalState({ buy, sell, side, takeProfitPrice, stopLossPrice, positionSize });
        buy = resetState.buy; sell = resetState.sell; side = resetState.side; takeProfitPrice = resetState.takeProfitPrice; stopLossPrice = resetState.stopLossPrice; positionSize = resetState.positionSize;
        entryPattern = null;
        skipReason = `TCE filter rejected ${sideBeforeTce}: score=${Number.isFinite(tce.tceScore) ? tce.tceScore : '-'}, regime=${tce.tceRegime}, reason=${tce.tceReason}`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const resetState = resetSignalState({ buy, sell, side, takeProfitPrice, stopLossPrice, positionSize });
      buy = resetState.buy; sell = resetState.sell; side = resetState.side; takeProfitPrice = resetState.takeProfitPrice; stopLossPrice = resetState.stopLossPrice; positionSize = resetState.positionSize;
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
  return { price, buy, sell, side, takeProfitPrice, stopLossPrice, positionSize, regime, skipReason, signalTime, signalTimeIso, indicators: { macdCrossUp, macdCrossDown, lastRsi, lastAtr, bbUpper: lastBb.upper, bbMiddle: lastBb.middle, bbLower: lastBb.lower, regimeReady: regimeInfo.ready, regimeIndicators, entryExtensionAtr, maxEntryExtensionAtr, entryTooExtended, tradeFeeRate: TRADE_FEE_RATE, ready: regimeInfo.ready, atrPct: regimeIndicators.atrPct, adx: regimeIndicators.adx, adxRising: regimeIndicators.adxRising, plusDi: regimeIndicators.plusDi, minusDi: regimeIndicators.minusDi, bbWidth: regimeIndicators.bbWidth, bbWidthRising: regimeIndicators.bbWidthRising, candleRangeAtr: regimeIndicators.candleRangeAtr, ema20: regimeIndicators.ema20, ema200: regimeIndicators.ema200, priceVsEma200: regimeIndicators.ema200 > 0 ? (price - regimeIndicators.ema200) / regimeIndicators.ema200 : null, entryDistanceFromEma20: entryDistanceFromEma20ForLog, entryDistanceFromEma20Atr: entryDistanceFromEma20AtrForLog, isCandleClosed: closedCandles.length > 0, pullbackDetected: trigger.pullbackDetected, reclaimDetected: trigger.reclaimDetected, signalReason: entryPattern === 'impulse_continuation' ? impulseTrigger.reason : trigger.reason, entryPattern, impulseDetected, consolidationDetected, impulseBreakoutDetected, tce }, atrUsedForExit, slMultiplierUsed, tpMultiplierUsed };
}

export type TelegramSender = (message: string) => Promise<void>;

export async function notifyStrategyResult(result: StrategyResult, symbol: string, sendTelegramMessage: TelegramSender): Promise<void> {
  const tce = result.indicators.tce;
  const tceText = tce == null ? 'TCE: -' : `TCE score: ${Number.isFinite(tce.tceScore) ? tce.tceScore : '-'}\nTCE regime: ${tce.tceRegime}\nTCE reason: ${tce.tceReason}`;
  const diagnostics = `Signal: ${result.indicators.signalReason ?? '-'}\nEntry pattern: ${result.indicators.entryPattern ?? '-'}\nImpulse: ${result.indicators.impulseDetected}\nConsolidation: ${result.indicators.consolidationDetected}\nImpulse breakout: ${result.indicators.impulseBreakoutDetected}\nPullback: ${result.indicators.pullbackDetected}\nReclaim: ${result.indicators.reclaimDetected}\nRSI: ${result.indicators.lastRsi.toFixed(2)}\nADX: ${result.indicators.adx.toFixed(2)}\nADX rising: ${result.indicators.adxRising}\n+DI/-DI: ${result.indicators.plusDi.toFixed(2)}/${result.indicators.minusDi.toFixed(2)}\nATR%: ${(result.indicators.atrPct * 100).toFixed(3)}%\nBB Width: ${result.indicators.bbWidth.toFixed(5)}\nBB rising: ${result.indicators.bbWidthRising}\nCandle ATR: ${result.indicators.candleRangeAtr.toFixed(2)}\nDist EMA20 ATR: ${result.indicators.entryDistanceFromEma20Atr?.toFixed(3) ?? '-'}\nToo Extended: ${result.indicators.entryTooExtended}\nMACD: Up=${result.indicators.macdCrossUp}, Down=${result.indicators.macdCrossDown}`;
  if (result.skipReason != null) { await sendTelegramMessage(`⚠️ ${symbol} [${result.regime}]\n━━━━━━━━━━━━━━━━━━━━━━\n${diagnostics}\n━━━━━━━━━━━━━━━━━━━━━━\n${result.skipReason}\n━━━━━━━━━━━━━━━━━━━━━━\n${tceText}`); return; }
  if (result.buy || result.sell) {
    const direction = result.buy ? 'LONG' : 'SHORT';
    const tceDetails = tce == null ? '' : `\nTCE room ATR: ${Number.isFinite(tce.tceRoomAtr) ? tce.tceRoomAtr.toFixed(3) : '-'}\nTCE ER fast/slow: ${Number.isFinite(tce.tceErFast) ? tce.tceErFast.toFixed(3) : '-'} / ${Number.isFinite(tce.tceErSlow) ? tce.tceErSlow.toFixed(3) : '-'}`;
    const exitDebug = result.atrUsedForExit != null ? `\n[DEBUG] ATR: ${result.atrUsedForExit.toFixed(6)}, SL_mult: ${result.slMultiplierUsed?.toFixed(2) ?? '-'}, TP_mult: ${result.tpMultiplierUsed?.toFixed(2) ?? '-'}` : '';
    await sendTelegramMessage(`📊 ${symbol} ${direction} [${result.regime}]\n━━━━━━━━━━━━━━━━━━━━━━\nПричина: ${result.indicators.signalReason ?? '-'}\nЦена: ${result.price}\nTP: ${result.takeProfitPrice ?? '-'}\nSL: ${result.stopLossPrice ?? '-'}\nРазмер: ${result.positionSize ?? '-'}\n━━━━━━━━━━━━━━━━━━━━━━\n${diagnostics}\n━━━━━━━━━━━━━━━━━━━━━━\n${tceText}${tceDetails}\nРежим: ${result.regime}${exitDebug}`);
  }
}
