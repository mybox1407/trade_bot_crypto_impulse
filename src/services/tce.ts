// src/services/tce.ts

export const TCE_STRONG_MIN = 75;
export const TCE_STRONG_MAX = 85;
export const TCE_MEDIUM_SCORE = 55;

export const MIN_ENTRY_EXTENSION_ATR = 0.90;
export const MAX_ENTRY_EXTENSION_ATR = 1.30;
export const MIN_ROOM_ATR = 1.50;
export const MIN_ER_FAST = 0.20;
export const MIN_ER_SLOW = 0.10;
export const MIN_BODY_RATIO = 0.35;
export const MAX_BODY_RATIO = 0.80;
export const MIN_CANDLE_RANGE_ATR = 0.50;
export const MAX_CANDLE_RANGE_ATR = 1.60;

export const ATR_PERIOD = 14;
export const EMA_FAST_PERIOD = 20;
export const EMA_MIDDLE_PERIOD = 50;
export const EMA_SLOW_PERIOD = 200;
export const ER_FAST_PERIOD = 5;
export const ER_SLOW_PERIOD = 20;
export const ROOM_LOOKBACK = 30;

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type TceMetrics = {
  tceScore: number;
  tceRegime: 'strong' | 'medium' | 'weak' | 'unknown';
  tceReason: string;
  tceTrendAligned: boolean;
  tceErFast: number;
  tceErSlow: number;
  tceRoomAtr: number;
  tceEntryExtensionAtr: number;
  tceCandleRangeAtr: number;
  tceBodyRatio: number;
  tceTrendComponent: number;
  tcePersistenceComponent: number;
  tceRoomComponent: number;
  tceVolatilityComponent: number;
  tceExtensionComponent: number;
};

function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}

function calculateTrueRange(candles: Candle[]): number[] {
  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = i > 0 ? candles[i - 1].close : c.close;
    const hl = c.high - c.low;
    const hc = Math.abs(c.high - prevClose);
    const lc = Math.abs(c.low - prevClose);
    tr.push(Math.max(hl, hc, lc));
  }
  return tr;
}

function calculateWilderAtr(candles: Candle[], period: number = ATR_PERIOD): number[] {
  const tr = calculateTrueRange(candles);
  const atr: number[] = [];
  let sum = 0;

  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) {
      sum += tr[i];
      atr.push(NaN);
      continue;
    }

    if (i === period - 1) {
      sum += tr[i];
      atr.push(sum / period);
      continue;
    }

    const prevAtr = atr[i - 1];
    const curAtr = (prevAtr * (period - 1) + tr[i]) / period;
    atr.push(curAtr);
  }

  return atr;
}

function calculateEfficiencyRatio(closes: number[], period: number): number[] {
  const er: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period) {
      er.push(NaN);
      continue;
    }

    const netChange = closes[i] - closes[i - period];
    let path = 0;
    for (let j = i - period + 1; j <= i; j++) {
      path += Math.abs(closes[j] - closes[j - 1]);
    }

    if (path === 0) {
      er.push(NaN);
      continue;
    }

    er.push(netChange / path);
  }
  return er;
}

function calculateEma(values: number[], period: number): number[] {
  const ema: number[] = [];
  const k = 2 / (period + 1);
  let sum = 0;

  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      sum += values[i];
      ema.push(NaN);
      continue;
    }

    if (i === period - 1) {
      sum += values[i];
      ema.push(sum / period);
      continue;
    }

    const prevEma = ema[i - 1];
    const curEma = values[i] * k + prevEma * (1 - k);
    ema.push(curEma);
  }

  return ema;
}

function invalidMetrics(reason: string): TceMetrics {
  return {
    tceScore: NaN,
    tceRegime: 'unknown',
    tceReason: reason,
    tceTrendAligned: false,
    tceErFast: NaN,
    tceErSlow: NaN,
    tceRoomAtr: NaN,
    tceEntryExtensionAtr: NaN,
    tceCandleRangeAtr: NaN,
    tceBodyRatio: NaN,
    tceTrendComponent: NaN,
    tcePersistenceComponent: NaN,
    tceRoomComponent: NaN,
    tceVolatilityComponent: NaN,
    tceExtensionComponent: NaN
  };
}

export function calculateTce(
  candles: Candle[],
  side: 'long' | 'short',
  entryPrice: number,
  tradeEma20?: number | null,
  tradeEma50?: number | null,
  tradeEma200?: number | null
): TceMetrics {
  const minimumCandles = Math.max(
    ER_SLOW_PERIOD + 1,
    ROOM_LOOKBACK + 1,
    EMA_FAST_PERIOD + 2
  );

  if (side !== 'long' && side !== 'short') {
    return invalidMetrics(`invalid_side=${side}`);
  }

  if (candles.length < minimumCandles) {
    return invalidMetrics('insufficient_history');
  }

  const closes = candles.map(c => c.close);
  const atr = calculateWilderAtr(candles, ATR_PERIOD);
  const ema20 = calculateEma(closes, EMA_FAST_PERIOD);
  const ema50 = calculateEma(closes, EMA_MIDDLE_PERIOD);
  const ema200 = calculateEma(closes, EMA_SLOW_PERIOD);
  const erFast = calculateEfficiencyRatio(closes, ER_FAST_PERIOD);
  const erSlow = calculateEfficiencyRatio(closes, ER_SLOW_PERIOD);

  const current = last(candles);
  const currentAtr = last(atr);
  const currentEma20 = tradeEma20 != null && Number.isFinite(tradeEma20)
    ? tradeEma20
    : last(ema20);
  const currentEma50 = tradeEma50 != null && Number.isFinite(tradeEma50)
    ? tradeEma50
    : last(ema50);
  const currentEma200 = tradeEma200 != null && Number.isFinite(tradeEma200)
    ? tradeEma200
    : last(ema200);

  const currentErFast = last(erFast);
  const currentErSlow = last(erSlow);

  if (
    !Number.isFinite(currentAtr) ||
    !Number.isFinite(currentEma20) ||
    !Number.isFinite(currentEma50) ||
    !Number.isFinite(currentEma200) ||
    !Number.isFinite(currentErFast) ||
    !Number.isFinite(currentErSlow) ||
    !Number.isFinite(entryPrice) ||
    currentAtr <= 0
  ) {
    return invalidMetrics('invalid_indicator_values');
  }

  const candleRangeAtr = (current.high - current.low) / currentAtr;
  const bodyRange = Math.abs(current.close - current.open);
  const fullRange = current.high - current.low;
  const bodyRatio = fullRange > 0 ? bodyRange / fullRange : 0;

  const currentClose = current.close;

  let trendAligned: boolean;
  let signedErFast: number;
  let signedErSlow: number;
  let recentExtreme: number;
  let roomPrice: number;

  if (side === 'long') {
    trendAligned =
      currentClose > currentEma200 &&
      currentEma20 > currentEma50 &&
      currentEma50 > currentEma200 &&
      currentClose > currentEma20;

    signedErFast = currentErFast;
    signedErSlow = currentErSlow;

    const slice = candles.slice(-ROOM_LOOKBACK - 1, -1);
    recentExtreme = slice.length > 0
      ? Math.max(...slice.map(c => c.high))
      : current.high;

    roomPrice = recentExtreme - entryPrice;
  } else {
    trendAligned =
      currentClose < currentEma200 &&
      currentEma20 < currentEma50 &&
      currentEma50 < currentEma200 &&
      currentClose < currentEma20;

    signedErFast = -currentErFast;
    signedErSlow = -currentErSlow;

    const slice = candles.slice(-ROOM_LOOKBACK - 1, -1);
    recentExtreme = slice.length > 0
      ? Math.min(...slice.map(c => c.low))
      : current.low;

    roomPrice = entryPrice - recentExtreme;
  }

  const roomAtr = roomPrice / currentAtr;

  const entryExtensionAtr =
    side === 'long'
      ? (entryPrice - currentEma20) / currentAtr
      : (currentEma20 - entryPrice) / currentAtr;

  const trendComponent = trendAligned ? 1 : 0;

  const persistenceComponent = Math.max(
    0,
    Math.min(
      1,
      0.5 *
        Math.max(
          0,
          Math.min(1, signedErFast / 0.5)
        ) +
        0.5 *
        Math.max(
          0,
          Math.min(1, signedErSlow / 0.35)
        )
    )
  );

  const roomComponent = Math.max(0, Math.min(1, roomAtr / 3.0));

  const rangeOk =
    candleRangeAtr >= MIN_CANDLE_RANGE_ATR &&
    candleRangeAtr <= MAX_CANDLE_RANGE_ATR;

  const bodyOk =
    bodyRatio >= MIN_BODY_RATIO &&
    bodyRatio <= MAX_BODY_RATIO;

  const volatilityComponent =
    0.5 * (rangeOk ? 1 : 0) +
    0.5 * (bodyOk ? 1 : 0);

  const extensionOk =
    entryExtensionAtr >= MIN_ENTRY_EXTENSION_ATR &&
    entryExtensionAtr <= MAX_ENTRY_EXTENSION_ATR;

  const extensionComponent = extensionOk ? 1 : 0;

  const score = Math.round(
    100 *
      (0.30 * trendComponent +
        0.25 * persistenceComponent +
        0.14 * roomComponent +
        0.26 * volatilityComponent +
        0.05 * extensionComponent)
  );

  let regime: 'strong' | 'medium' | 'weak';
  if (score >= TCE_STRONG_MIN) {
    regime = 'strong';
  } else if (score >= TCE_MEDIUM_SCORE) {
    regime = 'medium';
  } else {
    regime = 'weak';
  }

  return {
    tceScore: score,
    tceRegime: regime,
    tceReason: `TCE ${regime}`,
    tceTrendAligned: trendAligned,
    tceErFast: signedErFast,
    tceErSlow: signedErSlow,
    tceRoomAtr: roomAtr,
    tceEntryExtensionAtr: entryExtensionAtr,
    tceCandleRangeAtr: candleRangeAtr,
    tceBodyRatio: bodyRatio,
    tceTrendComponent: trendComponent,
    tcePersistenceComponent: persistenceComponent,
    tceRoomComponent: roomComponent,
    tceVolatilityComponent: volatilityComponent,
    tceExtensionComponent: extensionComponent
  };
}
