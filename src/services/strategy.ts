// src/services/strategy.ts

import type { LighterTrade } from './lighterWs';

export const STARTING_BALANCE = 150;
export const MAX_RISK_PER_TRADE = 0.01;
export const TRADE_FEE_RATE = 0.0;

export const FLOW_WINDOW_MS = 3_000;
export const FLOW_BASELINE_MS = 60_000;
export const FLOW_BASELINE_BUCKETS = 10;
export const FLOW_SPIKE_MULTIPLIER = 3.5;
export const FLOW_MIN_IMBALANCE = 0.70;
export const FLOW_MIN_DIRECTIONAL_MOVE_ATR = 0.15;
export const FLOW_MAX_CHASE_ATR = 0.8;
export const FLOW_STOP_ATR_MULTIPLIER = 1.0;
export const FLOW_TAKE_PROFIT_ATR_MULTIPLIER = 1.5;
export const FLOW_MIN_BASELINE_BUCKETS = 5;
export const FLOW_MAX_TRADE_AGE_MS = 5_000;
export const FLOW_EXCLUDE_LIQUIDATIONS = true;

export const WINDOW_MINUTES_DOWN = 600;
export const EMA_PERIOD_DOWN = 5;
export const SLOPE_BARS_DOWN = 4;
export const ENABLE_DOWN_LONG_S2 = true;
export const ENABLE_DOWN_SHORT_S2 = true;

export const ENABLE_UP_SHORT = true;
export const WINDOW_MINUTES_UP_SHORT = 600;
export const ATR_PERIOD_UP_SHORT = 14;
export const EMA_PERIOD_UP_SHORT = 2;
export const SLOPE_BARS_UP_SHORT = 2;
export const RV_WINDOW_UP_SHORT = 10;
export const RV_BASELINE_UP_SHORT = 30;
export const RV_AVOID_MIN_UP_SHORT = 0.05;
export const RV_AVOID_MAX_UP_SHORT = 0.10;
export const ATR_MAX_UP_SHORT = 0.50;
export const MAX_EMA_SLOPE_PCT_30M_UP_SHORT = 1.50;
export const ENABLE_UP_SHORT_CONDITIONAL_BAN = true;
export const ATR_BAN_MIN_UP_SHORT = 0.15;
export const ATR_BAN_MAX_UP_SHORT = 0.20;
export const SLOPE_1H_BAN_MIN_UP_SHORT = 0.30;
export const UP_SHORT_CONFIRM_SLOPE_BOUNDARY = 0.40;
export const POSITION_WINDOW_UP_SHORT = 60;
export const POSITION_MIDDLE_MIN_UP_SHORT = 1 / 3;
export const POSITION_MIDDLE_MAX_UP_SHORT = 2 / 3;

export const ENABLE_UP_LONG = true;
export const WINDOW_MINUTES_UP_LONG = 600;
export const ATR_PERIOD_UP_LONG = 14;
export const EMA_PERIOD_UP_LONG = 3;
export const SLOPE_BARS_UP_LONG = 3;
export const ATR_MIN_UP_LONG = 0.10;
export const ATR_MAX_UP_LONG = 0.30;
export const UP_LONG_STREAK_MIN = 3;
export const ENABLE_UP_LONG_S2 = true;

// ============================================================
// Entry-quality filters (backtest: 2026-10-26 -> 2026-10-27)
// ============================================================

// down_short полностью отключён.
export const ENABLE_DOWN_SHORT = false;

// down_long
export const DOWN_LONG_MAX_NOTIONAL_PCT = 0.2995;
export const DOWN_LONG_MIN_STOP_PCT = 0.0035;
export const DOWN_LONG_MAX_STOP_PCT = 0.0075;
export const DOWN_LONG_MAX_EXECUTION_LATENCY_MS = 60_000;

// up_long
export const UP_LONG_MAX_NOTIONAL_PCT = 0.298;

// up_short
export const UP_SHORT_MIN_STOP_PCT = 0.0035;
export const UP_SHORT_BLOCKED_SYMBOLS = new Set<string>([]);

const MINUTE_MS = 60_000;
const MAX_WINDOW_MINUTES = Math.max(
  WINDOW_MINUTES_DOWN,
  WINDOW_MINUTES_UP_SHORT,
  WINDOW_MINUTES_UP_LONG
);

export type TradeFlowSide = 'long' | 'short' | 'none';
export type StrategyGroup = 'down_long' | 'down_short' | 'up_short' | 'up_long' | 'none';
export type TrendDirection = 'up' | 'down' | 'neutral' | 'no_data';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TradeHistoryEntry {
  symbol: string;
  side: 'long' | 'short';
  openedAt: number;
  netPnL: number;
}

export interface TradeFlowIndicators {
  windowMs: number;
  windowTradeCount: number;
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
  baselineVolumePerWindow: number | null;
  volumeMultiple: number | null;
  imbalance: number;
  referencePrice: number | null;
  priceMoveAtr: number | null;
  excludedLiquidationCount: number;
  baselineNonEmptyBuckets: number;
}

export interface HtfRegime {
  slope: number | null;
  ema: number | null;
}

export interface RegimeFeatures {
  close: number | null;
  atr: number | null;
  atrPct: number | null;
  rv: number | null;
  direction1h: TrendDirection;
  direction30m: TrendDirection;
  slope1hPct: number | null;
  slope30mPct: number | null;
  ema1h: number | null;
  ema30m: number | null;
}

export interface TradeState {
  down: RegimeFeatures;
  upShort: RegimeFeatures;
  upLong: RegimeFeatures;
  ret5Pct: number | null;
  ret15Pct: number | null;
  previous10Pct: number | null;
  position60: number | null;
  priceVsEma30mUpShortAtr: number | null;
  closeAboveEma30mUpLong: boolean;
  upLongRegime: boolean;
  windowStart: number | null;
  windowEnd: number | null;
  windowCandles: number;
}

export interface RawTradeFlowSignal {
  side: 'long' | 'short';
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  slTpAtr: number;
  signalTime: number;
}

export interface TradeFlowResult {
  symbol: string;
  ready: boolean;
  buy: boolean;
  sell: boolean;
  side: TradeFlowSide;
  price: number;
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
  positionSize: number | null;
  regime: string;
  group: StrategyGroup;
  skipReason: string | null;
  signalTime: number;
  signalTimeIso: string;
  indicators: TradeFlowIndicators;
  tradeState: TradeState | null;
  rawSignal: boolean;
  rawSignalData: RawTradeFlowSignal | null;
}

export interface TradeFlowConfig {
  windowMs: number;
  baselineMs: number;
  baselineBuckets: number;
  spikeMultiplier: number;
  minImbalance: number;
  minDirectionalMoveAtr: number;
  maxChaseAtr: number;
  stopAtrMultiplier: number;
  takeProfitAtrMultiplier: number;
  minBaselineBuckets: number;
  maxTradeAgeMs: number;
  excludeLiquidations: boolean;
}

export const DEFAULT_TRADE_FLOW_CONFIG: TradeFlowConfig = {
  windowMs: FLOW_WINDOW_MS,
  baselineMs: FLOW_BASELINE_MS,
  baselineBuckets: FLOW_BASELINE_BUCKETS,
  spikeMultiplier: FLOW_SPIKE_MULTIPLIER,
  minImbalance: FLOW_MIN_IMBALANCE,
  minDirectionalMoveAtr: FLOW_MIN_DIRECTIONAL_MOVE_ATR,
  maxChaseAtr: FLOW_MAX_CHASE_ATR,
  stopAtrMultiplier: FLOW_STOP_ATR_MULTIPLIER,
  takeProfitAtrMultiplier: FLOW_TAKE_PROFIT_ATR_MULTIPLIER,
  minBaselineBuckets: FLOW_MIN_BASELINE_BUCKETS,
  maxTradeAgeMs: FLOW_MAX_TRADE_AGE_MS,
  excludeLiquidations: FLOW_EXCLUDE_LIQUIDATIONS
};

export interface TradeFlowBaseline {
  ready: boolean;
  nonEmptyBuckets: number;
  volumePerWindow: number | null;
  reason: string | null;
}

export class TradeFlowBaselineTracker {
  private readonly secondBuckets = new Map<number, number>();

  constructor(private readonly config: TradeFlowConfig = DEFAULT_TRADE_FLOW_CONFIG) {}

  addTrade(trade: LighterTrade): void {
    if (!isValidTrade(trade) || (this.config.excludeLiquidations && trade.isLiquidation)) return;

    const notional = getNotional(trade);
    if (!Number.isFinite(notional) || notional <= 0) return;

    const bucket = Math.floor(trade.receivedAt / 1_000) * 1_000;

    this.secondBuckets.set(bucket, (this.secondBuckets.get(bucket) ?? 0) + notional);
    this.prune(trade.receivedAt);
  }

  getBaseline(now = Date.now()): TradeFlowBaseline {
    this.prune(now);

    const start = now - this.config.windowMs - this.config.baselineMs;
    const end = now - this.config.windowMs;
    const bucketDuration = this.config.baselineMs / this.config.baselineBuckets;
    const volumes = Array<number>(this.config.baselineBuckets).fill(0);

    for (const [timestamp, volume] of this.secondBuckets) {
      if (timestamp < start || timestamp >= end) continue;

      const index = Math.min(
        this.config.baselineBuckets - 1,
        Math.floor((timestamp - start) / bucketDuration)
      );

      if (index >= 0) volumes[index] += volume;
    }

    const nonEmpty = volumes.filter(volume => volume > 0).length;

    if (nonEmpty < this.config.minBaselineBuckets) {
      return {
        ready: false,
        nonEmptyBuckets: nonEmpty,
        volumePerWindow: null,
        reason: `Warming trade-flow baseline: ${nonEmpty}/${this.config.minBaselineBuckets} active buckets`
      };
    }

    const volumePerWindow = volumes.reduce((sum, volume) => sum + volume, 0) / this.config.baselineBuckets;

    if (!Number.isFinite(volumePerWindow) || volumePerWindow <= 0) {
      return { ready: false, nonEmptyBuckets: nonEmpty, volumePerWindow: null, reason: 'Baseline volume is zero' };
    }

    return { ready: true, nonEmptyBuckets: nonEmpty, volumePerWindow: volumePerWindow, reason: null };
  }

  reset(): void {
    this.secondBuckets.clear();
  }

  private prune(now: number): void {
    const oldest = now - this.config.windowMs - this.config.baselineMs - 2_000;

    for (const timestamp of this.secondBuckets.keys()) {
      if (timestamp < oldest) this.secondBuckets.delete(timestamp);
    }
  }
}

interface Aggregate {
  buyVolume: number;
  sellVolume: number;
  count: number;
  firstPrice: number | null;
  lastPrice: number | null;
  excludedLiquidationCount: number;
}

function isValidTrade(trade: LighterTrade): boolean {
  return (
    Number.isFinite(trade.time) &&
    Number.isFinite(trade.receivedAt) &&
    Number.isFinite(trade.price) &&
    trade.price > 0 &&
    Number.isFinite(trade.size) &&
    trade.size > 0 &&
    (trade.aggressorSide === 'buy' || trade.aggressorSide === 'sell')
  );
}

function getNotional(trade: LighterTrade): number {
  if (trade.usdAmount != null && Number.isFinite(trade.usdAmount) && trade.usdAmount > 0) {
    return trade.usdAmount;
  }

  return trade.price * trade.size;
}

function aggregate(
  trades: LighterTrade[],
  fromTime: number,
  toTime: number,
  excludeLiquidations: boolean
): Aggregate {
  let buyVolume = 0;
  let sellVolume = 0;
  let count = 0;
  let firstPrice: number | null = null;
  let lastPrice: number | null = null;
  let excludedLiquidationCount = 0;

  const sorted = trades
    .filter(trade => isValidTrade(trade) && trade.receivedAt >= fromTime && trade.receivedAt < toTime)
    .sort((a, b) => a.receivedAt - b.receivedAt);

  for (const trade of sorted) {
    if (excludeLiquidations && trade.isLiquidation) {
      excludedLiquidationCount += 1;
      continue;
    }

    const volume = getNotional(trade);

    if (trade.aggressorSide === 'buy') buyVolume += volume;
    else sellVolume += volume;

    count += 1;

    if (firstPrice == null) firstPrice = trade.price;
    lastPrice = trade.price;
  }

  return { buyVolume, sellVolume, count, firstPrice, lastPrice, excludedLiquidationCount };
}

function getDirection(slope: number | null): TrendDirection {
  if (slope == null || !Number.isFinite(slope)) return 'no_data';
  if (slope > 0) return 'up';
  if (slope < 0) return 'down';
  return 'neutral';
}

function percentOfClose(value: number | null, close: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (close == null || !Number.isFinite(close) || close <= 0) return null;

  return value / close * 100;
}

function calculateAtr(candles: Candle[], period: number): number | null {
  if (candles.length < period + 1) return null;

  const trueRanges: number[] = [];

  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const previousClose = candles[i - 1].close;

    trueRanges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previousClose),
      Math.abs(current.low - previousClose)
    ));
  }

  const window = trueRanges.slice(-period);
  if (window.length < period) return null;

  const atr = window.reduce((sum, value) => sum + value, 0) / period;

  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

function calculateEma(values: number[], period: number): number | null {
  if (values.length < period) return null;

  let emaValue = values[0];
  const multiplier = 2 / (period + 1);

  for (let i = 1; i < values.length; i += 1) {
    emaValue = values[i] * multiplier + emaValue * (1 - multiplier);
  }

  return emaValue;
}

function calculateRv(candles: Candle[], windowMinutes: number, baselineMinutes: number): number | null {
  if (candles.length < windowMinutes + baselineMinutes) return null;

  const recent = candles.slice(-windowMinutes);
  const baseline = candles.slice(-(baselineMinutes + windowMinutes), -windowMinutes);

  const recentVolume = recent.reduce((sum, candle) => sum + candle.volume, 0);
  const baselineVolume = baseline.reduce((sum, candle) => sum + candle.volume, 0);

  return baselineVolume > 0 ? recentVolume / baselineVolume : null;
}

function calculatePosition(candles: Candle[]): number | null {
  if (candles.length === 0) return null;

  const low = Math.min(...candles.map(candle => candle.low));
  const high = Math.max(...candles.map(candle => candle.high));
  const close = candles[candles.length - 1].close;

  return high > low ? (close - low) / (high - low) : null;
}

function calculateCloseReturn(candles: Candle[], bars: number): number | null {
  if (candles.length < bars + 1) return null;

  const before = candles[candles.length - bars - 1].close;
  const now = candles[candles.length - 1].close;

  if (!Number.isFinite(before) || before <= 0 || !Number.isFinite(now)) return null;

  return (now / before - 1) * 100;
}

function calculatePrevious10Return(candles: Candle[]): number | null {
  if (candles.length < 16) return null;

  const close5 = candles[candles.length - 6].close;
  const close15 = candles[candles.length - 16].close;

  if (!Number.isFinite(close5) || !Number.isFinite(close15) || close15 <= 0) return null;

  return (close5 / close15 - 1) * 100;
}

function resampleCandles(
  candles: Candle[],
  intervalMinutes: number
): Array<{ candle: Candle; count: number }> {
  const intervalMs = intervalMinutes * MINUTE_MS;
  const buckets = new Map<number, { candle: Candle; count: number }>();

  for (const candle of candles) {
    const bucketTime = Math.floor(candle.time / intervalMs) * intervalMs;
    const existing = buckets.get(bucketTime);

    if (!existing) {
      buckets.set(bucketTime, {
        candle: { ...candle, time: bucketTime },
        count: 1
      });

      continue;
    }

    existing.candle.high = Math.max(existing.candle.high, candle.high);
    existing.candle.low = Math.min(existing.candle.low, candle.low);
    existing.candle.close = candle.close;
    existing.candle.volume += candle.volume;
    existing.count += 1;
  }

  return [...buckets.values()].sort((a, b) => a.candle.time - b.candle.time);
}

function buildHtf(
  candles: Candle[],
  intervalMinutes: number,
  emaPeriod: number,
  slopeBars: number
): HtfRegime {
  const htf = resampleCandles(candles, intervalMinutes)
    .filter(item => item.count === intervalMinutes)
    .map(item => item.candle);

  if (htf.length < emaPeriod + slopeBars) return { slope: null, ema: null };

  const closes = htf.map(candle => candle.close);
  const emaValue = calculateEma(closes, emaPeriod);

  if (emaValue == null) return { slope: null, ema: null };

  const previousCloses = closes.slice(0, closes.length - slopeBars);
  const previousEma = calculateEma(previousCloses, emaPeriod);

  if (previousEma == null) return { slope: null, ema: null };

  return { slope: emaValue - previousEma, ema: emaValue };
}

function calculateRegimeFeatures(
  candles: Candle[],
  atrPeriod: number,
  emaPeriod: number,
  slopeBars: number,
  rvWindow: number,
  rvBaseline: number
): RegimeFeatures {
  const close = candles.length ? candles[candles.length - 1].close : null;
  const atr = calculateAtr(candles, atrPeriod);
  const atrPct = percentOfClose(atr, close);

  const htf1h = buildHtf(candles, 60, emaPeriod, slopeBars);
  const htf30m = buildHtf(candles, 30, emaPeriod, slopeBars);

  return {
    close,
    atr,
    atrPct,
    rv: calculateRv(candles, rvWindow, rvBaseline),
    direction1h: getDirection(percentOfClose(htf1h.slope, close)),
    direction30m: getDirection(percentOfClose(htf30m.slope, close)),
    slope1hPct: percentOfClose(htf1h.slope, close),
    slope30mPct: percentOfClose(htf30m.slope, close),
    ema1h: htf1h.ema,
    ema30m: htf30m.ema
  };
}

export function computeTradeState(candles: Candle[], entryTime: number): TradeState | null {
  const entryMinute = Math.floor(entryTime / MINUTE_MS) * MINUTE_MS;
  const closedCandles = candles.filter(candle => candle.time + MINUTE_MS <= entryTime);

  const window = closedCandles.slice(-MAX_WINDOW_MINUTES).sort((a, b) => a.time - b.time);

  if (window.length < MAX_WINDOW_MINUTES) return null;

  const expectedLastOpen = entryMinute - MINUTE_MS;

  if (window[window.length - 1].time !== expectedLastOpen) return null;

  for (let i = 1; i < window.length; i += 1) {
    if (window[i].time - window[i - 1].time !== MINUTE_MS) return null;
  }

  const down = calculateRegimeFeatures(window, 14, EMA_PERIOD_DOWN, SLOPE_BARS_DOWN, 10, 120);
  const upShort = calculateRegimeFeatures(
    window,
    ATR_PERIOD_UP_SHORT,
    EMA_PERIOD_UP_SHORT,
    SLOPE_BARS_UP_SHORT,
    RV_WINDOW_UP_SHORT,
    RV_BASELINE_UP_SHORT
  );

  const upLong = calculateRegimeFeatures(
    window,
    ATR_PERIOD_UP_LONG,
    EMA_PERIOD_UP_LONG,
    SLOPE_BARS_UP_LONG,
    5,
    30
  );

  const upWindow = window;
  const position60 = calculatePosition(upWindow.slice(-POSITION_WINDOW_UP_SHORT));

  const priceVsEma30mUpShortAtr =
    upShort.ema30m != null && upShort.atr != null && upShort.atr > 0 && upShort.close != null
      ? (upShort.close - upShort.ema30m) / upShort.atr
      : null;

  const closeAboveEma30mUpLong =
    upLong.close != null && upLong.ema30m != null && upLong.close > upLong.ema30m;

  const upLongRegime =
    upLong.slope1hPct != null &&
    upLong.slope30mPct != null &&
    upLong.slope1hPct > 0 &&
    upLong.slope30mPct > 0 &&
    closeAboveEma30mUpLong &&
    upLong.atrPct != null &&
    upLong.atrPct >= ATR_MIN_UP_LONG &&
    upLong.atrPct <= ATR_MAX_UP_LONG;

  return {
    down,
    upShort,
    upLong,
    ret5Pct: calculateCloseReturn(upWindow, 5),
    ret15Pct: calculateCloseReturn(upWindow, 15),
    previous10Pct: calculatePrevious10Return(upWindow),
    position60,
    priceVsEma30mUpShortAtr,
    closeAboveEma30mUpLong,
    upLongRegime,
    windowStart: window[0].time,
    windowEnd: window[window.length - 1].time,
    windowCandles: window.length
  };
}

function isUpShortAltConfirmationPassed(state: TradeState): boolean {
  const strongSlope =
    state.upShort.slope30mPct != null &&
    state.upShort.slope30mPct >= UP_SHORT_CONFIRM_SLOPE_BOUNDARY;

  const closeBelowEma =
    state.upShort.close != null &&
    state.upShort.ema30m != null &&
    state.upShort.close < state.upShort.ema30m;

  const returnsNegative =
    state.ret5Pct != null &&
    state.ret15Pct != null &&
    state.ret5Pct < 0 &&
    state.ret15Pct < 0;

  return strongSlope || closeBelowEma || returnsNegative;
}

function isUpShortMiddleFallInputsAvailable(state: TradeState): boolean {
  return (
    state.previous10Pct != null &&
    Number.isFinite(state.previous10Pct) &&
    state.ret5Pct != null &&
    Number.isFinite(state.ret5Pct) &&
    state.position60 != null &&
    Number.isFinite(state.position60) &&
    state.position60 >= 0 &&
    state.position60 <= 1
  );
}

function isUpShortMiddleFallBan(state: TradeState): boolean {
  const continuedFall =
    state.previous10Pct != null &&
    state.ret5Pct != null &&
    state.previous10Pct < 0 &&
    state.ret5Pct < 0;

  const middlePosition =
    state.position60 != null &&
    state.position60 >= POSITION_MIDDLE_MIN_UP_SHORT &&
    state.position60 < POSITION_MIDDLE_MAX_UP_SHORT;

  return continuedFall && middlePosition;
}

function resolveStrategyGroup(
  side: 'long' | 'short',
  state: TradeState
): { group: StrategyGroup; reason: string | null } {
  if (
    side === 'long' &&
    state.down.direction1h === 'down' &&
    state.down.direction30m === 'down'
  ) {
    return { group: 'down_long', reason: null };
  }

  if (
    side === 'short' &&
    state.down.direction1h === 'down' &&
    state.down.direction30m === 'down'
  ) {
    if (!ENABLE_DOWN_SHORT) {
      return { group: 'none', reason: 'DOWN_SHORT disabled by entry-quality filters' };
    }

    return { group: 'down_short', reason: null };
  }

  if (side === 'short' && ENABLE_UP_SHORT) {
    const basePassed =
      state.upShort.direction1h === 'up' &&
      state.upShort.direction30m === 'up' &&
      state.upShort.atrPct != null &&
      state.upShort.atrPct <= ATR_MAX_UP_SHORT &&
      state.upShort.slope30mPct != null &&
      state.upShort.slope30mPct < MAX_EMA_SLOPE_PCT_30M_UP_SHORT &&
      state.upShort.rv != null &&
      (state.upShort.rv < RV_AVOID_MIN_UP_SHORT || state.upShort.rv > RV_AVOID_MAX_UP_SHORT);

    if (!basePassed) {
      return { group: 'none', reason: 'UP_SHORT base conditions not met' };
    }

    if (ENABLE_UP_SHORT_CONDITIONAL_BAN) {
      const conditionalBan =
        state.upShort.atrPct != null &&
        state.upShort.slope1hPct != null &&
        state.upShort.atrPct >= ATR_BAN_MIN_UP_SHORT &&
        state.upShort.atrPct < ATR_BAN_MAX_UP_SHORT &&
        state.upShort.slope1hPct >= SLOPE_1H_BAN_MIN_UP_SHORT;

      if (conditionalBan) {
        return { group: 'none', reason: 'UP_SHORT existing_atr_1h_ban' };
      }
    }

    if (!isUpShortAltConfirmationPassed(state)) {
      const inputsMissing =
        state.upShort.close == null ||
        state.upShort.ema30m == null ||
        state.ret5Pct == null ||
        state.ret15Pct == null;

      return {
        group: 'none',
        reason: inputsMissing ? 'UP_SHORT alt_confirmation_missing' : 'UP_SHORT alt_confirmation_failed'
      };
    }

    if (!isUpShortMiddleFallInputsAvailable(state)) {
      return { group: 'none', reason: 'UP_SHORT middle_fall_inputs_missing' };
    }

    if (isUpShortMiddleFallBan(state)) {
      return { group: 'none', reason: 'UP_SHORT middle_fall' };
    }

    return { group: 'up_short', reason: null };
  }

  if (side === 'long' && ENABLE_UP_LONG && state.upLongRegime) {
    return { group: 'up_long', reason: null };
  }

  return { group: 'none', reason: 'No script strategy group allowed this side' };
}

function getPreviousSameSidePnL(
  history: TradeHistoryEntry[],
  side: 'long' | 'short',
  entryTime: number
): number | null {
  const sameSide = history
    .filter(trade => trade.side === side && trade.openedAt < entryTime)
    .sort((a, b) => a.openedAt - b.openedAt);

  return sameSide.length ? sameSide[sameSide.length - 1].netPnL : null;
}

function getUpLongStreak(
  history: TradeHistoryEntry[],
  entryTime: number
): { length: number; type: 'WIN' | 'LOSS' | 'ZERO' | 'NO_STREAK' } {
  const longs = history
    .filter(trade => trade.side === 'long' && trade.openedAt < entryTime)
    .sort((a, b) => a.openedAt - b.openedAt);

  if (longs.length === 0) return { length: 0, type: 'NO_STREAK' };

  let streak = 0;
  let streakType: 'WIN' | 'LOSS' | 'ZERO' | 'NO_STREAK' = 'NO_STREAK';

  for (let back = 1; back <= 5; back += 1) {
    const index = longs.length - back;
    if (index < 0) break;

    const pnl = longs[index].netPnL;
    const result = pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'ZERO';

    if (back === 1) {
      streakType = result;
      streak = 1;
      continue;
    }

    if (result === streakType) streak += 1;
    else break;
  }

  return { length: streak, type: streakType };
}

function isS2Allowed(
  group: StrategyGroup,
  history: TradeHistoryEntry[],
  entryTime: number
): boolean {
  const side = group === 'down_short' ? 'short' : 'long';

  const previousPnL = getPreviousSameSidePnL(history, side, entryTime);

  // Cold start отключён.
  // Нет закрытой виртуальной сделки в этом направлении — реальный вход запрещён.
  if (previousPnL == null) {
    return false;
  }

  const s2Allowed = previousPnL > 0;

  if (group === 'down_long') {
    return ENABLE_DOWN_LONG_S2 ? s2Allowed : true;
  }

  if (group === 'down_short') {
    return ENABLE_DOWN_SHORT_S2 ? s2Allowed : true;
  }

  if (group === 'up_long') {
    if (!ENABLE_UP_LONG_S2) return true;

    const streak = getUpLongStreak(history, entryTime);

    return s2Allowed && streak.type === 'WIN' && streak.length >= UP_LONG_STREAK_MIN;
  }

  return true;
}

/**
 * Entry-quality filters, calibrated on closed-trade backtest.
 *
 * Important:
 * - stopPct and execution latency are known before entry;
 * - notionalPct requires balanceBefore;
 * - if balanceBefore is not provided, notional filters fail open.
 */
function passesEntryQualityFilters(
  group: StrategyGroup,
  symbol: string,
  side: 'long' | 'short',
  entryPrice: number,
  stopLossPrice: number,
  signalTime: number,
  executionTime: number,
  balanceBefore: number | null
): { allowed: boolean; reason: string | null } {
  if (group === 'down_short') {
    return { allowed: false, reason: 'DOWN_SHORT disabled by entry-quality filters' };
  }

  const stopDistance = Math.abs(entryPrice - stopLossPrice);

  if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
    return { allowed: false, reason: 'ENTRY_QUALITY invalid_stop_distance' };
  }

  const stopPct = stopDistance / entryPrice;
  const executionLatencyMs = executionTime - signalTime;

  if (group === 'down_long') {
    if (stopPct < DOWN_LONG_MIN_STOP_PCT) {
      return {
        allowed: false,
        reason: `DOWN_LONG stop too narrow: ${(stopPct * 100).toFixed(3)}%`
      };
    }

    if (stopPct > DOWN_LONG_MAX_STOP_PCT) {
      return {
        allowed: false,
        reason: `DOWN_LONG stop too wide: ${(stopPct * 100).toFixed(3)}%`
      };
    }

    if (executionLatencyMs > DOWN_LONG_MAX_EXECUTION_LATENCY_MS) {
      return {
        allowed: false,
        reason: `DOWN_LONG execution latency too high: ${Math.round(executionLatencyMs / 1000)}s`
      };
    }

    if (balanceBefore != null && balanceBefore > 0) {
      const notionalPct = (entryPrice * 1) / balanceBefore;

      // Actual position notional is supplied by the execution layer;
      // here we validate the pre-trade risk-based maximum.
      if (notionalPct > DOWN_LONG_MAX_NOTIONAL_PCT) {
        return {
          allowed: false,
          reason: `DOWN_LONG notional exposure too high: ${(notionalPct * 100).toFixed(2)}%`
        };
      }
    }

    return { allowed: true, reason: null };
  }

  if (group === 'up_long') {
    if (balanceBefore != null && balanceBefore > 0) {
      const notionalPct = (entryPrice * 1) / balanceBefore;

      // Actual position notional is supplied by the execution layer;
      // here we validate the pre-trade risk-based maximum.
      if (notionalPct > UP_LONG_MAX_NOTIONAL_PCT) {
        return {
          allowed: false,
          reason: `UP_LONG notional exposure too high: ${(notionalPct * 100).toFixed(2)}%`
        };
      }
    }

    return { allowed: true, reason: null };
  }

  if (group === 'up_short') {
    if (UP_SHORT_BLOCKED_SYMBOLS.has(symbol)) {
      return { allowed: false, reason: `UP_SHORT blocked symbol: ${symbol}` };
    }

    if (stopPct < UP_SHORT_MIN_STOP_PCT) {
      return {
        allowed: false,
        reason: `UP_SHORT stop too narrow: ${(stopPct * 100).toFixed(3)}%`
      };
    }

    return { allowed: true, reason: null };
  }

  return { allowed: true, reason: null };
}

function emptyResult(
  symbol: string,
  price: number,
  now: number,
  reason: string,
  indicators: TradeFlowIndicators,
  tradeState: TradeState | null,
  rawSignalData: RawTradeFlowSignal | null = null
): TradeFlowResult {
  return {
    symbol,
    ready: false,
    buy: false,
    sell: false,
    side: 'none',
    price,
    takeProfitPrice: null,
    stopLossPrice: null,
    positionSize: null,
    regime: 'trade_flow',
    group: 'none',
    skipReason: reason,
    signalTime: now,
    signalTimeIso: new Date(now).toISOString(),
    indicators,
    tradeState,
    rawSignal: rawSignalData != null,
    rawSignalData
  };
}

export function analyzeTradeFlow(
  symbol: string,
  trades: LighterTrade[],
  options?: {
    now?: number;
    atr?: number | null;
    slTpAtr?: number | null;
    config?: Partial<TradeFlowConfig>;
    baselineTracker?: TradeFlowBaselineTracker;
    candles?: Candle[];
    tradeHistory?: TradeHistoryEntry[];
    balanceBefore?: number | null;
    plannedNotional?: number | null;
  }
): TradeFlowResult {
  const config: TradeFlowConfig = { ...DEFAULT_TRADE_FLOW_CONFIG, ...options?.config };
  const now = options?.now ?? Date.now();

  const valid = trades
    .filter(isValidTrade)
    .filter(trade => trade.receivedAt <= now)
    .filter(trade => now - trade.receivedAt <= config.baselineMs + config.windowMs)
    .sort((a, b) => a.receivedAt - b.receivedAt);

  const current = aggregate(valid, now - config.windowMs, now + 1, config.excludeLiquidations);
  const trackerBaseline = options?.baselineTracker?.getBaseline(now);

  let baselineVolumePerWindow = trackerBaseline?.volumePerWindow ?? null;
  let nonEmptyBaselineBuckets = trackerBaseline?.nonEmptyBuckets ?? 0;
  let excludedLiquidationCount = current.excludedLiquidationCount;

  if (!options?.baselineTracker) {
    const baselineStart = now - config.windowMs - config.baselineMs;
    const baselineEnd = now - config.windowMs;
    const bucketDuration = config.baselineMs / config.baselineBuckets;
    const bucketVolumes = Array<number>(config.baselineBuckets).fill(0);

    for (let i = 0; i < config.baselineBuckets; i += 1) {
      const bucketStart = baselineStart + i * bucketDuration;
      const bucketEnd = i === config.baselineBuckets - 1 ? baselineEnd : bucketStart + bucketDuration;

      const bucket = aggregate(valid, bucketStart, bucketEnd, config.excludeLiquidations);

      bucketVolumes[i] = bucket.buyVolume + bucket.sellVolume;
      excludedLiquidationCount += bucket.excludedLiquidationCount;
    }

    nonEmptyBaselineBuckets = bucketVolumes.filter(volume => volume > 0).length;

    if (nonEmptyBaselineBuckets >= config.minBaselineBuckets) {
      const value = bucketVolumes.reduce((sum, volume) => sum + volume, 0) / config.baselineBuckets;
      baselineVolumePerWindow = value > 0 ? value : null;
    }
  }

  const totalVolume = current.buyVolume + current.sellVolume;
  const imbalance = totalVolume > 0 ? (current.buyVolume - current.sellVolume) / totalVolume : 0;
  const volumeMultiple =
    baselineVolumePerWindow != null && baselineVolumePerWindow > 0
      ? totalVolume / baselineVolumePerWindow
      : null;

  const latestTrade = valid[valid.length - 1];
  const price = latestTrade?.price ?? 0;
  const atr = options?.atr != null && Number.isFinite(options.atr) && options.atr > 0 ? options.atr : null;

  const referencePrice = current.firstPrice;
  const priceMove =
    current.lastPrice != null && referencePrice != null ? current.lastPrice - referencePrice : null;
  const priceMoveAtr = priceMove != null && atr != null ? priceMove / atr : null;

  const indicators: TradeFlowIndicators = {
    windowMs: config.windowMs,
    windowTradeCount: current.count,
    buyVolume: current.buyVolume,
    sellVolume: current.sellVolume,
    totalVolume,
    baselineVolumePerWindow,
    volumeMultiple,
    imbalance,
    referencePrice,
    priceMoveAtr,
    excludedLiquidationCount,
    baselineNonEmptyBuckets: nonEmptyBaselineBuckets
  };

  const tradeState = options?.candles ? computeTradeState(options.candles, now) : null;

  if (!latestTrade || price <= 0) {
    return emptyResult(symbol, price, now, 'No valid recent trades', indicators, tradeState);
  }

  if (now - latestTrade.receivedAt > config.maxTradeAgeMs) {
    return emptyResult(symbol, price, now, 'Trade stream is stale', indicators, tradeState);
  }

  if (baselineVolumePerWindow == null) {
    return emptyResult(
      symbol,
      price,
      now,
      trackerBaseline?.reason ?? 'Insufficient trade-flow baseline',
      indicators,
      tradeState
    );
  }

  if (atr == null) {
    return emptyResult(symbol, price, now, 'ATR unavailable', indicators, tradeState);
  }

  if (current.count === 0 || totalVolume <= 0) {
    return emptyResult(symbol, price, now, 'No eligible trades in current window', indicators, tradeState);
  }

  const spikeConfirmed = volumeMultiple != null && volumeMultiple >= config.spikeMultiplier;

  if (!spikeConfirmed) {
    return emptyResult(symbol, price, now, 'Trade volume spike threshold not met', indicators, tradeState);
  }

  let side: 'long' | 'short' | 'none' = 'none';

  if (imbalance >= config.minImbalance) side = 'long';
  else if (imbalance <= -config.minImbalance) side = 'short';

  if (side === 'none') {
    return emptyResult(
      symbol,
      price,
      now,
      'Aggressor-side imbalance threshold not met',
      indicators,
      tradeState
    );
  }

  const directionalMoveAtr =
    priceMoveAtr == null ? null : side === 'long' ? priceMoveAtr : -priceMoveAtr;

  if (directionalMoveAtr == null || directionalMoveAtr < config.minDirectionalMoveAtr) {
    return emptyResult(
      symbol,
      price,
      now,
      'Price has not confirmed flow direction',
      indicators,
      tradeState
    );
  }

  if (directionalMoveAtr > config.maxChaseAtr) {
    return emptyResult(
      symbol,
      price,
      now,
      'Price already moved too far from flow trigger',
      indicators,
      tradeState
    );
  }

  // Сырой trade-flow сигнал подтверждён.
  // Он не зависит от HTF-группы и S2.
  const rawSlTpAtr =
    options?.slTpAtr != null &&
    Number.isFinite(options.slTpAtr) &&
    options.slTpAtr > 0
      ? options.slTpAtr
      : atr;

  const rawStopDistance = rawSlTpAtr * config.stopAtrMultiplier;
  const rawTargetDistance = rawSlTpAtr * config.takeProfitAtrMultiplier;

  const rawStopLossPrice =
    side === 'long'
      ? price - rawStopDistance
      : price + rawStopDistance;

  const rawTakeProfitPrice =
    side === 'long'
      ? price + rawTargetDistance
      : price - rawTargetDistance;

  const rawSignalTime = latestTrade.time;

  const rawSignalData: RawTradeFlowSignal = {
    side,
    entryPrice: price,
    stopLossPrice: rawStopLossPrice,
    takeProfitPrice: rawTakeProfitPrice,
    slTpAtr: rawSlTpAtr,
    signalTime: rawSignalTime
  };

  if (!tradeState) {
    return emptyResult(
      symbol,
      price,
      now,
      'Candle history is insufficient for v6.41 regime',
      indicators,
      tradeState,
      rawSignalData
    );
  }

  const { group, reason } = resolveStrategyGroup(side, tradeState);

  if (group === 'none') {
    return emptyResult(
      symbol,
      price,
      now,
      reason ?? 'Script strategy group not allowed',
      indicators,
      tradeState,
      rawSignalData
    );
  }

  const entryQuality = passesEntryQualityFilters(
    group,
    symbol,
    side,
    price,
    rawStopLossPrice,
    rawSignalTime,
    now,
    options?.balanceBefore ?? null
  );

  if (!entryQuality.allowed) {
    return emptyResult(
      symbol,
      price,
      now,
      entryQuality.reason ?? 'Entry-quality filter blocked entry',
      indicators,
      tradeState,
      rawSignalData
    );
  }

  const s2Allowed = isS2Allowed(group, options?.tradeHistory ?? [], now);

  if (!s2Allowed) {
    return emptyResult(
      symbol,
      price,
      now,
      'S2 previous same-side trade filter blocked entry',
      indicators,
      tradeState,
      rawSignalData
    );
  }

  return {
    symbol,
    ready: true,
    buy: side === 'long',
    sell: side === 'short',
    side,
    price,
    takeProfitPrice: rawTakeProfitPrice,
    stopLossPrice: rawStopLossPrice,
    positionSize: null,
    regime: group,
    group,
    skipReason: null,
    signalTime: rawSignalTime,
    signalTimeIso: new Date(rawSignalTime).toISOString(),
    indicators,
    tradeState,
    rawSignal: true,
    rawSignalData
  };
}

export function detectMarketRegime(_candles: unknown[]): {
  regime: 'unknown';
  ready: false;
  indicators: null;
} {
  return { regime: 'unknown', ready: false, indicators: null };
}
