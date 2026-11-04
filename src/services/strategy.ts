import type { LighterTrade } from './lighterWs';

// Сохранены для совместимости с positionState.ts.
export const STARTING_BALANCE = 150;
export const MAX_RISK_PER_TRADE = 0.01;
export const TRADE_FEE_RATE = 0.0;

// Основное окно импульса — 1 секунда.
export const FLOW_WINDOW_MS = 1_000;

// Baseline — 60 секунд, посекундно.
export const FLOW_BASELINE_MS = 60_000;
export const FLOW_BASELINE_BUCKETS = 60;

// Порог всплеска по полному 1-секундному окну.
export const FLOW_SPIKE_MULTIPLIER = 8.0;

// Сильное преобладание агрессивных покупок или продаж.
export const FLOW_MIN_IMBALANCE = 0.85;

// Ранний вход: минимальное подтверждение движения.
export const FLOW_MIN_DIRECTIONAL_MOVE_ATR = 0.03;

// Старый chase-фильтр в ATR(15m) оставляем как страховку.
export const FLOW_MAX_CHASE_ATR = 0.60;

// Новый анти-пик фильтр: если за окно цена уже ушла больше 0.15%,
// импульс считается отработанным — не входим.
export const FLOW_MAX_CHASE_PCT = 0.0015;

// Короткие SL/TP относительно 15m ATR.
export const FLOW_STOP_ATR_MULTIPLIER = 0.5;
export const FLOW_TAKE_PROFIT_ATR_MULTIPLIER = 0.8;

// Для baseline из 60 секундных корзин.
export const FLOW_MIN_BASELINE_BUCKETS = 30;

// Не используем устаревший поток сделок.
export const FLOW_MAX_TRADE_AGE_MS = 1_500;

export const FLOW_EXCLUDE_LIQUIDATIONS = true;

export const FLOW_MIN_TRADES_IN_WINDOW = 4;

export const FLOW_MIN_LARGE_TRADE_SHARE = 0.40;
export const FLOW_LARGE_TRADE_NOTIONAL = 2_000;

// === РАННИЙ ТРИГГЕР ===
// Если за последние 300 мс было >= 2 крупных сделки
// в одну сторону и их суммарный объём >= 3x среднего
// секундного объёма — входим сразу, не ждём полной секунды.
export const FLOW_EARLY_WINDOW_MS = 300;
export const FLOW_EARLY_MIN_LARGE_TRADES = 2;
export const FLOW_EARLY_VOLUME_MULTIPLIER = 3.0;
export const FLOW_EARLY_MIN_IMBALANCE = 0.90;

// Принудительный выход, если TP не достигнут за 2 минуты.
export const MAX_POSITION_AGE_MS = 120_000;

export type TradeFlowSide = 'long' | 'short' | 'none';

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
  largeTradeNotional: number;
  largeTradeShare: number;
  earlyTriggered: boolean;
  earlyWindowTradeCount: number;
  earlyLargeTradeCount: number;
  earlyImbalance: number;
  chasePct: number;
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
  skipReason: string | null;
  signalTime: number;
  signalTimeIso: string;
  indicators: TradeFlowIndicators;
}

export interface TradeFlowConfig {
  windowMs: number;
  baselineMs: number;
  baselineBuckets: number;
  spikeMultiplier: number;
  minImbalance: number;
  minDirectionalMoveAtr: number;
  maxChaseAtr: number;
  maxChasePct: number;
  stopAtrMultiplier: number;
  takeProfitAtrMultiplier: number;
  minBaselineBuckets: number;
  maxTradeAgeMs: number;
  excludeLiquidations: boolean;
  minTradesInWindow: number;
  minLargeTradeShare: number;
  largeTradeNotional: number;
  earlyWindowMs: number;
  earlyMinLargeTrades: number;
  earlyVolumeMultiplier: number;
  earlyMinImbalance: number;
}

export const DEFAULT_TRADE_FLOW_CONFIG: TradeFlowConfig = {
  windowMs: FLOW_WINDOW_MS,
  baselineMs: FLOW_BASELINE_MS,
  baselineBuckets: FLOW_BASELINE_BUCKETS,
  spikeMultiplier: FLOW_SPIKE_MULTIPLIER,
  minImbalance: FLOW_MIN_IMBALANCE,
  minDirectionalMoveAtr: FLOW_MIN_DIRECTIONAL_MOVE_ATR,
  maxChaseAtr: FLOW_MAX_CHASE_ATR,
  maxChasePct: FLOW_MAX_CHASE_PCT,
  stopAtrMultiplier: FLOW_STOP_ATR_MULTIPLIER,
  takeProfitAtrMultiplier: FLOW_TAKE_PROFIT_ATR_MULTIPLIER,
  minBaselineBuckets: FLOW_MIN_BASELINE_BUCKETS,
  maxTradeAgeMs: FLOW_MAX_TRADE_AGE_MS,
  excludeLiquidations: FLOW_EXCLUDE_LIQUIDATIONS,
  minTradesInWindow: FLOW_MIN_TRADES_IN_WINDOW,
  minLargeTradeShare: FLOW_MIN_LARGE_TRADE_SHARE,
  largeTradeNotional: FLOW_LARGE_TRADE_NOTIONAL,
  earlyWindowMs: FLOW_EARLY_WINDOW_MS,
  earlyMinLargeTrades: FLOW_EARLY_MIN_LARGE_TRADES,
  earlyVolumeMultiplier: FLOW_EARLY_VOLUME_MULTIPLIER,
  earlyMinImbalance: FLOW_EARLY_MIN_IMBALANCE
};

export interface TradeFlowBaseline {
  ready: boolean;
  nonEmptyBuckets: number;
  volumePerWindow: number | null;
  reason: string | null;
}

export class TradeFlowBaselineTracker {
  private readonly secondBuckets = new Map<number, number>();

  constructor(
    private readonly config: TradeFlowConfig =
      DEFAULT_TRADE_FLOW_CONFIG
  ) {}

  addTrade(trade: LighterTrade): void {
    if (
      !isValidTrade(trade) ||
      (
        this.config.excludeLiquidations &&
        trade.isLiquidation
      )
    ) {
      return;
    }

    const notional = getNotional(trade);

    if (!Number.isFinite(notional) || notional <= 0) {
      return;
    }

    const bucketTimestamp =
      Math.floor(trade.receivedAt / 1_000) * 1_000;

    this.secondBuckets.set(
      bucketTimestamp,
      (this.secondBuckets.get(bucketTimestamp) ?? 0) + notional
    );

    this.prune(trade.receivedAt);
  }

  getBaseline(now = Date.now()): TradeFlowBaseline {
    this.prune(now);

    const baselineStart =
      now - this.config.windowMs - this.config.baselineMs;

    const baselineEnd =
      now - this.config.windowMs;

    const bucketDuration =
      this.config.baselineMs / this.config.baselineBuckets;

    const bucketVolumes =
      Array<number>(this.config.baselineBuckets).fill(0);

    for (const [timestamp, volume] of this.secondBuckets) {
      if (
        timestamp < baselineStart ||
        timestamp >= baselineEnd
      ) {
        continue;
      }

      const bucketIndex = Math.min(
        this.config.baselineBuckets - 1,
        Math.floor(
          (timestamp - baselineStart) / bucketDuration
        )
      );

      if (bucketIndex >= 0) {
        bucketVolumes[bucketIndex] += volume;
      }
    }

    const nonEmptyBuckets =
      bucketVolumes.filter(volume => volume > 0).length;

    if (nonEmptyBuckets < this.config.minBaselineBuckets) {
      return {
        ready: false,
        nonEmptyBuckets,
        volumePerWindow: null,
        reason:
          `Warming trade-flow baseline: ` +
          `${nonEmptyBuckets}/${this.config.minBaselineBuckets} ` +
          `active buckets`
      };
    }

    const volumePerWindow =
      bucketVolumes.reduce((sum, volume) => sum + volume, 0) /
      this.config.baselineBuckets;

    if (!Number.isFinite(volumePerWindow) || volumePerWindow <= 0) {
      return {
        ready: false,
        nonEmptyBuckets,
        volumePerWindow: null,
        reason: 'Baseline volume is zero'
      };
    }

    return {
      ready: true,
      nonEmptyBuckets,
      volumePerWindow,
      reason: null
    };
  }

  reset(): void {
    this.secondBuckets.clear();
  }

  private prune(now: number): void {
    const oldestKeptTimestamp =
      now -
      this.config.windowMs -
      this.config.baselineMs -
      2_000;

    for (const timestamp of this.secondBuckets.keys()) {
      if (timestamp < oldestKeptTimestamp) {
        this.secondBuckets.delete(timestamp);
      }
    }
  }
}

interface Aggregate {
  buyVolume: number;
  sellVolume: number;
  count: number;
  largeCount: number;
  firstPrice: number | null;
  lastPrice: number | null;
  excludedLiquidationCount: number;
  largeTradeNotional: number;
}

function isValidTrade(trade: LighterTrade): boolean {
  return (
    Number.isFinite(trade.time) &&
    Number.isFinite(trade.receivedAt) &&
    Number.isFinite(trade.price) &&
    trade.price > 0 &&
    Number.isFinite(trade.size) &&
    trade.size > 0 &&
    (
      trade.aggressorSide === 'buy' ||
      trade.aggressorSide === 'sell'
    )
  );
}

function getNotional(trade: LighterTrade): number {
  if (
    trade.usdAmount != null &&
    Number.isFinite(trade.usdAmount) &&
    trade.usdAmount > 0
  ) {
    return trade.usdAmount;
  }

  return trade.price * trade.size;
}

function aggregate(
  trades: LighterTrade[],
  fromTime: number,
  toTime: number,
  excludeLiquidations: boolean,
  largeTradeNotionalThreshold = 0
): Aggregate {
  let buyVolume = 0;
  let sellVolume = 0;
  let count = 0;
  let largeCount = 0;
  let firstPrice: number | null = null;
  let lastPrice: number | null = null;
  let excludedLiquidationCount = 0;
  let largeTradeNotional = 0;

  const sorted = trades
    .filter(
      trade =>
        isValidTrade(trade) &&
        trade.receivedAt >= fromTime &&
        trade.receivedAt < toTime
    )
    .sort((a, b) => a.receivedAt - b.receivedAt);

  for (const trade of sorted) {
    if (excludeLiquidations && trade.isLiquidation) {
      excludedLiquidationCount += 1;
      continue;
    }

    const volume = getNotional(trade);

    if (trade.aggressorSide === 'buy') {
      buyVolume += volume;
    } else {
      sellVolume += volume;
    }

    if (
      largeTradeNotionalThreshold > 0 &&
      volume >= largeTradeNotionalThreshold
    ) {
      largeCount += 1;
      largeTradeNotional += volume;
    }

    count += 1;

    if (firstPrice == null) {
      firstPrice = trade.price;
    }

    lastPrice = trade.price;
  }

  return {
    buyVolume,
    sellVolume,
    count,
    largeCount,
    firstPrice,
    lastPrice,
    excludedLiquidationCount,
    largeTradeNotional
  };
}

function emptyResult(
  symbol: string,
  price: number,
  now: number,
  reason: string,
  indicators: TradeFlowIndicators
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
    skipReason: reason,
    signalTime: now,
    signalTimeIso: new Date(now).toISOString(),
    indicators
  };
}

export function analyzeTradeFlow(
  symbol: string,
  trades: LighterTrade[],
  options?: {
    now?: number;
    atr?: number | null;
    config?: Partial<TradeFlowConfig>;
    baselineTracker?: TradeFlowBaselineTracker;
  }
): TradeFlowResult {
  const config: TradeFlowConfig = {
    ...DEFAULT_TRADE_FLOW_CONFIG,
    ...options?.config
  };

  const now = options?.now ?? Date.now();

  const valid = trades
    .filter(isValidTrade)
    .filter(trade => trade.receivedAt <= now)
    .filter(
      trade =>
        now - trade.receivedAt <=
        config.baselineMs + config.windowMs
    )
    .sort((a, b) => a.receivedAt - b.receivedAt);

  const current = aggregate(
    valid,
    now - config.windowMs,
    now + 1,
    config.excludeLiquidations,
    config.largeTradeNotional
  );

  // Микро-окно для раннего входа.
  const early = aggregate(
    valid,
    now - config.earlyWindowMs,
    now + 1,
    config.excludeLiquidations,
    config.largeTradeNotional
  );

  const trackerBaseline =
    options?.baselineTracker?.getBaseline(now);

  let baselineVolumePerWindow =
    trackerBaseline?.volumePerWindow ?? null;

  let nonEmptyBaselineBuckets =
    trackerBaseline?.nonEmptyBuckets ?? 0;

  let excludedLiquidationCount =
    current.excludedLiquidationCount;

  if (!options?.baselineTracker) {
    const baselineStart =
      now - config.windowMs - config.baselineMs;

    const baselineEnd =
      now - config.windowMs;

    const bucketDuration =
      config.baselineMs / config.baselineBuckets;

    const bucketVolumes =
      Array<number>(config.baselineBuckets).fill(0);

    for (let i = 0; i < config.baselineBuckets; i += 1) {
      const bucketStart =
        baselineStart + i * bucketDuration;

      const bucketEnd =
        i === config.baselineBuckets - 1
          ? baselineEnd
          : bucketStart + bucketDuration;

      const bucket = aggregate(
        valid,
        bucketStart,
        bucketEnd,
        config.excludeLiquidations
      );

      bucketVolumes[i] =
        bucket.buyVolume + bucket.sellVolume;

      excludedLiquidationCount +=
        bucket.excludedLiquidationCount;
    }

    nonEmptyBaselineBuckets =
      bucketVolumes.filter(volume => volume > 0).length;

    if (nonEmptyBaselineBuckets >= config.minBaselineBuckets) {
      const value =
        bucketVolumes.reduce((sum, volume) => sum + volume, 0) /
        config.baselineBuckets;

      baselineVolumePerWindow =
        value > 0 ? value : null;
    }
  }

  const totalVolume =
    current.buyVolume + current.sellVolume;

  const imbalance =
    totalVolume > 0
      ? (current.buyVolume - current.sellVolume) / totalVolume
      : 0;

  const volumeMultiple =
    baselineVolumePerWindow != null &&
    baselineVolumePerWindow > 0
      ? totalVolume / baselineVolumePerWindow
      : null;

  const largeTradeShare =
    totalVolume > 0
      ? current.largeTradeNotional / totalVolume
      : 0;

  const latestTrade = valid[valid.length - 1];
  const price = latestTrade?.price ?? 0;

  const atr =
    options?.atr != null &&
    Number.isFinite(options.atr) &&
    options.atr > 0
      ? options.atr
      : null;

  const referencePrice = current.firstPrice;

  const priceMove =
    current.lastPrice != null &&
    referencePrice != null
      ? current.lastPrice - referencePrice
      : null;

  const priceMoveAtr =
    priceMove != null && atr != null
      ? priceMove / atr
      : null;

  const chasePct =
    referencePrice != null &&
    referencePrice > 0 &&
    price > 0
      ? Math.abs(price - referencePrice) / referencePrice
      : 0;

  const earlyTotal =
    early.buyVolume + early.sellVolume;

  const earlyImbalance =
    earlyTotal > 0
      ? (early.buyVolume - early.sellVolume) / earlyTotal
      : 0;

  const earlyVolumeThreshold =
    baselineVolumePerWindow != null
      ? baselineVolumePerWindow *
        config.earlyVolumeMultiplier *
        (config.earlyWindowMs / 1_000)
      : Infinity;

  const earlyTriggered =
    early.largeCount >= config.earlyMinLargeTrades &&
    earlyTotal >= earlyVolumeThreshold &&
    Math.abs(earlyImbalance) >=
      config.earlyMinImbalance;

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
    baselineNonEmptyBuckets: nonEmptyBaselineBuckets,
    largeTradeNotional: current.largeTradeNotional,
    largeTradeShare,
    earlyTriggered,
    earlyWindowTradeCount: early.count,
    earlyLargeTradeCount: early.largeCount,
    earlyImbalance,
    chasePct
  };

  if (!latestTrade || price <= 0) {
    return emptyResult(
      symbol,
      price,
      now,
      'No valid recent trades',
      indicators
    );
  }

  if (now - latestTrade.receivedAt > config.maxTradeAgeMs) {
    return emptyResult(
      symbol,
      price,
      now,
      'Trade stream is stale',
      indicators
    );
  }

  if (baselineVolumePerWindow == null) {
    return emptyResult(
      symbol,
      price,
      now,
      trackerBaseline?.reason ??
        'Insufficient trade-flow baseline',
      indicators
    );
  }

  if (atr == null) {
    return emptyResult(
      symbol,
      price,
      now,
      'ATR unavailable',
      indicators
    );
  }

  if (current.count === 0 || totalVolume <= 0) {
    return emptyResult(
      symbol,
      price,
      now,
      'No eligible trades in current window',
      indicators
    );
  }

  // Анти-пик: импульс уже отработал — не входим.
  if (chasePct > config.maxChasePct) {
    return emptyResult(
      symbol,
      price,
      now,
      `Impulse already exhausted: ` +
        `chase ${(chasePct * 100).toFixed(3)}% > ` +
        `${(config.maxChasePct * 100).toFixed(3)}%`,
      indicators
    );
  }

  // Ранний вход по крупным принтам.
  if (earlyTriggered) {
    const earlySide: 'long' | 'short' =
      earlyImbalance > 0 ? 'long' : 'short';

    const stopDistance =
      atr * config.stopAtrMultiplier;

    const targetDistance =
      atr * config.takeProfitAtrMultiplier;

    const stopLossPrice =
      earlySide === 'long'
        ? price - stopDistance
        : price + stopDistance;

    const takeProfitPrice =
      earlySide === 'long'
        ? price + targetDistance
        : price - targetDistance;

    return {
      symbol,
      ready: true,
      buy: earlySide === 'long',
      sell: earlySide === 'short',
      side: earlySide,
      price,
      takeProfitPrice,
      stopLossPrice,
      positionSize: null,
      regime: 'early_large_print_spike',
      skipReason: null,
      signalTime: latestTrade.time,
      signalTimeIso: new Date(latestTrade.time).toISOString(),
      indicators
    };
  }

  // Обычный путь: подтверждённый 1-секундный всплеск.
  if (current.count < config.minTradesInWindow) {
    return emptyResult(
      symbol,
      price,
      now,
      `Not enough trades in current window: ` +
        `${current.count}/${config.minTradesInWindow}`,
      indicators
    );
  }

  if (largeTradeShare < config.minLargeTradeShare) {
    return emptyResult(
      symbol,
      price,
      now,
      `Flow is not supported by sufficiently large trades: ` +
        `${(largeTradeShare * 100).toFixed(1)}% < ` +
        `${(config.minLargeTradeShare * 100).toFixed(1)}%`,
      indicators
    );
  }

  const spikeConfirmed =
    volumeMultiple != null &&
    volumeMultiple >= config.spikeMultiplier;

  if (!spikeConfirmed) {
    return emptyResult(
      symbol,
      price,
      now,
      'Trade volume spike threshold not met',
      indicators
    );
  }

  let side: 'long' | 'short' | 'none' = 'none';

  if (imbalance >= config.minImbalance) {
    side = 'long';
  } else if (imbalance <= -config.minImbalance) {
    side = 'short';
  }

  if (side === 'none') {
    return emptyResult(
      symbol,
      price,
      now,
      'Aggressor-side imbalance threshold not met',
      indicators
    );
  }

  const directionalMoveAtr =
    priceMoveAtr == null
      ? null
      : side === 'long'
        ? priceMoveAtr
        : -priceMoveAtr;

  if (
    directionalMoveAtr == null ||
    directionalMoveAtr < config.minDirectionalMoveAtr
  ) {
    return emptyResult(
      symbol,
      price,
      now,
      'Price has not confirmed flow direction',
      indicators
    );
  }

  if (directionalMoveAtr > config.maxChaseAtr) {
    return emptyResult(
      symbol,
      price,
      now,
      'Price already moved too far from flow trigger',
      indicators
    );
  }

  const stopDistance =
    atr * config.stopAtrMultiplier;

  const targetDistance =
    atr * config.takeProfitAtrMultiplier;

  const stopLossPrice =
    side === 'long'
      ? price - stopDistance
      : price + stopDistance;

  const takeProfitPrice =
    side === 'long'
      ? price + targetDistance
      : price - targetDistance;

  return {
    symbol,
    ready: true,
    buy: side === 'long',
    sell: side === 'short',
    side,
    price,
    takeProfitPrice,
    stopLossPrice,
    positionSize: null,
    regime: 'aggressive_trade_flow_spike_1s',
    skipReason: null,
    signalTime: latestTrade.time,
    signalTimeIso: new Date(latestTrade.time).toISOString(),
    indicators
  };
}

export function detectMarketRegime(_candles: unknown[]): {
  regime: 'unknown';
  ready: false;
  indicators: null;
} {
  return {
    regime: 'unknown',
    ready: false,
    indicators: null
  };
}
