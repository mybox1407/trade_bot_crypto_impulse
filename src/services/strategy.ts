import { RSI, ATR, ADX, BollingerBands, EMA } from 'technicalindicators';
import type { Candle } from './lighterWs';

export const STARTING_BALANCE = 150;
export const MAX_RISK_PER_TRADE = 0.01;
export const ENABLE_TREND_UP_TRADES = true;
export const ENABLE_TREND_DOWN_TRADES = true;
export const SYMBOL_COOLDOWN_MS = 60 * 60 * 1000;
export const TRADE_FEE_RATE = 0.0;

const TRADING_HOUR_WINDOWS_UTC_PLUS_4: ReadonlyArray<
  readonly [number, number]
> = [[0, 24]];

export const MIN_ENTRY_RSI_LONG = 40;
export const MAX_ENTRY_RSI_LONG = 65;
export const MIN_ENTRY_RSI_SHORT = 35;
export const MAX_ENTRY_RSI_SHORT = 60;
export const MIN_ENTRY_ADX_LONG = 22;
export const MIN_ENTRY_ADX_SHORT = 22;
export const MAX_ENTRY_ADX = 45;
export const MIN_LAST_ATR_PCT = 0.001;
export const MAX_LAST_ATR_PCT_LONG = 0.04;
export const MAX_LAST_ATR_PCT_SHORT = 0.05;
export const MAX_BB_WIDTH_LONG = 0.12;
export const MAX_BB_WIDTH_SHORT = 0.12;
export const MAX_ENTRY_DISTANCE_FROM_EMA20_ATR = 0.85;
export const MAX_SIGNAL_CANDLE_ATR = 1.2;
export const MIN_SIGNAL_BODY_ATR = 0.35;
export const REQUIRE_DI_DIRECTION = true;
export const LONG_BLACKLIST = [''];

export const PULLBACK_LOOKBACK_CANDLES = 4;
export const PULLBACK_MAX_DEPTH_EMA20_ATR = 1.5;
export const PULLBACK_MAX_DEPTH_EMA50_ATR = 2.5;
export const RECLAIM_MIN_BODY_ATR = 0.35;
export const RECLAIM_MIN_CLOSE_POSITION = 0.6;
export const RECLAIM_VOLUME_VS_LAST_PULLBACK = 1.3;

export const STOP_LOSS_ATR_MULTIPLIER = 3.0;
export const TAKE_PROFIT_ATR_MULTIPLIER = 3.0;

const symbolCooldowns = new Map<string, number>();
const lastProcessedSignalCandleBySymbol = new Map<string, number>();

const getUtcPlus4 = (date = new Date()): number =>
  (date.getUTCHours() + 4) % 24;

const formatHour = (hour: number): string =>
  `${String(hour).padStart(2, '0')}:00`;

const normalizeTimestamp = (time: number): number =>
  time < 1e12 ? time * 1000 : time;

const getClosedCandles = (candles: Candle[]): Candle[] => candles;

const last = <T,>(values: T[]): T => values[values.length - 1];

const mean = (values: number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;

const getBodySize = (candle: Candle): number =>
  Math.abs(candle.close - candle.open);

const getBodyAtr = (candle: Candle, atr: number): number =>
  atr <= 0 ? 0 : getBodySize(candle) / atr;

const getCandleRangeAtr = (candle: Candle, atr: number): number =>
  atr <= 0 ? 0 : (candle.high - candle.low) / atr;

const getBbWidth = (bb: {
  upper: number;
  middle: number;
  lower: number;
}): number =>
  bb.middle !== 0 ? (bb.upper - bb.lower) / bb.middle : 0;

const isPriceOnCorrectSideOfEma20 = (
  side: 'long' | 'short',
  price: number,
  ema20: number
): boolean => (side === 'long' ? price > ema20 : price < ema20);

const getEntryDistanceFromEma20 = (
  price: number,
  ema20: number
): number => Math.abs(price - ema20);

const getEntryDistanceFromEma20Atr = (
  price: number,
  ema20: number,
  atr: number
): number =>
  atr <= 0
    ? Number.POSITIVE_INFINITY
    : Math.abs(price - ema20) / atr;

function indicatorValueAtCandle(
  values: number[],
  candleIndex: number,
  period: number
): number | undefined {
  const valueIndex = candleIndex - (period - 1);

  if (valueIndex < 0 || valueIndex >= values.length) {
    return undefined;
  }

  return values[valueIndex];
}

export function shouldProcess15mSignal(
  symbol: string,
  candles: Candle[]
): boolean {
  const closed = getClosedCandles(candles);
  const candle = closed[closed.length - 1];

  if (candle == null) return false;

  const timestamp = normalizeTimestamp(candle.time);
  const key = symbol.toUpperCase();

  if (lastProcessedSignalCandleBySymbol.get(key) === timestamp) {
    return false;
  }

  lastProcessedSignalCandleBySymbol.set(key, timestamp);
  return true;
}

export function reset15mSignalState(symbol?: string): void {
  if (symbol == null) {
    lastProcessedSignalCandleBySymbol.clear();
    return;
  }

  lastProcessedSignalCandleBySymbol.delete(symbol.toUpperCase());
}

export type TradingWindowCheck = {
  allowed: boolean;
  utcHour: number;
  utcPlus4Hour: number;
  message: string | null;
};

export function isTradingTimeUtcPlus4(date = new Date()): boolean {
  const hour = getUtcPlus4(date);

  return TRADING_HOUR_WINDOWS_UTC_PLUS_4.some(
    ([start, end]) => hour >= start && hour < end
  );
}

export function getTradingWindowCheck(
  date = new Date()
): TradingWindowCheck {
  const utcHour = date.getUTCHours();
  const utcPlus4Hour = getUtcPlus4(date);
  const allowed = isTradingTimeUtcPlus4(date);

  return allowed
    ? { allowed: true, utcHour, utcPlus4Hour, message: null }
    : {
        allowed: false,
        utcHour,
        utcPlus4Hour,
        message:
          `Сигнал вне торговых часов: UTC ${formatHour(utcHour)}, ` +
          `UTC+4 ${formatHour(utcPlus4Hour)}. Сделка не открыта.`
      };
}

export const getTradingTimeSkipReason = (
  date = new Date()
): string | null => getTradingWindowCheck(date).message;

export function getCooldownRemainingMs(
  lastTradeAt: Date | number | string | null | undefined,
  now = new Date()
): number {
  if (lastTradeAt == null) return 0;

  const timestamp =
    lastTradeAt instanceof Date
      ? lastTradeAt.getTime()
      : typeof lastTradeAt === 'number'
        ? lastTradeAt
        : new Date(lastTradeAt).getTime();

  if (!Number.isFinite(timestamp)) return 0;

  return Math.max(
    0,
    timestamp + SYMBOL_COOLDOWN_MS - now.getTime()
  );
}

export function isSymbolOnCooldown(
  symbol: string,
  now = new Date()
): boolean {
  const end = symbolCooldowns.get(symbol.toUpperCase());
  return end != null && now.getTime() < end;
}

export function setSymbolCooldown(
  symbol: string,
  now = new Date()
): void {
  symbolCooldowns.set(
    symbol.toUpperCase(),
    now.getTime() + SYMBOL_COOLDOWN_MS
  );
}

export function clearSymbolCooldown(symbol: string): void {
  symbolCooldowns.delete(symbol.toUpperCase());
}

export function getRemainingCooldownMs(
  symbol: string,
  now = new Date()
): number {
  const end = symbolCooldowns.get(symbol.toUpperCase());

  if (end == null) return 0;

  return Math.max(0, end - now.getTime());
}

export type MarketRegime =
  | 'trend_up'
  | 'trend_down'
  | 'range'
  | 'high_volatility'
  | 'unknown';

type RegimeIndicators = {
  lastClose: number;
  lastAtr: number;
  atrPct: number;
  adx: number;
  previousAdx: number;
  adxRising: boolean;
  plusDi: number;
  minusDi: number;
  ema20: number;
  ema50: number;
  ema200: number;
  previousEma20: number;
  previousEma50: number;
  bbWidth: number;
  previousBbWidth: number;
  bbWidthRising: boolean;
  avgVol20: number;
  candleRangeAtr: number;
  swingHigh: number;
  swingLow: number;
  prevSwingHigh: number;
  prevSwingLow: number;
  higherHigh: boolean;
  higherLow: boolean;
  lowerHigh: boolean;
  lowerLow: boolean;
  trendStructureUp: boolean;
  trendStructureDown: boolean;
  efficiencyRatio: number;
  netChange: number;
  sumAbsChanges: number;
};

type FilterCheckResult = {
  passed: boolean;
  failedFilter?: string;
};

type TouchedEma = 'ema20' | 'ema50' | 'both' | 'none';

export type StrategyIndicators = {
  lastRsi: number;
  lastAtr: number;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  regimeReady: boolean;
  regimeIndicators: RegimeIndicators;
  entryExtensionAtr: number | null;
  maxEntryExtensionAtr: number | null;
  entryTooExtended: boolean;
  ready: boolean;
  atrPct: number;
  adx: number;
  adxRising: boolean;
  plusDi: number;
  minusDi: number;
  bbWidth: number;
  bbWidthRising: boolean;
  candleRangeAtr: number;
  ema20: number;
  ema200: number;
  priceVsEma200: number | null;
  entryDistanceFromEma20: number | null;
  entryDistanceFromEma20Atr: number | null;
  isCandleClosed: boolean;
  pullbackDetected: boolean;
  reclaimDetected: boolean;
  signalReason: string | null;
  pullbackLongContext: boolean;
  pullbackShortContext: boolean;
  pullbackEma20Rising: boolean;
  pullbackEma20Falling: boolean;
  pullbackLongZone: boolean;
  pullbackShortZone: boolean;
  pullbackTouchedEma: TouchedEma;
  pullbackDepthAtr: number;
  pullbackLongTouchedEma: TouchedEma;
  pullbackShortTouchedEma: TouchedEma;
  pullbackLongDepthAtr: number;
  pullbackShortDepthAtr: number;
  pullbackLongDepthOk: boolean;
  pullbackShortDepthOk: boolean;
  bullishReclaim: boolean;
  bearishReclaim: boolean;
  pullbackValidCandle: boolean;
  pullbackNotExtended: boolean;
  pullbackVolumeOk: boolean;
  pullbackCandleRangeAtr: number;
  pullbackBodyAtr: number;
  pullbackVolumeRatio: number;
  pullbackEntryDistanceAtr: number;
  entryPattern: 'pullback_reclaim' | null;
  diagnosticPattern: 'pullback_reclaim' | null;
  diagnosticFailedFilter: string | null;
};

export type StrategyResult = {
  price: number;
  buy: boolean;
  sell: boolean;
  side: 'long' | 'short' | 'none';
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
  positionSize: number | null;
  regime: MarketRegime;
  skipReason: string | null;
  signalTime: number;
  signalTimeIso: string;
  indicators: StrategyIndicators;
  atrUsedForExit?: number;
  slMultiplierUsed?: number;
  tpMultiplierUsed?: number;
};

const MIN_ADX_TREND = 21;
const MIN_ADX_RANGE = 20;
const TREND_SWING_LOOKBACK = 20;
const ER_PERIOD = 20;
const MIN_EFFICIENCY_RATIO = 0.25;

type SignalState = {
  buy: boolean;
  sell: boolean;
  side: 'long' | 'short' | 'none';
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
  positionSize: number | null;
};

const resetSignalState = (state: SignalState): SignalState => ({
  ...state,
  buy: false,
  sell: false,
  side: 'none',
  takeProfitPrice: null,
  stopLossPrice: null,
  positionSize: null
});

type PullbackSignal = {
  long: boolean;
  short: boolean;
  pullbackDetected: boolean;
  reclaimDetected: boolean;
  reason: string | null;
  longContext: boolean;
  shortContext: boolean;
  ema20Rising: boolean;
  ema20Falling: boolean;
  longPullbackZone: boolean;
  shortPullbackZone: boolean;
  longTouchedEma: TouchedEma;
  shortTouchedEma: TouchedEma;
  longDepthOk: boolean;
  shortDepthOk: boolean;
  longPullbackDepthAtr: number;
  shortPullbackDepthAtr: number;
  depthOk: boolean;
  pullbackDepthAtr: number;
  bullishReclaim: boolean;
  bearishReclaim: boolean;
  validCandle: boolean;
  notExtended: boolean;
  volumeOk: boolean;
  candleRangeAtr: number;
  bodyAtr: number;
  volumeRatio: number;
  entryDistanceAtr: number;
};

const noPullbackSignal = (reason: string | null): PullbackSignal => ({
  long: false,
  short: false,
  pullbackDetected: false,
  reclaimDetected: false,
  reason,
  longContext: false,
  shortContext: false,
  ema20Rising: false,
  ema20Falling: false,
  longPullbackZone: false,
  shortPullbackZone: false,
  longTouchedEma: 'none',
  shortTouchedEma: 'none',
  longDepthOk: false,
  shortDepthOk: false,
  longPullbackDepthAtr: Number.POSITIVE_INFINITY,
  shortPullbackDepthAtr: Number.POSITIVE_INFINITY,
  depthOk: false,
  pullbackDepthAtr: 0,
  bullishReclaim: false,
  bearishReclaim: false,
  validCandle: false,
  notExtended: false,
  volumeOk: false,
  candleRangeAtr: 0,
  bodyAtr: 0,
  volumeRatio: 0,
  entryDistanceAtr: Number.POSITIVE_INFINITY
});

function detectPullbackReclaimSignal(params: {
  candles: Candle[];
  ema20: number[];
  ema50: number[];
  ema200: number[];
  atr: number[];
  regimeIndicators: RegimeIndicators;
}): PullbackSignal {
  const {
    candles,
    ema20,
    ema50,
    ema200,
    atr,
    regimeIndicators
  } = params;

  const lookback = PULLBACK_LOOKBACK_CANDLES;
  const currentIndex = candles.length - 1;
  const recentStartIndex = currentIndex - lookback;

  if (
    currentIndex < 0 ||
    recentStartIndex < 0 ||
    candles.length < 200
  ) {
    return noPullbackSignal('not_enough_trigger_data');
  }

  const current = candles[currentIndex];

  const currentEma20 = indicatorValueAtCandle(
    ema20,
    currentIndex,
    20
  );
  const previousEma20 = indicatorValueAtCandle(
    ema20,
    currentIndex - 1,
    20
  );
  const currentEma50 = indicatorValueAtCandle(
    ema50,
    currentIndex,
    50
  );
  const currentEma200 = indicatorValueAtCandle(
    ema200,
    currentIndex,
    200
  );
  const currentAtr = indicatorValueAtCandle(
    atr,
    currentIndex,
    14
  );

  if (
    currentEma20 == null ||
    previousEma20 == null ||
    currentEma50 == null ||
    currentEma200 == null ||
    currentAtr == null ||
    !Number.isFinite(currentAtr) ||
    currentAtr <= 0
  ) {
    return noPullbackSignal('invalid_trigger_indicators');
  }

  const ema20Rising = currentEma20 > previousEma20;
  const ema20Falling = currentEma20 < previousEma20;

  const recent = candles.slice(recentStartIndex, currentIndex);
  const recentEma20: number[] = [];
  const recentEma50: number[] = [];

  for (let i = 0; i < recent.length; i++) {
    const candleIndex = recentStartIndex + i;

    const ema20Value = indicatorValueAtCandle(
      ema20,
      candleIndex,
      20
    );
    const ema50Value = indicatorValueAtCandle(
      ema50,
      candleIndex,
      50
    );

    if (ema20Value == null || ema50Value == null) {
      return noPullbackSignal('invalid_pullback_ema_alignment');
    }

    recentEma20.push(ema20Value);
    recentEma50.push(ema50Value);
  }

  let touchedEma20Long = false;
  let touchedEma50Long = false;
  let touchedEma20Short = false;
  let touchedEma50Short = false;

  for (let i = 0; i < recent.length; i++) {
    const candle = recent[i];

    if (candle.low <= recentEma20[i]) {
      touchedEma20Long = true;
    }

    if (candle.low <= recentEma50[i]) {
      touchedEma50Long = true;
    }

    if (candle.high >= recentEma20[i]) {
      touchedEma20Short = true;
    }

    if (candle.high >= recentEma50[i]) {
      touchedEma50Short = true;
    }
  }

  const longPullbackZone =
    touchedEma20Long || touchedEma50Long;

  const shortPullbackZone =
    touchedEma20Short || touchedEma50Short;

  const longTouchedEma: TouchedEma =
    touchedEma20Long && touchedEma50Long
      ? 'both'
      : touchedEma20Long
        ? 'ema20'
        : touchedEma50Long
          ? 'ema50'
          : 'none';

  const shortTouchedEma: TouchedEma =
    touchedEma20Short && touchedEma50Short
      ? 'both'
      : touchedEma20Short
        ? 'ema20'
        : touchedEma50Short
          ? 'ema50'
          : 'none';

  const lowestLow = Math.min(
    ...recent.map(candle => candle.low)
  );

  const highestHigh = Math.max(
    ...recent.map(candle => candle.high)
  );

  const longReferenceEma = touchedEma20Long
    ? recentEma20
    : recentEma50;

  const shortReferenceEma = touchedEma20Short
    ? recentEma20
    : recentEma50;

  const longDepthAtr = longPullbackZone
    ? (
        Math.min(...longReferenceEma) - lowestLow
      ) / currentAtr
    : Number.POSITIVE_INFINITY;

  const shortDepthAtr = shortPullbackZone
    ? (
        highestHigh - Math.max(...shortReferenceEma)
      ) / currentAtr
    : Number.POSITIVE_INFINITY;

  const longDepthLimit = touchedEma20Long
    ? PULLBACK_MAX_DEPTH_EMA20_ATR
    : PULLBACK_MAX_DEPTH_EMA50_ATR;

  const shortDepthLimit = touchedEma20Short
    ? PULLBACK_MAX_DEPTH_EMA20_ATR
    : PULLBACK_MAX_DEPTH_EMA50_ATR;

  const longDepthOk =
    longPullbackZone &&
    Number.isFinite(longDepthAtr) &&
    longDepthAtr >= 0 &&
    longDepthAtr <= longDepthLimit;

  const shortDepthOk =
    shortPullbackZone &&
    Number.isFinite(shortDepthAtr) &&
    shortDepthAtr >= 0 &&
    shortDepthAtr <= shortDepthLimit;

  const depthOk = longDepthOk || shortDepthOk;

  const pullbackDepthAtr = longDepthOk
    ? longDepthAtr
    : shortDepthOk
      ? shortDepthAtr
      : 0;

  const candleRange = current.high - current.low;
  const candleRangeAtr = getCandleRangeAtr(current, currentAtr);
  const bodyAtr = getBodyAtr(current, currentAtr);

  const closePosition =
    candleRange > 0
      ? (current.close - current.low) / candleRange
      : 0.5;

  const volumes = candles.map(
    candle => Number(candle.volume) || 0
  );

  const avgVolume20 = mean(volumes.slice(-21, -1));
  const currentVolume = Number(current.volume) || 0;

  const volumeRatio =
    avgVolume20 > 0
      ? currentVolume / avgVolume20
      : 0;

  const lastPullbackVolume =
    recent.length > 0
      ? Number(recent[recent.length - 1].volume) || 0
      : 0;

  const volumeVsLastPullback =
    lastPullbackVolume > 0
      ? currentVolume / lastPullbackVolume
      : volumeRatio;

  const bullishReclaim =
    current.close > current.open &&
    current.close > currentEma20 &&
    longPullbackZone &&
    bodyAtr >= RECLAIM_MIN_BODY_ATR &&
    closePosition >= RECLAIM_MIN_CLOSE_POSITION &&
    volumeVsLastPullback >= RECLAIM_VOLUME_VS_LAST_PULLBACK;

  const bearishReclaim =
    current.close < current.open &&
    current.close < currentEma20 &&
    shortPullbackZone &&
    bodyAtr >= RECLAIM_MIN_BODY_ATR &&
    closePosition <= 1 - RECLAIM_MIN_CLOSE_POSITION &&
    volumeVsLastPullback >= RECLAIM_VOLUME_VS_LAST_PULLBACK;

  const validCandle =
    candleRangeAtr <= MAX_SIGNAL_CANDLE_ATR &&
    bodyAtr >= MIN_SIGNAL_BODY_ATR;

  const entryDistanceAtr = getEntryDistanceFromEma20Atr(
    current.close,
    currentEma20,
    currentAtr
  );

  const notExtended =
    entryDistanceAtr <= MAX_ENTRY_DISTANCE_FROM_EMA20_ATR;

  const longContext =
    current.close > currentEma200 &&
    currentEma20 > currentEma50 &&
    currentEma50 > currentEma200 &&
    ema20Rising &&
    regimeIndicators.plusDi > regimeIndicators.minusDi &&
    regimeIndicators.adx >= MIN_ENTRY_ADX_LONG &&
    regimeIndicators.adx <= MAX_ENTRY_ADX;

  const shortContext =
    current.close < currentEma200 &&
    currentEma20 < currentEma50 &&
    currentEma50 < currentEma200 &&
    ema20Falling &&
    regimeIndicators.minusDi > regimeIndicators.plusDi &&
    regimeIndicators.adx >= MIN_ENTRY_ADX_SHORT &&
    regimeIndicators.adx <= MAX_ENTRY_ADX;

  const long =
    longContext &&
    longPullbackZone &&
    longDepthOk &&
    bullishReclaim &&
    validCandle &&
    notExtended;

  const short =
    shortContext &&
    shortPullbackZone &&
    shortDepthOk &&
    bearishReclaim &&
    validCandle &&
    notExtended;

  const reason = long
    ? `long_pullback_reclaim_${longTouchedEma}`
    : short
      ? `short_pullback_reclaim_${shortTouchedEma}`
      : null;

  return {
    long,
    short,
    pullbackDetected: longPullbackZone || shortPullbackZone,
    reclaimDetected: bullishReclaim || bearishReclaim,
    reason,
    longContext,
    shortContext,
    ema20Rising,
    ema20Falling,
    longPullbackZone,
    shortPullbackZone,
    longTouchedEma,
    shortTouchedEma,
    longDepthOk,
    shortDepthOk,
    longPullbackDepthAtr: longDepthAtr,
    shortPullbackDepthAtr: shortDepthAtr,
    depthOk,
    pullbackDepthAtr,
    bullishReclaim,
    bearishReclaim,
    validCandle,
    notExtended,
    volumeOk:
      volumeVsLastPullback >= RECLAIM_VOLUME_VS_LAST_PULLBACK,
    candleRangeAtr,
    bodyAtr,
    volumeRatio,
    entryDistanceAtr
  };
}

function detectSwingStructure(
  candles: Candle[],
  lookback: number
): {
  swingHigh: number;
  swingLow: number;
  prevSwingHigh: number;
  prevSwingLow: number;
  higherHigh: boolean;
  higherLow: boolean;
  lowerHigh: boolean;
  lowerLow: boolean;
} {
  const empty = {
    swingHigh: 0,
    swingLow: 0,
    prevSwingHigh: 0,
    prevSwingLow: 0,
    higherHigh: false,
    higherLow: false,
    lowerHigh: false,
    lowerLow: false
  };

  if (candles.length < lookback + 5) {
    return empty;
  }

  const recent = candles.slice(-lookback);
  const swingHighs: number[] = [];
  const swingLows: number[] = [];

  for (let i = 2; i < recent.length - 2; i++) {
    const candle = recent[i];

    if (
      candle.high > recent[i - 1].high &&
      candle.high > recent[i - 2].high &&
      candle.high > recent[i + 1].high &&
      candle.high > recent[i + 2].high
    ) {
      swingHighs.push(candle.high);
    }

    if (
      candle.low < recent[i - 1].low &&
      candle.low < recent[i - 2].low &&
      candle.low < recent[i + 1].low &&
      candle.low < recent[i + 2].low
    ) {
      swingLows.push(candle.low);
    }
  }

  const recentSwingHighs = swingHighs.slice(-2);
  const recentSwingLows = swingLows.slice(-2);

  return {
    swingHigh:
      recentSwingHighs.length > 0
        ? recentSwingHighs[recentSwingHighs.length - 1]
        : 0,
    swingLow:
      recentSwingLows.length > 0
        ? recentSwingLows[recentSwingLows.length - 1]
        : 0,
    prevSwingHigh:
      recentSwingHighs.length > 1
        ? recentSwingHighs[0]
        : 0,
    prevSwingLow:
      recentSwingLows.length > 1
        ? recentSwingLows[0]
        : 0,
    higherHigh:
      recentSwingHighs.length > 1 &&
      recentSwingHighs[1] > recentSwingHighs[0],
    higherLow:
      recentSwingLows.length > 1 &&
      recentSwingLows[1] > recentSwingLows[0],
    lowerHigh:
      recentSwingHighs.length > 1 &&
      recentSwingHighs[1] < recentSwingHighs[0],
    lowerLow:
      recentSwingLows.length > 1 &&
      recentSwingLows[1] < recentSwingLows[0]
  };
}

function calculateEfficiencyRatio(
  closes: number[],
  period: number
): {
  efficiencyRatio: number;
  netChange: number;
  sumAbsChanges: number;
} {
  if (closes.length < period + 1) {
    return {
      efficiencyRatio: 0,
      netChange: 0,
      sumAbsChanges: 0
    };
  }

  const recent = closes.slice(-period - 1);
  const netChange = Math.abs(
    recent[recent.length - 1] - recent[0]
  );

  let sumAbsChanges = 0;

  for (let i = 1; i < recent.length; i++) {
    sumAbsChanges += Math.abs(recent[i] - recent[i - 1]);
  }

  return {
    efficiencyRatio:
      sumAbsChanges > 0 ? netChange / sumAbsChanges : 0,
    netChange,
    sumAbsChanges
  };
}

export function detectMarketRegime(candles: Candle[]): {
  regime: MarketRegime;
  ready: boolean;
  indicators: RegimeIndicators | null;
} {
  const closes = candles.map(candle => candle.close);
  const highs = candles.map(candle => candle.high);
  const lows = candles.map(candle => candle.low);
  const volumes = candles.map(
    candle => Number(candle.volume) || 0
  );

  const atr = ATR.calculate({
    period: 14,
    high: highs,
    low: lows,
    close: closes
  });

  const adx = ADX.calculate({
    period: 14,
    high: highs,
    low: lows,
    close: closes
  });

  const ema20 = EMA.calculate({
    period: 20,
    values: closes
  });

  const ema50 = EMA.calculate({
    period: 50,
    values: closes
  });

  const ema200 = EMA.calculate({
    period: 200,
    values: closes
  });

  const bb = BollingerBands.calculate({
    period: 20,
    values: closes,
    stdDev: 2
  });

  if (
    atr.length < 2 ||
    adx.length < 2 ||
    ema20.length < 2 ||
    ema50.length < 2 ||
    ema200.length < 1 ||
    bb.length < 2
  ) {
    return {
      regime: 'unknown',
      ready: false,
      indicators: null
    };
  }

  const lastClose = last(closes);
  const lastAtr = last(atr);
  const lastAdx = last(adx);
  const previousAdx = adx[adx.length - 2];

  const lastEma20 = last(ema20);
  const previousEma20 = ema20[ema20.length - 2];
  const lastEma50 = last(ema50);
  const previousEma50 = ema50[ema50.length - 2];

  const lastEma200 = last(ema200);
  const lastBb = last(bb);
  const previousBb = bb[bb.length - 2];

  const avgVol20 = mean(volumes.slice(-20));
  const bbWidth = getBbWidth(lastBb);
  const previousBbWidth = getBbWidth(previousBb);

  const adxValue = Number(lastAdx.adx) || 0;
  const previousAdxValue = Number(previousAdx.adx) || 0;
  const plusDi = Number(lastAdx.pdi) || 0;
  const minusDi = Number(lastAdx.mdi) || 0;

  const adxRising = adxValue > previousAdxValue;
  const bbWidthRising = bbWidth > previousBbWidth;
  const atrPct = lastClose > 0 ? lastAtr / lastClose : 0;

  const candleRangeAtr =
    candles.length > 0
      ? getCandleRangeAtr(candles[candles.length - 1], lastAtr)
      : 0;

  const swing = detectSwingStructure(
    candles,
    TREND_SWING_LOOKBACK
  );

  const er = calculateEfficiencyRatio(closes, ER_PERIOD);

  const trendStructureUp =
    (swing.higherHigh || swing.higherLow) &&
    er.efficiencyRatio >= MIN_EFFICIENCY_RATIO;

  const trendStructureDown =
    (swing.lowerHigh || swing.lowerLow) &&
    er.efficiencyRatio >= MIN_EFFICIENCY_RATIO;

  const strongTrendUp =
    lastClose > lastEma200 &&
    lastEma20 > lastEma50 &&
    lastEma50 > lastEma200 &&
    lastEma20 > previousEma20 &&
    trendStructureUp &&
    adxValue >= MIN_ADX_TREND &&
    plusDi > minusDi;

  const strongTrendDown =
    lastClose < lastEma200 &&
    lastEma20 < lastEma50 &&
    lastEma50 < lastEma200 &&
    lastEma20 < previousEma20 &&
    trendStructureDown &&
    adxValue >= MIN_ADX_TREND &&
    minusDi > plusDi;

  const range =
    adxValue < MIN_ADX_RANGE &&
    bbWidth < 0.08;

  const highVolatility =
    atrPct > 0.025 ||
    bbWidth > 0.12;

  let regime: MarketRegime = 'unknown';

  if (highVolatility) {
    regime = 'high_volatility';
  } else if (strongTrendUp) {
    regime = 'trend_up';
  } else if (strongTrendDown) {
    regime = 'trend_down';
  } else if (range) {
    regime = 'range';
  }

  return {
    regime,
    ready: true,
    indicators: {
      lastClose,
      lastAtr,
      atrPct,
      adx: adxValue,
      previousAdx: previousAdxValue,
      adxRising,
      plusDi,
      minusDi,
      ema20: lastEma20,
      ema50: lastEma50,
      ema200: lastEma200,
      previousEma20,
      previousEma50,
      bbWidth,
      previousBbWidth,
      bbWidthRising,
      avgVol20,
      candleRangeAtr,
      swingHigh: swing.swingHigh,
      swingLow: swing.swingLow,
      prevSwingHigh: swing.prevSwingHigh,
      prevSwingLow: swing.prevSwingLow,
      higherHigh: swing.higherHigh,
      higherLow: swing.higherLow,
      lowerHigh: swing.lowerHigh,
      lowerLow: swing.lowerLow,
      trendStructureUp,
      trendStructureDown,
      efficiencyRatio: er.efficiencyRatio,
      netChange: er.netChange,
      sumAbsChanges: er.sumAbsChanges
    }
  };
}

export function canOpenTrade(params: {
  symbol: string;
  side: 'long' | 'short' | 'none';
  price: number;
  ema20: number;
  lastRsi: number;
  atrPct: number;
  adx: number;
  adxRising?: boolean;
  plusDi?: number;
  minusDi?: number;
  bbWidth: number;
  bbWidthRising?: boolean;
  candleRangeAtr?: number;
  entryDistanceFromEma20: number;
  entryDistanceFromEma20Atr: number;
  entryTooExtended: boolean;
  pullbackDetected: boolean;
  reclaimDetected: boolean;
  entryPattern?: 'pullback_reclaim';
  now?: Date;
}): FilterCheckResult {
  const {
    symbol,
    side,
    price,
    ema20,
    lastRsi,
    atrPct,
    adx,
    plusDi = 0,
    minusDi = 0,
    bbWidth,
    candleRangeAtr = 0,
    entryDistanceFromEma20Atr,
    entryTooExtended,
    pullbackDetected,
    reclaimDetected,
    now = new Date()
  } = params;

  const isPullback = true;

  if (!isTradingTimeUtcPlus4(now)) {
    return { passed: false, failedFilter: 'trading_window' };
  }

  if (isSymbolOnCooldown(symbol, now)) {
    return { passed: false, failedFilter: 'cooldown' };
  }

  if (side !== 'long' && side !== 'short') {
    return { passed: false, failedFilter: 'invalid_side' };
  }

  if (side === 'long') {
    const base = symbol.split('/')[0].toUpperCase();

    if (LONG_BLACKLIST.includes(base)) {
      return { passed: false, failedFilter: 'blacklist' };
    }
  }

  if (isPullback && !pullbackDetected) {
    return { passed: false, failedFilter: 'pullback_not_detected' };
  }

  if (isPullback && !reclaimDetected) {
    return { passed: false, failedFilter: 'reclaim_not_detected' };
  }

  if (!isPriceOnCorrectSideOfEma20(side, price, ema20)) {
    return { passed: false, failedFilter: 'ema20_direction' };
  }

  if (isPullback) {
    if (
      side === 'long' &&
      (lastRsi < MIN_ENTRY_RSI_LONG ||
        lastRsi > MAX_ENTRY_RSI_LONG)
    ) {
      return { passed: false, failedFilter: 'rsi' };
    }

    if (
      side === 'short' &&
      (lastRsi < MIN_ENTRY_RSI_SHORT ||
        lastRsi > MAX_ENTRY_RSI_SHORT)
    ) {
      return { passed: false, failedFilter: 'rsi' };
    }
  }

  const maxAtrPct =
    side === 'long'
      ? MAX_LAST_ATR_PCT_LONG
      : MAX_LAST_ATR_PCT_SHORT;

  if (
    atrPct < MIN_LAST_ATR_PCT ||
    atrPct > maxAtrPct
  ) {
    return { passed: false, failedFilter: 'atr_pct' };
  }

  const minAdx =
    side === 'long'
      ? MIN_ENTRY_ADX_LONG
      : MIN_ENTRY_ADX_SHORT;

  if (adx < minAdx || adx > MAX_ENTRY_ADX) {
    return { passed: false, failedFilter: 'adx' };
  }

  if (REQUIRE_DI_DIRECTION) {
    if (side === 'long' && plusDi <= minusDi) {
      return { passed: false, failedFilter: 'di_direction' };
    }

    if (side === 'short' && minusDi <= plusDi) {
      return { passed: false, failedFilter: 'di_direction' };
    }
  }

  const maxBbWidth =
    side === 'long'
      ? MAX_BB_WIDTH_LONG
      : MAX_BB_WIDTH_SHORT;

  if (bbWidth > maxBbWidth) {
    return { passed: false, failedFilter: 'bb_width' };
  }

  if (
    candleRangeAtr > 0 &&
    candleRangeAtr > MAX_SIGNAL_CANDLE_ATR
  ) {
    return {
      passed: false,
      failedFilter: 'signal_candle_too_large'
    };
  }

  if (!Number.isFinite(entryDistanceFromEma20Atr)) {
    return {
      passed: false,
      failedFilter: 'entry_distance_atr_invalid'
    };
  }

  if (
    entryDistanceFromEma20Atr >
    MAX_ENTRY_DISTANCE_FROM_EMA20_ATR
  ) {
    return {
      passed: false,
      failedFilter: 'entry_distance_atr_high'
    };
  }

  if (entryTooExtended) {
    return { passed: false, failedFilter: 'entry_too_extended' };
  }

  return { passed: true };
}

export async function analyzeMarket(
  candles: Candle[],
  symbol: string,
  signalPrice?: number,
  now = new Date()
): Promise<StrategyResult> {
  const closedCandles = candles;
  const closes = closedCandles.map(candle => candle.close);
  const highs = closedCandles.map(candle => candle.high);
  const lows = closedCandles.map(candle => candle.low);

  const regimeInfo = detectMarketRegime(closedCandles);
  const tradingWindow = getTradingWindowCheck(now);

  const rsi = RSI.calculate({
    period: 14,
    values: closes
  });

  const atr = ATR.calculate({
    period: 14,
    high: highs,
    low: lows,
    close: closes
  });

  const bb = BollingerBands.calculate({
    period: 20,
    values: closes,
    stdDev: 2
  });

  const ema20 = EMA.calculate({
    period: 20,
    values: closes
  });

  const ema50 = EMA.calculate({
    period: 50,
    values: closes
  });

  const ema200 = EMA.calculate({
    period: 200,
    values: closes
  });

  const lastCandle = closedCandles[closedCandles.length - 1];
  const signalTime = lastCandle?.time ?? Date.now();
  const signalTimeIso = new Date(
    normalizeTimestamp(signalTime)
  ).toISOString();

  const emptyIndicators = (): StrategyIndicators => ({
    lastRsi: 0,
    lastAtr: 0,
    bbUpper: 0,
    bbMiddle: 0,
    bbLower: 0,
    regimeReady: false,
    regimeIndicators:
      regimeInfo.indicators ?? ({} as RegimeIndicators),
    entryExtensionAtr: null,
    maxEntryExtensionAtr: MAX_ENTRY_DISTANCE_FROM_EMA20_ATR,
    entryTooExtended: false,
    ready: false,
    atrPct: 0,
    adx: 0,
    adxRising: false,
    plusDi: 0,
    minusDi: 0,
    bbWidth: 0,
    bbWidthRising: false,
    candleRangeAtr: 0,
    ema20: 0,
    ema200: 0,
    priceVsEma200: null,
    entryDistanceFromEma20: null,
    entryDistanceFromEma20Atr: null,
    isCandleClosed: false,
    pullbackDetected: false,
    reclaimDetected: false,
    signalReason: null,
    pullbackLongContext: false,
    pullbackShortContext: false,
    pullbackEma20Rising: false,
    pullbackEma20Falling: false,
    pullbackLongZone: false,
    pullbackShortZone: false,
    pullbackTouchedEma: 'none',
    pullbackDepthAtr: 0,
    pullbackLongTouchedEma: 'none',
    pullbackShortTouchedEma: 'none',
    pullbackLongDepthAtr: 0,
    pullbackShortDepthAtr: 0,
    pullbackLongDepthOk: false,
    pullbackShortDepthOk: false,
    bullishReclaim: false,
    bearishReclaim: false,
    pullbackValidCandle: false,
    pullbackNotExtended: false,
    pullbackVolumeOk: false,
    pullbackCandleRangeAtr: 0,
    pullbackBodyAtr: 0,
    pullbackVolumeRatio: 0,
    pullbackEntryDistanceAtr: Number.POSITIVE_INFINITY,
    entryPattern: null,
    diagnosticPattern: null,
    diagnosticFailedFilter: null
  });

  if (
    closedCandles.length < 200 ||
    !regimeInfo.ready ||
    !regimeInfo.indicators ||
    rsi.length < 1 ||
    atr.length < 1 ||
    bb.length < 1 ||
    ema20.length < 3 ||
    ema50.length < 3 ||
    ema200.length < 1
  ) {
    return {
      price: closes[closes.length - 1] ?? 0,
      buy: false,
      sell: false,
      side: 'none',
      takeProfitPrice: null,
      stopLossPrice: null,
      positionSize: null,
      regime: 'unknown',
      skipReason: 'Indicators not ready',
      signalTime,
      signalTimeIso,
      indicators: emptyIndicators()
    };
  }

  const price = last(closes);
  const lastRsi = last(rsi);
  const lastAtr = last(atr);
  const lastBb = last(bb);
  const regime = regimeInfo.regime;
  const regimeIndicators = regimeInfo.indicators;

  const trigger = detectPullbackReclaimSignal({
    candles: closedCandles,
    ema20,
    ema50,
    ema200,
    atr,
    regimeIndicators
  });

  const riskCapital = STARTING_BALANCE * MAX_RISK_PER_TRADE;

  let side: 'long' | 'short' | 'none' = 'none';
  let buy = false;
  let sell = false;
  let takeProfitPrice: number | null = null;
  let stopLossPrice: number | null = null;
  let positionSize: number | null = null;
  let skipReason: string | null = null;
  
  const entryExtensionAtr = getEntryDistanceFromEma20Atr(
    price,
    regimeIndicators.ema20,
    lastAtr
  );
  
  const maxEntryExtensionAtr =
    MAX_ENTRY_DISTANCE_FROM_EMA20_ATR;
  
  const entryTooExtended =
    entryExtensionAtr > MAX_ENTRY_DISTANCE_FROM_EMA20_ATR;
  
  let entryPattern: 'pullback_reclaim' | null = null;
  let diagnosticPattern: 'pullback_reclaim' | null = null;
  let diagnosticFailedFilter: string | null = null;

  if (!tradingWindow.allowed) {
    skipReason = tradingWindow.message;
  } else if (
    regime === 'high_volatility' ||
    regime === 'range'
  ) {
    skipReason = `Trading disabled for regime: ${regime}`;
  } else if (
    ENABLE_TREND_UP_TRADES &&
    regime === 'trend_up' &&
    trigger.long
  ) {
    side = 'long';
    buy = true;
    entryPattern = 'pullback_reclaim';
  } else if (
    ENABLE_TREND_DOWN_TRADES &&
    regime === 'trend_down' &&
    trigger.short
  ) {
    side = 'short';
    sell = true;
    entryPattern = 'pullback_reclaim';
  } else {
    diagnosticPattern = 'pullback_reclaim';
    skipReason = 'No pullback/reclaim signal';
  }

  let atrUsedForExit: number | undefined;
  let slMultiplierUsed: number | undefined;
  let tpMultiplierUsed: number | undefined;

  if (side !== 'none' && lastAtr > 0) {
    stopLossPrice =
      side === 'long'
        ? price - lastAtr * STOP_LOSS_ATR_MULTIPLIER
        : price + lastAtr * STOP_LOSS_ATR_MULTIPLIER;

    takeProfitPrice =
      side === 'long'
        ? price + lastAtr * TAKE_PROFIT_ATR_MULTIPLIER
        : price - lastAtr * TAKE_PROFIT_ATR_MULTIPLIER;

    slMultiplierUsed = STOP_LOSS_ATR_MULTIPLIER;
    tpMultiplierUsed = TAKE_PROFIT_ATR_MULTIPLIER;
    atrUsedForExit = lastAtr;
  }

  let entryDistanceFromEma20ForTrade: number | null = null;
  let entryDistanceFromEma20AtrForTrade: number | null = null;

  if (side !== 'none' && stopLossPrice != null) {
    const entryDistanceFromEma20 =
      getEntryDistanceFromEma20(price, regimeIndicators.ema20);

    const entryDistanceFromEma20Atr =
      getEntryDistanceFromEma20Atr(
        price,
        regimeIndicators.ema20,
        lastAtr
      );

    entryDistanceFromEma20ForTrade =
      entryDistanceFromEma20;

    entryDistanceFromEma20AtrForTrade =
      entryDistanceFromEma20Atr;

    const filterResult = canOpenTrade({
      symbol,
      side,
      price,
      ema20: regimeIndicators.ema20,
      lastRsi,
      atrPct: regimeIndicators.atrPct,
      adx: regimeIndicators.adx,
      adxRising: regimeIndicators.adxRising,
      plusDi: regimeIndicators.plusDi,
      minusDi: regimeIndicators.minusDi,
      bbWidth: regimeIndicators.bbWidth,
      bbWidthRising: regimeIndicators.bbWidthRising,
      candleRangeAtr: regimeIndicators.candleRangeAtr,
      entryDistanceFromEma20,
      entryDistanceFromEma20Atr,
      entryTooExtended,
      pullbackDetected: trigger.pullbackDetected,
      reclaimDetected: trigger.reclaimDetected,
      now
    });

    if (!filterResult.passed) {
      diagnosticPattern =
        entryPattern ??
        diagnosticPattern ??
        'pullback_reclaim';

      diagnosticFailedFilter =
        filterResult.failedFilter ?? 'unknown';

      const rejectedSide = side;
      const rejectedPattern = entryPattern;

      const reset = resetSignalState({
        buy,
        sell,
        side,
        takeProfitPrice,
        stopLossPrice,
        positionSize
      });

      buy = reset.buy;
      sell = reset.sell;
      side = reset.side;
      takeProfitPrice = reset.takeProfitPrice;
      stopLossPrice = reset.stopLossPrice;
      positionSize = reset.positionSize;
      entryPattern = null;

      if (skipReason == null) {
        const failedFilter =
          filterResult.failedFilter ?? 'unknown';

        const isShortSide = rejectedSide === 'short';

        const rsiRange = isShortSide
          ? `${MIN_ENTRY_RSI_SHORT}–${MAX_ENTRY_RSI_SHORT}`
          : `${MIN_ENTRY_RSI_LONG}–${MAX_ENTRY_RSI_LONG}`;

        const adxRange = isShortSide
          ? `${MIN_ENTRY_ADX_SHORT}–${MAX_ENTRY_ADX}`
          : `${MIN_ENTRY_ADX_LONG}–${MAX_ENTRY_ADX}`;

        const atrRange = isShortSide
          ? `${MIN_LAST_ATR_PCT}–${MAX_LAST_ATR_PCT_SHORT}`
          : `${MIN_LAST_ATR_PCT}–${MAX_LAST_ATR_PCT_LONG}`;

        const signalReason = trigger.reason ?? '-';

        const sideDepth = isShortSide
          ? trigger.shortPullbackDepthAtr
          : trigger.longPullbackDepthAtr;

        const sideDepthOk = isShortSide
          ? trigger.shortDepthOk
          : trigger.longDepthOk;

        const sideTouchedEma = isShortSide
          ? trigger.shortTouchedEma
          : trigger.longTouchedEma;

        skipReason = [
          `Filter failed: ${failedFilter}`,
          `Signal: ${signalReason}`,
          `Entry pattern: ${rejectedPattern ?? '-'}`,
          `Pullback: ${trigger.pullbackDetected}`,
          `Reclaim: ${trigger.reclaimDetected}`,
          `Touched EMA: ${sideTouchedEma}`,
          `Pullback depth ATR: ${
            Number.isFinite(sideDepth)
              ? sideDepth.toFixed(2)
              : 'n/a'
          }`,
          `Depth OK: ${sideDepthOk}`,
          `RSI: ${lastRsi.toFixed(2)} [${rsiRange}]`,
          `ADX: ${regimeIndicators.adx.toFixed(2)} [${adxRange}]`,
          `ADX rising: ${regimeIndicators.adxRising}`,
          `+DI/-DI: ${regimeIndicators.plusDi.toFixed(2)}/${regimeIndicators.minusDi.toFixed(2)}`,
          `ATR%: ${(regimeIndicators.atrPct * 100).toFixed(3)} [${atrRange}]`,
          `BB Width: ${regimeIndicators.bbWidth.toFixed(5)}`,
          `BB rising: ${regimeIndicators.bbWidthRising}`,
          `Candle ATR: ${regimeIndicators.candleRangeAtr.toFixed(2)} [max ${MAX_SIGNAL_CANDLE_ATR}]`,
          `EMA20 direction: ${failedFilter === 'ema20_direction' ? 'wrong side' : 'OK'}`,
          `Dist EMA20 ATR: ${entryDistanceFromEma20Atr.toFixed(3)} [0–${MAX_ENTRY_DISTANCE_FROM_EMA20_ATR}]`,
          `Too Extended: ${entryTooExtended}`
        ].join('\n');
      }
    }
  }

  if (side !== 'none' && stopLossPrice != null) {
    const riskPerUnit = Math.abs(price - stopLossPrice);
    const capitalForTrade = riskCapital;

    positionSize =
      riskPerUnit > 0
        ? capitalForTrade / riskPerUnit
        : null;
  }

  const entryDistanceFromEma20ForLog =
    side !== 'none'
      ? getEntryDistanceFromEma20(price, regimeIndicators.ema20)
      : entryDistanceFromEma20ForTrade;

  const entryDistanceFromEma20AtrForLog =
    side !== 'none' &&
    lastAtr > 0 &&
    entryDistanceFromEma20ForLog != null
      ? entryDistanceFromEma20ForLog / lastAtr
      : entryDistanceFromEma20AtrForTrade;

  return {
    price,
    buy,
    sell,
    side,
    takeProfitPrice,
    stopLossPrice,
    positionSize,
    regime,
    skipReason,
    signalTime,
    signalTimeIso,
    indicators: {
      lastRsi,
      lastAtr,
      bbUpper: lastBb.upper,
      bbMiddle: lastBb.middle,
      bbLower: lastBb.lower,
      regimeReady: regimeInfo.ready,
      regimeIndicators,
      entryExtensionAtr,
      maxEntryExtensionAtr,
      entryTooExtended,
      ready: regimeInfo.ready,
      atrPct: regimeIndicators.atrPct,
      adx: regimeIndicators.adx,
      adxRising: regimeIndicators.adxRising,
      plusDi: regimeIndicators.plusDi,
      minusDi: regimeIndicators.minusDi,
      bbWidth: regimeIndicators.bbWidth,
      bbWidthRising: regimeIndicators.bbWidthRising,
      candleRangeAtr: regimeIndicators.candleRangeAtr,
      ema20: regimeIndicators.ema20,
      ema200: regimeIndicators.ema200,
      priceVsEma200:
        regimeIndicators.ema200 > 0
          ? (price - regimeIndicators.ema200) /
            regimeIndicators.ema200
          : null,
      entryDistanceFromEma20:
        entryDistanceFromEma20ForLog,
      entryDistanceFromEma20Atr:
        entryDistanceFromEma20AtrForLog,
      isCandleClosed: closedCandles.length > 0,
      pullbackDetected: trigger.pullbackDetected,
      reclaimDetected: trigger.reclaimDetected,
      pullbackLongContext: trigger.longContext,
      pullbackShortContext: trigger.shortContext,
      pullbackEma20Rising: trigger.ema20Rising,
      pullbackEma20Falling: trigger.ema20Falling,
      pullbackLongZone: trigger.longPullbackZone,
      pullbackShortZone: trigger.shortPullbackZone,
      pullbackTouchedEma:
        side === 'short'
          ? trigger.shortTouchedEma
          : trigger.longTouchedEma,
      pullbackDepthAtr:
        side === 'short'
          ? trigger.shortPullbackDepthAtr
          : trigger.longPullbackDepthAtr,
      pullbackLongTouchedEma: trigger.longTouchedEma,
      pullbackShortTouchedEma: trigger.shortTouchedEma,
      pullbackLongDepthAtr: trigger.longPullbackDepthAtr,
      pullbackShortDepthAtr: trigger.shortPullbackDepthAtr,
      pullbackLongDepthOk: trigger.longDepthOk,
      pullbackShortDepthOk: trigger.shortDepthOk,
      bullishReclaim: trigger.bullishReclaim,
      bearishReclaim: trigger.bearishReclaim,
      pullbackValidCandle: trigger.validCandle,
      pullbackNotExtended: trigger.notExtended,
      pullbackVolumeOk: trigger.volumeOk,
      pullbackCandleRangeAtr: trigger.candleRangeAtr,
      pullbackBodyAtr: trigger.bodyAtr,
      pullbackVolumeRatio: trigger.volumeRatio,
      pullbackEntryDistanceAtr: trigger.entryDistanceAtr,
      signalReason: trigger.reason,
      entryPattern,
      diagnosticPattern,
      diagnosticFailedFilter
    },
    atrUsedForExit,
    slMultiplierUsed,
    tpMultiplierUsed
  };
}

export type TelegramSender = (message: string) => Promise<void>;

export function formatStrategyDiagnostics(
  result: StrategyResult
): string {
  const indicators = result.indicators;
  const regimeIndicators = indicators.regimeIndicators;
  const pattern =
    indicators.diagnosticPattern ??
    indicators.entryPattern ??
    'pullback_reclaim';

  const side = result.side === 'short' ? 'short' : 'long';

  const rsiRange =
    side === 'short'
      ? `${MIN_ENTRY_RSI_SHORT}–${MAX_ENTRY_RSI_SHORT}`
      : `${MIN_ENTRY_RSI_LONG}–${MAX_ENTRY_RSI_LONG}`;

  const adxRange =
    side === 'short'
      ? `${MIN_ENTRY_ADX_SHORT}–${MAX_ENTRY_ADX}`
      : `${MIN_ENTRY_ADX_LONG}–${MAX_ENTRY_ADX}`;

  const maxAtrPct =
    side === 'short'
      ? MAX_LAST_ATR_PCT_SHORT
      : MAX_LAST_ATR_PCT_LONG;

  const maxDistanceAtr =
    MAX_ENTRY_DISTANCE_FROM_EMA20_ATR;

  const maxCandleAtr = MAX_SIGNAL_CANDLE_ATR;

  const ema20Direction =
    regimeIndicators.lastClose > regimeIndicators.ema20
      ? 'above EMA20'
      : 'below EMA20';

  const distEma20Atr =
    regimeIndicators.lastAtr > 0
      ? (
          Math.abs(
            regimeIndicators.lastClose - regimeIndicators.ema20
          ) / regimeIndicators.lastAtr
        ).toFixed(3)
      : '-';

  return [
    `Signal: ${indicators.signalReason ?? '-'}`,
    `Entry pattern: ${pattern}`,
    `Filter failed: ${indicators.diagnosticFailedFilter ?? '-'}`,
    '',
    '--- Pullback + Reclaim checks ---',
    `Pullback detected: ${indicators.pullbackDetected}`,
    `Long pullback zone: ${indicators.pullbackLongZone ? 'OK' : 'FAILED'}`,
    `Short pullback zone: ${indicators.pullbackShortZone ? 'OK' : 'FAILED'}`,
    `Long touched EMA: ${indicators.pullbackLongTouchedEma}`,
    `Long pullback depth ATR: ${
      Number.isFinite(indicators.pullbackLongDepthAtr)
        ? indicators.pullbackLongDepthAtr.toFixed(2)
        : 'n/a'
    } [max ${PULLBACK_MAX_DEPTH_EMA20_ATR}/${PULLBACK_MAX_DEPTH_EMA50_ATR}], OK: ${indicators.pullbackLongDepthOk}`,
    `Short touched EMA: ${indicators.pullbackShortTouchedEma}`,
    `Short pullback depth ATR: ${
      Number.isFinite(indicators.pullbackShortDepthAtr)
        ? indicators.pullbackShortDepthAtr.toFixed(2)
        : 'n/a'
    } [max ${PULLBACK_MAX_DEPTH_EMA20_ATR}/${PULLBACK_MAX_DEPTH_EMA50_ATR}], OK: ${indicators.pullbackShortDepthOk}`,
    `Long context: ${indicators.pullbackLongContext ? 'OK' : 'FAILED'}`,
    `Short context: ${indicators.pullbackShortContext ? 'OK' : 'FAILED'}`,
    `EMA20 rising: ${indicators.pullbackEma20Rising ? 'OK' : 'FAILED'}`,
    `EMA20 falling: ${indicators.pullbackEma20Falling ? 'OK' : 'FAILED'}`,
    `Bullish reclaim: ${indicators.bullishReclaim ? 'OK' : 'FAILED'}`,
    `Bearish reclaim: ${indicators.bearishReclaim ? 'OK' : 'FAILED'}`,
    `Reclaim detected: ${indicators.reclaimDetected}`,
    `Candle filter: ${indicators.pullbackValidCandle ? 'OK' : 'FAILED'}`,
    `Candle ATR: ${indicators.pullbackCandleRangeAtr.toFixed(2)} [max ${MAX_SIGNAL_CANDLE_ATR}]`,
    `Body ATR: ${indicators.pullbackBodyAtr.toFixed(2)} [min ${MIN_SIGNAL_BODY_ATR}]`,
    `Volume ratio (vs avg20): ${indicators.pullbackVolumeRatio.toFixed(2)}`,
    `Volume filter (vs last pullback): ${indicators.pullbackVolumeOk ? 'OK' : 'FAILED'}`,
    `Distance EMA20 ATR: ${
      Number.isFinite(indicators.pullbackEntryDistanceAtr)
        ? indicators.pullbackEntryDistanceAtr.toFixed(3)
        : '-'
    } [max ${MAX_ENTRY_DISTANCE_FROM_EMA20_ATR}]`,
    `Extension filter: ${indicators.pullbackNotExtended ? 'OK' : 'FAILED'}`,
    '',
    '--- General filters ---',
    `RSI: ${indicators.lastRsi.toFixed(2)} [${rsiRange}]`,
    `ADX: ${indicators.adx.toFixed(2)} [${adxRange}]`,
    `ADX rising: ${indicators.adxRising}`,
    `+DI/-DI: ${indicators.plusDi.toFixed(2)}/${indicators.minusDi.toFixed(2)}`,
    `ATR%: ${(indicators.atrPct * 100).toFixed(3)} [${(MIN_LAST_ATR_PCT * 100).toFixed(1)}–${(maxAtrPct * 100).toFixed(1)}]`,
    `BB Width: ${indicators.bbWidth.toFixed(5)}`,
    `BB rising: ${indicators.bbWidthRising}`,
    `Candle ATR: ${indicators.candleRangeAtr.toFixed(2)} [max ${maxCandleAtr}]`,
    `EMA20 direction: ${ema20Direction}`,
    `Dist EMA20 ATR: ${distEma20Atr} [0–${maxDistanceAtr}]`,
    `Too Extended: ${indicators.entryTooExtended}`
  ].join('\n');
}

export async function notifyStrategyResult(
  result: StrategyResult,
  symbol: string,
  sendTelegramMessage: TelegramSender
): Promise<void> {
  const diagnostics = formatStrategyDiagnostics(result);

  if (result.skipReason != null) {
    await sendTelegramMessage(
      `${symbol} [${result.regime}]: No signal
━━━━━━━━━━━━━━━━━━━━━━
${diagnostics}
━━━━━━━━━━━━━━━━━━━━━━
Reason: ${result.skipReason}`
    );
    return;
  }

  if (result.buy || result.sell) {
    const direction = result.buy ? 'LONG' : 'SHORT';

    const exitDebug =
      result.atrUsedForExit != null
        ? `[DEBUG] ATR: ${result.atrUsedForExit.toFixed(6)}, ` +
          `SL_mult: ${result.slMultiplierUsed?.toFixed(2) ?? '-'}, ` +
          `TP_mult: ${result.tpMultiplierUsed?.toFixed(2) ?? '-'}`
        : '';

    await sendTelegramMessage(
      `📊 ${symbol} ${direction} [${result.regime}]
━━━━━━━━━━━━━━━━━━━━━━
Причина: ${result.indicators.signalReason ?? '-'}
Цена: ${result.price}
TP: ${result.takeProfitPrice ?? '-'}
SL: ${result.stopLossPrice ?? '-'}
Размер: ${result.positionSize ?? '-'}
━━━━━━━━━━━━━━━━━━━━━━
${diagnostics}${exitDebug ? `\n${exitDebug}` : ''}`
    );
  }
}
