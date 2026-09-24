import {
  MACD,
  RSI,
  ATR,
  ADX,
  BollingerBands,
  EMA
} from 'technicalindicators';

import {
  predictTrade,
  MlPredictionResult
} from './ml/mlModel';

export const STARTING_BALANCE = 150;
export const MAX_RISK_PER_TRADE = 0.01;
export const TRADE_FEE_RATE = 0.0;

export const ENABLE_TREND_UP_TRADES = true;
export const ENABLE_BREAKOUT_TRADES = false;
export const ENABLE_ML_FILTER = true;

const TRADING_HOUR_WINDOWS_UTC_PLUS_4: ReadonlyArray<readonly [number, number]> = [
  [0, 23]
 
];

export const MIN_ENTRY_RSI_SHORT = 38; //Было 39
export const MAX_ENTRY_RSI_SHORT = 43; //Было 42
export const MIN_ENTRY_RSI_LONG = 50; //Было 51
export const MAX_ENTRY_RSI_LONG = 66; //Было 64

export const MIN_ENTRY_ADX_SHORT = 25;
export const MIN_ENTRY_ADX_LONG = 25; //Было 29.5
export const MAX_ENTRY_ADX = 40;

export const MIN_LAST_ATR_PCT = 0.005;
export const MAX_LAST_ATR_PCT_LONG = 5; //Было 0.0195
export const MAX_LAST_ATR_PCT_SHORT = 5; //Было 0.025

export const MIN_BB_WIDTH_LONG = 0.04; //Было 0.053
export const MAX_BB_WIDTH_LONG = 0.090;
export const MIN_BB_WIDTH_SHORT = 0.04; //Было 0.05

export const MIN_ENTRY_DISTANCE_FROM_EMA20_PERCENT = 90;
export const MIN_ENTRY_DISTANCE_FROM_EMA20_ATR =
  MIN_ENTRY_DISTANCE_FROM_EMA20_PERCENT / 100;
export const MAX_ENTRY_EXTENSION_TREND_ATR = 1.8; //Было 1.2
export const REJECT_ENTRY_TOO_EXTENDED = true;

// Blacklist только для Long
export const LONG_BLACKLIST = [''];

export const STOP_LOSS_ATR_MULTIPLIER = 1.4;
export const TAKE_PROFIT_ATR_MULTIPLIER = 1.8;
export const ENABLE_TRAILING_STOP = false;

function getUtcPlus4(date = new Date()): number {
  return (date.getUTCHours() + 4) % 24;
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
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
    ([startHour, endHour]) => hour >= startHour && hour < endHour
  );
}

export function getTradingWindowCheck(
  date = new Date()
): TradingWindowCheck {
  const utcHour = date.getUTCHours();
  const utcPlus4Hour = getUtcPlus4(date);
  const allowed = isTradingTimeUtcPlus4(date);

  if (allowed) {
    return {
      allowed: true,
      utcHour,
      utcPlus4Hour,
      message: null
    };
  }

  return {
    allowed: false,
    utcHour,
    utcPlus4Hour,
    message:
      `Сигнал вне торговых часов: UTC ${formatHour(utcHour)}, ` +
      `UTC+4 ${formatHour(utcPlus4Hour)}. Сделка не открыта.`
  };
}

export function getTradingTimeSkipReason(date = new Date()): string | null {
  return getTradingWindowCheck(date).message;
}

function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getVolumeSpike(volumes: number[], avgVol20: number): boolean {
  const latestVolume = volumes[volumes.length - 1] ?? 0;
  return latestVolume >= avgVol20 * 1.3;
}

function findLocalExtremum(
  candles: Candle[],
  side: 'long' | 'short',
  lookback: number
): { extremePrice: number } {
  const slice = candles.slice(-lookback);
  if (slice.length === 0) return { extremePrice: 0 };

  const extremePrice = side === 'long'
    ? Math.min(...slice.map(candle => candle.low))
    : Math.max(...slice.map(candle => candle.high));

  return { extremePrice };
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type MarketRegime =
  | 'trend_up'
  | 'trend_down'
  | 'range'
  | 'breakout_watch'
  | 'high_volatility'
  | 'unknown';

type RegimeIndicators = {
  lastClose: number;
  lastAtr: number;
  atrPct: number;
  adx: number;
  adxRising: boolean;
  ema20: number;
  ema50: number;
  ema200: number;
  bbWidth: number;
  avgVol20: number;
};

export type StrategyIndicators = {
  macdCrossUp: boolean;
  macdCrossDown: boolean;
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
  tradeFeeRate: number;
  ready: boolean;
  atrPct: number;
  adx: number;
  bbWidth: number;
  ema20: number;
  ema200: number;
  priceVsEma200: number | null;
  entryDistanceFromEma20: number | null;
  entryDistanceFromEma20Atr: number | null;
  isCandleClosed: boolean;
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
  mlProbability: number | null;
  mlThreshold: number | null;
  mlPassed: boolean | null;
  mlTrainedAt: string | null;
  indicators: StrategyIndicators;
};

const MIN_ADX_TREND = 21;
const MIN_ADX_RANGE = 20;
const BB_SQUEEZE_THRESHOLD = 0.05;
const BREAKOUT_ATR_BUFFER_K = 0.2;
const BREAKOUT_BODY_ATR_MIN = 0.6;
const MAX_EXTREMUM_DISTANCE_ATR = 2.5;
const EXTREMUM_LOOKBACK = 30;
const BREAKOUT_MIN_ATR_PCT = 0.015;
const BREAKOUT_MAX_ATR_PCT = 0.035;
const BREAKOUT_MIN_BB_WIDTH = 0.03;
const BREAKOUT_MAX_BB_WIDTH = 0.08;

export function detectMarketRegime(candles: Candle[]): {
  regime: MarketRegime;
  ready: boolean;
  indicators: RegimeIndicators | null;
} {
  const closes = candles.map(candle => candle.close);
  const highs = candles.map(candle => candle.high);
  const lows = candles.map(candle => candle.low);
  const volumes = candles.map(candle => candle.volume);

  const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const adx = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
  const ema20 = EMA.calculate({ period: 20, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const ema200 = EMA.calculate({ period: 200, values: closes });
  const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });

  if (
    atr.length < 2 ||
    adx.length < 2 ||
    ema20.length < 1 ||
    ema50.length < 1 ||
    ema200.length < 1 ||
    bb.length < 1
  ) {
    return { regime: 'unknown', ready: false, indicators: null };
  }

  const lastClose = last(closes);
  const lastAtr = last(atr);
  const lastAdx = last(adx);
  const previousAdx = adx[adx.length - 2];
  const lastEma20 = last(ema20);
  const lastEma50 = last(ema50);
  const lastEma200 = last(ema200);
  const lastBb = last(bb);
  const avgVol20 = mean(volumes.slice(-20));

  const bbWidth = lastBb.middle !== 0
    ? (lastBb.upper - lastBb.lower) / lastBb.middle
    : 0;

  const adxRising = lastAdx.adx > previousAdx.adx;
  const atrPct = lastClose > 0 ? lastAtr / lastClose : 0;
  const compression = bbWidth <= BB_SQUEEZE_THRESHOLD;

  const strongTrendUp =
    lastClose > lastEma200 &&
    lastEma20 > lastEma50 &&
    lastAdx.adx >= MIN_ADX_TREND;

  const strongTrendDown =
    lastClose < lastEma200 &&
    lastEma20 < lastEma50 &&
    lastAdx.adx >= MIN_ADX_TREND;

  const range = lastAdx.adx < MIN_ADX_RANGE && bbWidth < 0.08;

  const breakoutWatch =
    compression &&
    lastAdx.adx >= 15 &&
    lastAdx.adx <= 28 &&
    getVolumeSpike(volumes, avgVol20);

  const highVolatility = atrPct > 0.025 || bbWidth > 0.12;

  let regime: MarketRegime = 'unknown';

  if (highVolatility) regime = 'high_volatility';
  else if (strongTrendUp) regime = 'trend_up';
  else if (strongTrendDown) regime = 'trend_down';
  else if (breakoutWatch) regime = 'breakout_watch';
  else if (range) regime = 'range';

  return {
    regime,
    ready: true,
    indicators: {
      lastClose,
      lastAtr,
      atrPct,
      adx: lastAdx.adx,
      adxRising,
      ema20: lastEma20,
      ema50: lastEma50,
      ema200: lastEma200,
      bbWidth,
      avgVol20
    }
  };
}

export function canOpenTrade(params: {
  symbol: string;
  side: 'long' | 'short' | 'none';
  lastRsi: number;
  atrPct: number;
  adx: number;
  bbWidth: number;
  entryDistanceFromEma20: number;
  entryDistanceFromEma20Atr: number;
  entryTooExtended: boolean;
  now?: Date;
}): boolean {
  const {
    symbol,
    side,
    lastRsi,
    atrPct,
    adx,
    bbWidth,
    entryDistanceFromEma20Atr,
    entryTooExtended,
    now = new Date()
  } = params;

  if (!isTradingTimeUtcPlus4(now)) return false;

  if (side === 'long') {
    const baseSymbol = symbol.split('/')[0].toUpperCase();
    if (LONG_BLACKLIST.includes(baseSymbol)) return false;
  }

  if (side === 'short') {
    if (lastRsi < MIN_ENTRY_RSI_SHORT || lastRsi > MAX_ENTRY_RSI_SHORT) {
      return false;
    }
  } else if (side === 'long') {
    if (lastRsi < MIN_ENTRY_RSI_LONG || lastRsi > MAX_ENTRY_RSI_LONG) {
      return false;
    }
  } else {
    return false;
  }

  const maxAtrPct = side === 'long'
    ? MAX_LAST_ATR_PCT_LONG
    : MAX_LAST_ATR_PCT_SHORT;

  if (atrPct < MIN_LAST_ATR_PCT || atrPct > maxAtrPct) return false;

  const minAdx = side === 'short'
    ? MIN_ENTRY_ADX_SHORT
    : MIN_ENTRY_ADX_LONG;

  if (adx < minAdx || adx > MAX_ENTRY_ADX) return false;

  const minBbWidth = side === 'long'
    ? MIN_BB_WIDTH_LONG
    : MIN_BB_WIDTH_SHORT;

  const maxBbWidth = side === 'long'
    ? MAX_BB_WIDTH_LONG
    : Infinity;

  if (bbWidth < minBbWidth || bbWidth > maxBbWidth) return false;
  if (entryDistanceFromEma20Atr < MIN_ENTRY_DISTANCE_FROM_EMA20_ATR) {
    return false;
  }
  if (entryDistanceFromEma20Atr > MAX_ENTRY_EXTENSION_TREND_ATR) {
    return false;
  }
  if (REJECT_ENTRY_TOO_EXTENDED && entryTooExtended) return false;

  return true;
}

function resetSignalState(state: {
  buy: boolean;
  sell: boolean;
  side: 'long' | 'short' | 'none';
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
  positionSize: number | null;
}): void {
  state.buy = false;
  state.sell = false;
  state.side = 'none';
  state.takeProfitPrice = null;
  state.stopLossPrice = null;
  state.positionSize = null;
}

export async function analyzeMarket(
  candles: Candle[],
  symbol: string,
  signalPrice?: number,
  now = new Date()
): Promise<StrategyResult> {
  const closes = candles.map(candle => candle.close);
  const highs = candles.map(candle => candle.high);
  const lows = candles.map(candle => candle.low);
  const regimeInfo = detectMarketRegime(candles);
  const tradingWindow = getTradingWindowCheck(now);

  const macd = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });

  const rsi = RSI.calculate({ period: 14, values: closes });
  const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });

  const lastCandle = last(candles);
  const signalTime = lastCandle?.time ?? Date.now();
  const signalTimeIso = new Date(
    signalTime < 1_000_000_000_000 ? signalTime * 1000 : signalTime
  ).toISOString();

  if (
    !regimeInfo.ready ||
    !regimeInfo.indicators ||
    macd.length < 2 ||
    rsi.length < 1 ||
    atr.length < 1 ||
    bb.length < 1
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
      mlProbability: null,
      mlThreshold: null,
      mlPassed: null,
      mlTrainedAt: null,
      indicators: {
        macdCrossUp: false,
        macdCrossDown: false,
        lastRsi: 0,
        lastAtr: 0,
        bbUpper: 0,
        bbMiddle: 0,
        bbLower: 0,
        regimeReady: false,
        regimeIndicators: regimeInfo.indicators ?? ({} as RegimeIndicators),
        entryExtensionAtr: null,
        maxEntryExtensionAtr: null,
        entryTooExtended: false,
        tradeFeeRate: TRADE_FEE_RATE,
        ready: false,
        atrPct: 0,
        adx: 0,
        bbWidth: 0,
        ema20: 0,
        ema200: 0,
        priceVsEma200: null,
        entryDistanceFromEma20: null,
        entryDistanceFromEma20Atr: null,
        isCandleClosed: false
      }
    };
  }

  const price = last(closes);
  const lastMacd = last(macd);
  const previousMacd = macd[macd.length - 2];
  const lastRsi = last(rsi);
  const lastAtr = last(atr);
  const lastBb = last(bb);
  const regime = regimeInfo.regime;
  const regimeIndicators = regimeInfo.indicators;

  const macdCrossUp =
    previousMacd.MACD != null &&
    previousMacd.signal != null &&
    lastMacd.MACD != null &&
    lastMacd.signal != null &&
    previousMacd.MACD < previousMacd.signal &&
    lastMacd.MACD > lastMacd.signal;

  const macdCrossDown =
    previousMacd.MACD != null &&
    previousMacd.signal != null &&
    lastMacd.MACD != null &&
    lastMacd.signal != null &&
    previousMacd.MACD > previousMacd.signal &&
    lastMacd.MACD < lastMacd.signal;

  const riskCapital = STARTING_BALANCE * MAX_RISK_PER_TRADE;

  let side: 'long' | 'short' | 'none' = 'none';
  let buy = false;
  let sell = false;
  let takeProfitPrice: number | null = null;
  let stopLossPrice: number | null = null;
  let positionSize: number | null = null;
  let skipReason: string | null = null;
  let entryExtensionAtr: number | null = null;
  let maxEntryExtensionAtr: number | null = null;
  let entryTooExtended = false;
  let mlProbability: number | null = null;
  let mlThreshold: number | null = null;
  let mlPassed: boolean | null = null;
  let mlTrainedAt: string | null = null;

  if (!tradingWindow.allowed) {
    skipReason = tradingWindow.message;
  } else if (
    ENABLE_TREND_UP_TRADES &&
    regime === 'trend_up' &&
    price > regimeIndicators.ema200 &&
    regimeIndicators.ema20 > regimeIndicators.ema50 &&
    regimeIndicators.ema50 > regimeIndicators.ema200
  ) {
    side = 'long';
    buy = true;
    stopLossPrice = price - lastAtr * STOP_LOSS_ATR_MULTIPLIER;
    takeProfitPrice = price + lastAtr * TAKE_PROFIT_ATR_MULTIPLIER;
  } else if (
    regime === 'trend_down' &&
    price < regimeIndicators.ema200 &&
    regimeIndicators.ema20 < regimeIndicators.ema50 &&
    regimeIndicators.ema50 < regimeIndicators.ema200
  ) {
    side = 'short';
    sell = true;
    stopLossPrice = price + lastAtr * STOP_LOSS_ATR_MULTIPLIER;
    takeProfitPrice = price - lastAtr * TAKE_PROFIT_ATR_MULTIPLIER;
  }

  if (
    ENABLE_BREAKOUT_TRADES &&
    tradingWindow.allowed &&
    regime === 'breakout_watch'
  ) {
    const candleBody = Math.abs(lastCandle.close - lastCandle.open);
    const atrBuffer = lastAtr * BREAKOUT_ATR_BUFFER_K;
    const minBody = lastAtr * BREAKOUT_BODY_ATR_MIN;

    const breakoutUp =
      lastCandle.close > lastBb.upper + atrBuffer &&
      candleBody >= minBody &&
      lastRsi > 45 &&
      lastRsi < 75;

    const breakoutDown =
      lastCandle.close < lastBb.lower - atrBuffer &&
      candleBody >= minBody &&
      lastRsi < 55 &&
      lastRsi > 25;

    const atrPct = price > 0 ? lastAtr / price : 0;
    const bbWidth = lastBb.middle !== 0
      ? (lastBb.upper - lastBb.lower) / lastBb.middle
      : 0;

    const volatilityOkForBreakout =
      atrPct >= BREAKOUT_MIN_ATR_PCT &&
      atrPct <= BREAKOUT_MAX_ATR_PCT &&
      bbWidth >= BREAKOUT_MIN_BB_WIDTH &&
      bbWidth <= BREAKOUT_MAX_BB_WIDTH;

    let extremumOk = true;

    if (breakoutUp || breakoutDown) {
      const sideForExtremum = breakoutUp ? 'long' : 'short';
      const { extremePrice } = findLocalExtremum(
        candles,
        sideForExtremum,
        EXTREMUM_LOOKBACK
      );

      if (extremePrice !== 0 && lastAtr > 0) {
        const distanceFromExtremum = sideForExtremum === 'long'
          ? price - extremePrice
          : extremePrice - price;
        const distanceAtr = Math.abs(distanceFromExtremum) / lastAtr;

        if (distanceAtr > MAX_EXTREMUM_DISTANCE_ATR) {
          extremumOk = false;
        }
      }
    }

    if (volatilityOkForBreakout && extremumOk) {
      if (breakoutUp) {
        side = 'long';
        buy = true;
        sell = false;
        stopLossPrice = price - lastAtr * 1.5;
        takeProfitPrice = price + lastAtr * 2.2;
      } else if (breakoutDown) {
        side = 'short';
        sell = true;
        buy = false;
        stopLossPrice = price + lastAtr * 1.5;
        takeProfitPrice = price - lastAtr * 2.2;
      }
    }
  }

  if (regime === 'high_volatility' || regime === 'range') {
    resetSignalState({
      buy,
      sell,
      side,
      takeProfitPrice,
      stopLossPrice,
      positionSize
    });
    skipReason = `Trading disabled for regime: ${regime}`;
  }

  if ((buy || sell) && signalPrice != null && lastAtr > 0) {
    const distanceFromSignal = Math.abs(price - signalPrice);
    const signalDistanceAtr = distanceFromSignal / lastAtr;

    if (signalDistanceAtr > 1.0) {
      resetSignalState({
        buy,
        sell,
        side,
        takeProfitPrice,
        stopLossPrice,
        positionSize
      });
      skipReason =
        `Price moved ${signalDistanceAtr.toFixed(2)} ATR ` +
        `(max 1.00 ATR)`;
    }
  }

  if (side !== 'none' && lastAtr > 0) {
    const referencePrice = regime === 'breakout_watch'
      ? side === 'long' ? lastBb.upper : lastBb.lower
      : regimeIndicators.ema20;

    const distanceFromRef = side === 'long'
      ? price - referencePrice
      : referencePrice - price;

    entryExtensionAtr = distanceFromRef / lastAtr;
    maxEntryExtensionAtr = MAX_ENTRY_EXTENSION_TREND_ATR;
    entryTooExtended = entryExtensionAtr > maxEntryExtensionAtr;

    if (entryTooExtended) {
      resetSignalState({
        buy,
        sell,
        side,
        takeProfitPrice,
        stopLossPrice,
        positionSize
      });
      skipReason =
        `Entry too extended: ${entryExtensionAtr.toFixed(2)} ATR ` +
        `(max ${maxEntryExtensionAtr.toFixed(2)} ATR)`;
    }
  }

  if (side !== 'none' && stopLossPrice != null) {
    const entryDistanceFromEma20 = side === 'long'
      ? price - regimeIndicators.ema20
      : regimeIndicators.ema20 - price;

    const entryDistanceFromEma20Atr = lastAtr > 0
      ? entryDistanceFromEma20 / lastAtr
      : 0;

    const canOpen = canOpenTrade({
      symbol,
      side,
      lastRsi,
      atrPct: regimeIndicators.atrPct,
      adx: regimeIndicators.adx,
      bbWidth: regimeIndicators.bbWidth,
      entryDistanceFromEma20,
      entryDistanceFromEma20Atr,
      entryTooExtended,
      now
    });

    if (!canOpen) {
      resetSignalState({
        buy,
        sell,
        side,
        takeProfitPrice,
        stopLossPrice,
        positionSize
      });

      if (skipReason == null) {
        skipReason =
          'Entry filters failed ' +
          '(RSI/ADX/ATR/BB/EMA20/trading window/blacklist)';
      }
    }
  }

  if (
    ENABLE_ML_FILTER &&
    side !== 'none' &&
    stopLossPrice != null
  ) {
    const entryDistanceFromEma20 = side === 'long'
      ? price - regimeIndicators.ema20
      : regimeIndicators.ema20 - price;

    const entryDistanceFromEma20Atr = lastAtr > 0
      ? entryDistanceFromEma20 / lastAtr
      : 0;

    try {
      const prediction: MlPredictionResult =
        await predictTrade({
          entryPrice: price,
          ema20: regimeIndicators.ema20,
          ema50: regimeIndicators.ema50,
          ema200: regimeIndicators.ema200,
          lastRsi,
          adx: regimeIndicators.adx,
          bbWidth: regimeIndicators.bbWidth,
          atrPct: regimeIndicators.atrPct,
          lastAtr,
          entryDistanceFromEma20Atr,
          side,
          hourUtc: now.getUTCHours()
        });

      mlProbability = prediction.probability;
      mlThreshold = prediction.threshold;
      mlPassed = prediction.passed;
      mlTrainedAt = prediction.trainedAt;

      if (!prediction.passed) {
        resetSignalState({
          buy,
          sell,
          side,
          takeProfitPrice,
          stopLossPrice,
          positionSize
        });

        skipReason =
          `ML filter rejected trade: ` +
          `probability=${prediction.probability.toFixed(4)}, ` +
          `threshold=${prediction.threshold.toFixed(4)}`;
      }
    } catch (error) {
      resetSignalState({
        buy,
        sell,
        side,
        takeProfitPrice,
        stopLossPrice,
        positionSize
      });

      mlPassed = false;

      const message = error instanceof Error
        ? error.message
        : String(error);

      skipReason = `ML prediction failed: ${message}`;
    }
  }

  if (side !== 'none' && stopLossPrice != null) {
    const riskPerUnit = Math.abs(price - stopLossPrice);
    positionSize = riskPerUnit > 0
      ? riskCapital / riskPerUnit
      : null;
  }

  const entryDistanceFromEma20ForLog = side !== 'none'
    ? side === 'long'
      ? price - regimeIndicators.ema20
      : regimeIndicators.ema20 - price
    : null;

  const entryDistanceFromEma20AtrForLog =
    side !== 'none' &&
    lastAtr > 0 &&
    entryDistanceFromEma20ForLog != null
      ? entryDistanceFromEma20ForLog / lastAtr
      : null;

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
    mlProbability,
    mlThreshold,
    mlPassed,
    mlTrainedAt,
    indicators: {
      macdCrossUp,
      macdCrossDown,
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
      tradeFeeRate: TRADE_FEE_RATE,
      ready: side !== 'none',
      atrPct: regimeIndicators.atrPct,
      adx: regimeIndicators.adx,
      bbWidth: regimeIndicators.bbWidth,
      ema20: regimeIndicators.ema20,
      ema200: regimeIndicators.ema200,
      priceVsEma200: regimeIndicators.ema200 > 0
        ? (price - regimeIndicators.ema200) / regimeIndicators.ema200
        : null,
      entryDistanceFromEma20: entryDistanceFromEma20ForLog,
      entryDistanceFromEma20Atr: entryDistanceFromEma20AtrForLog,
      isCandleClosed: false
    }
  };
}

export type TelegramSender = (message: string) => Promise<void>;

export async function notifyStrategyResult(
  result: StrategyResult,
  symbol: string,
  sendTelegramMessage: TelegramSender
): Promise<void> {
  if (result.skipReason != null) {
    await sendTelegramMessage(
      `⚠️ ${symbol}\n` +
      `${result.skipReason}\n` +
      `ML probability: ${result.mlProbability != null
        ? result.mlProbability.toFixed(4)
        : '-'}\n` +
      `ML threshold: ${result.mlThreshold != null
        ? result.mlThreshold.toFixed(4)
        : '-'}\n` +
      `ML trained at: ${result.mlTrainedAt ?? '-'}`
    );
    return;
  }

  if (result.buy || result.sell) {
    const direction = result.buy ? 'LONG' : 'SHORT';

    await sendTelegramMessage(
      `📊 ${symbol} ${direction}\n` +
      `Цена: ${result.price}\n` +
      `TP: ${result.takeProfitPrice ?? '-'}\n` +
      `SL: ${result.stopLossPrice ?? '-'}\n` +
      `Размер: ${result.positionSize ?? '-'}\n` +
      `RSI: ${result.indicators.lastRsi.toFixed(2)}\n` +
      `ADX: ${result.indicators.adx.toFixed(2)}\n` +
      `ATR %: ${(result.indicators.atrPct * 100).toFixed(3)}%\n` +
      `BB Width: ${result.indicators.bbWidth.toFixed(5)}\n` +
      `Distance EMA20 ATR: ${result.indicators.entryDistanceFromEma20Atr?.toFixed(3) ?? '-'}\n` +
      `ML probability: ${result.mlProbability?.toFixed(4) ?? '-'}\n` +
      `ML threshold: ${result.mlThreshold?.toFixed(4) ?? '-'}\n` +
      `Режим: ${result.regime}`
    );
  }
}
