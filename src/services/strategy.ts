// src/services/strategy.ts

import {
  MACD,
  RSI,
  ATR,
  ADX,
  BollingerBands,
  EMA
} from 'technicalindicators';

export const STARTING_BALANCE = 500;
export const MAX_RISK_PER_TRADE = 0.01;

// Paper-trading комиссия MEXC: 0%
// Применяется отдельно при входе и при выходе позиции.
export const TRADE_FEE_RATE = 0.0;

export const ENABLE_TREND_UP_TRADES = true;

const MIN_ADX_TREND = 21;
const MIN_ADX_RANGE = 20;
const BB_SQUEEZE_THRESHOLD = 0.05;

// Обязательные RSI-окна для трендовых входов.
const TREND_LONG_RSI_MIN = 52.52;
const TREND_LONG_RSI_MAX = 58.5;

const TREND_SHORT_RSI_MIN = 35.0;
const TREND_SHORT_RSI_MAX = 42.43;

// breakout_watch filters
const BREAKOUT_ATR_BUFFER_K = 0.2;
const BREAKOUT_BODY_ATR_MIN = 0.6;

// Skip entry if price moved too far from the original signal level.
const ENTRY_SLIPPAGE_ATR_MAX = 1.0;

// Entry quality filter.
const MAX_ENTRY_EXTENSION_TREND_ATR = 1.5;
const MAX_ENTRY_EXTENSION_BREAKOUT_ATR = 1.5;

// Фильтр по расстоянию до локального экстремума.
const MAX_EXTREMUM_DISTANCE_ATR = 2.5;
const EXTREMUM_LOOKBACK = 30;

// Диапазон волатильности для пробоев.
const BREAKOUT_MIN_ATR_PCT = 0.015;
const BREAKOUT_MAX_ATR_PCT = 0.035;
const BREAKOUT_MIN_BB_WIDTH = 0.03;
const BREAKOUT_MAX_BB_WIDTH = 0.08;

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

function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getVolumeSpike(volumes: number[], avgVol20: number) {
  const latestVolume = volumes[volumes.length - 1] ?? 0;
  return latestVolume >= avgVol20 * 1.3;
}

// Поиск локального экстремума за lookback свечей.
function findLocalExtremum(
  candles: Candle[],
  side: 'long' | 'short',
  lookback: number
) {
  const slice = candles.slice(-lookback);

  if (slice.length === 0) {
    return {
      extremePrice: 0,
      distanceAtr: 0
    };
  }

  const extremePrice =
    side === 'long'
      ? Math.min(...slice.map(candle => candle.low))
      : Math.max(...slice.map(candle => candle.high));

  return {
    extremePrice
  };
}

export function detectMarketRegime(candles: Candle[]) {
  const closes = candles.map(candle => candle.close);
  const highs = candles.map(candle => candle.high);
  const lows = candles.map(candle => candle.low);
  const volumes = candles.map(candle => candle.volume);

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
    ema20.length < 1 ||
    ema50.length < 1 ||
    ema200.length < 1 ||
    bb.length < 1
  ) {
    return {
      regime: 'unknown' as MarketRegime,
      ready: false,
      indicators: null as RegimeIndicators | null
    };
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

  const bbWidth =
    lastBb.middle !== 0
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

  const range =
    lastAdx.adx < MIN_ADX_RANGE &&
    bbWidth < 0.08;

  const breakoutWatch =
    compression &&
    lastAdx.adx >= 15 &&
    lastAdx.adx <= 28 &&
    getVolumeSpike(volumes, avgVol20);

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
  } else if (breakoutWatch) {
    regime = 'breakout_watch';
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
      adx: lastAdx.adx,
      adxRising,
      ema20: lastEma20,
      ema50: lastEma50,
      ema200: lastEma200,
      bbWidth,
      avgVol20
    } satisfies RegimeIndicators
  };
}

export function analyzeMarket(
  candles: Candle[],
  signalPrice?: number
) {
  const closes = candles.map(candle => candle.close);
  const highs = candles.map(candle => candle.high);
  const lows = candles.map(candle => candle.low);

  const regimeInfo = detectMarketRegime(candles);

  const macd = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });

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

  if (
    !regimeInfo.ready ||
    !regimeInfo.indicators ||
    macd.length < 2 ||
    rsi.length < 1 ||
    atr.length < 1 ||
    bb.length < 1
  ) {
    return {
      price: closes[closes.length - 1],
      buy: false,
      sell: false,
      side: 'none' as 'long' | 'short' | 'none',
      takeProfitPrice: null,
      stopLossPrice: null,
      positionSize: null,
      regime: 'unknown' as MarketRegime,
      indicators: {
        ready: false,
        entryExtensionAtr: null,
        maxEntryExtensionAtr: null,
        entryTooExtended: false
      },
      skipReason: 'Indicators not ready'
    };
  }

  const price = last(closes);
  const lastMacd = last(macd);
  const previousMacd = macd[macd.length - 2];

  const lastRsi = last(rsi);
  const previousRsi = rsi[rsi.length - 2] ?? lastRsi;

  const lastAtr = last(atr);
  const lastBb = last(bb);
  const lastCandle = last(candles);
  const lastClose = last(closes);

  const regime = regimeInfo.regime;
  const regimeIndicators = regimeInfo.indicators;

  const macdCrossUp =
    previousMacd.MACD !== undefined &&
    previousMacd.signal !== undefined &&
    lastMacd.MACD !== undefined &&
    lastMacd.signal !== undefined &&
    previousMacd.MACD < previousMacd.signal &&
    lastMacd.MACD > lastMacd.signal;

  const macdCrossDown =
    previousMacd.MACD !== undefined &&
    previousMacd.signal !== undefined &&
    lastMacd.MACD !== undefined &&
    lastMacd.signal !== undefined &&
    previousMacd.MACD > previousMacd.signal &&
    lastMacd.MACD < lastMacd.signal;

  // MACD-cross НЕ является обязательным условием.
  // Достаточно MACD-cross ИЛИ роста RSI.
  const rsiRising = lastRsi > previousRsi;

  // Обязательное RSI-окно для long:
  // 52.52 <= RSI <= 58.50.
  const rsiBull =
    lastRsi >= TREND_LONG_RSI_MIN &&
    lastRsi <= TREND_LONG_RSI_MAX;

  // Обязательное RSI-окно для short:
  // 35 < RSI < 42.43.
  const rsiBear =
    lastRsi > TREND_SHORT_RSI_MIN &&
    lastRsi < TREND_SHORT_RSI_MAX;

  const riskCapital =
    STARTING_BALANCE * MAX_RISK_PER_TRADE;

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

  // Long-тренд:
  // RSI-окно обязательно.
  // Для входа достаточно MACD-cross вверх ИЛИ роста RSI.
  if (
    ENABLE_TREND_UP_TRADES &&
    regime === 'trend_up' &&
    rsiBull &&
    (macdCrossUp || rsiRising) &&
    price > regimeIndicators.ema200
  ) {
    side = 'long';
    buy = true;
    stopLossPrice = price - lastAtr * 1.4;
    takeProfitPrice = price + lastAtr * 2.8;
  }

  // Short-тренд:
  // RSI-окно обязательно.
  // Для входа достаточно MACD-cross вниз ИЛИ роста RSI.
  if (
    regime === 'trend_down' &&
    rsiBear &&
    (macdCrossDown || rsiRising) &&
    price < regimeIndicators.ema200
  ) {
    side = 'short';
    sell = true;
    stopLossPrice = price + lastAtr * 1.4;
    takeProfitPrice = price - lastAtr * 2.8;
  }

  if (regime === 'breakout_watch') {
    const candleBody = Math.abs(
      lastCandle.close - lastCandle.open
    );

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

    const atrPct =
      lastClose > 0 ? lastAtr / lastClose : 0;

    const bbWidth =
      lastBb.middle !== 0
        ? (lastBb.upper - lastBb.lower) / lastBb.middle
        : 0;

    const volatilityOkForBreakout =
      atrPct >= BREAKOUT_MIN_ATR_PCT &&
      atrPct <= BREAKOUT_MAX_ATR_PCT &&
      bbWidth >= BREAKOUT_MIN_BB_WIDTH &&
      bbWidth <= BREAKOUT_MAX_BB_WIDTH;

    let extremumOk = true;

    if (breakoutUp || breakoutDown) {
      const sideForExtremum = breakoutUp
        ? 'long'
        : 'short';

      const { extremePrice } = findLocalExtremum(
        candles,
        sideForExtremum,
        EXTREMUM_LOOKBACK
      );

      if (extremePrice !== 0 && lastAtr > 0) {
        const distanceFromExtremum =
          sideForExtremum === 'long'
            ? lastClose - extremePrice
            : extremePrice - lastClose;

        const distanceAtr =
          Math.abs(distanceFromExtremum) / lastAtr;

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

        // Стоп 1.5 ATR, тейк 2.2 ATR.
        stopLossPrice = price - lastAtr * 1.5;
        takeProfitPrice = price + lastAtr * 2.2;
      } else if (breakoutDown) {
        side = 'short';
        sell = true;
        buy = false;

        // Стоп 1.5 ATR, тейк 2.2 ATR.
        stopLossPrice = price + lastAtr * 1.5;
        takeProfitPrice = price - lastAtr * 2.2;
      }
    }
  }

  if (
    regime === 'high_volatility' ||
    regime === 'range'
  ) {
    buy = false;
    sell = false;
    side = 'none';
    takeProfitPrice = null;
    stopLossPrice = null;
    positionSize = null;
  }

  if (
    (buy || sell) &&
    signalPrice != null &&
    lastAtr > 0
  ) {
    const distanceFromSignal =
      Math.abs(price - signalPrice);

    const signalDistanceAtr =
      distanceFromSignal / lastAtr;

    if (
      signalDistanceAtr > ENTRY_SLIPPAGE_ATR_MAX
    ) {
      buy = false;
      sell = false;
      side = 'none';
      takeProfitPrice = null;
      stopLossPrice = null;
      positionSize = null;

      skipReason =
        `Price moved ${signalDistanceAtr.toFixed(2)} ATR ` +
        `from signal (max ` +
        `${ENTRY_SLIPPAGE_ATR_MAX.toFixed(2)} ATR)`;
    }
  }

  if (side !== 'none' && lastAtr > 0) {
    const referencePrice =
      regime === 'breakout_watch'
        ? side === 'long'
          ? lastBb.upper
          : lastBb.lower
        : regimeIndicators.ema20;

    const distanceFromRef =
      side === 'long'
        ? price - referencePrice
        : referencePrice - price;

    entryExtensionAtr =
      distanceFromRef / lastAtr;

    maxEntryExtensionAtr =
      regime === 'breakout_watch'
        ? MAX_ENTRY_EXTENSION_BREAKOUT_ATR
        : MAX_ENTRY_EXTENSION_TREND_ATR;

    entryTooExtended =
      entryExtensionAtr > maxEntryExtensionAtr;

    if (entryTooExtended) {
      const direction =
        side === 'long' ? 'above' : 'below';

      const refLabel =
        regime === 'breakout_watch'
          ? side === 'long'
            ? 'BB.upper'
            : 'BB.lower'
          : 'EMA20';

      buy = false;
      sell = false;
      side = 'none';
      takeProfitPrice = null;
      stopLossPrice = null;
      positionSize = null;

      skipReason =
        `Entry too extended: ` +
        `${entryExtensionAtr.toFixed(2)} ATR ` +
        `${direction} ${refLabel} ` +
        `(max ${maxEntryExtensionAtr.toFixed(2)} ATR, ` +
        `regime ${regime})`;
    }
  }

  if (
    side !== 'none' &&
    stopLossPrice != null
  ) {
    const riskPerUnit =
      Math.abs(price - stopLossPrice);

    positionSize =
      riskPerUnit > 0
        ? riskCapital / riskPerUnit
        : null;
  }

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
    indicators: {
      macdCrossUp,
      macdCrossDown,
      rsiRising,

      lastRsi,
      previousRsi,

      rsiBull,
      rsiBear,

      trendLongRsiMin: TREND_LONG_RSI_MIN,
      trendLongRsiMax: TREND_LONG_RSI_MAX,
      trendShortRsiMin: TREND_SHORT_RSI_MIN,
      trendShortRsiMax: TREND_SHORT_RSI_MAX,

      lastAtr,

      bbUpper: lastBb.upper,
      bbMiddle: lastBb.middle,
      bbLower: lastBb.lower,

      regimeReady: regimeInfo.ready,
      regimeIndicators,

      breakoutAtrBufferK: BREAKOUT_ATR_BUFFER_K,
      breakoutBodyAtrMin: BREAKOUT_BODY_ATR_MIN,

      entrySlippageAtrMax: ENTRY_SLIPPAGE_ATR_MAX,

      maxEntryExtensionTrendAtr:
        MAX_ENTRY_EXTENSION_TREND_ATR,

      maxEntryExtensionBreakoutAtr:
        MAX_ENTRY_EXTENSION_BREAKOUT_ATR,

      entryExtensionAtr,
      maxEntryExtensionAtr,
      entryTooExtended,

      trendUpTradesEnabled:
        ENABLE_TREND_UP_TRADES,

      tradeFeeRate: TRADE_FEE_RATE,

      ready: true
    }
  };
}
