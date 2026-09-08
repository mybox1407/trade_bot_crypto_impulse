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

// Paper-trading комиссия MEXC: 0.04% за исполнение.
// Применяется отдельно при входе и при выходе позиции.
export const TRADE_FEE_RATE = 0.0004;

export const ENABLE_TREND_UP_TRADES = true;

const MIN_ADX_TREND = 21;
const MIN_ADX_RANGE = 20;
const BB_SQUEEZE_THRESHOLD = 0.05;

// breakout_watch filters
const BREAKOUT_ATR_BUFFER_K = 0.2;
const BREAKOUT_BODY_ATR_MIN = 0.6;

// Skip entry if price moved too far from the original signal level.
const ENTRY_SLIPPAGE_ATR_MAX = 1.0;

// Entry quality filter.
const MAX_ENTRY_EXTENSION_TREND_ATR = 1.5;
const MAX_ENTRY_EXTENSION_BREAKOUT_ATR = 1.5;

// Exit management
const BE_TRIGGER_ATR = 0.8;
const PARTIAL_CLOSE_ATR = 1.0;
const TRAILING_STOP_ATR = 0.8;

// Для breakout_watch: частичное закрытие раньше (0.6 ATR вместо 1.0)
const BREAKOUT_PARTIAL_CLOSE_ATR = 0.6;

// Фильтр ликвидности: минимальный ATR% от цены (0.5%)
const MIN_ATR_PCT = 0.005;

// Счётчики вето (сбрасываются внешним кодом при рестарте)
export const vetoCounters = {
  ema20Extension: 0,
  entryExtensionAtr: 0,
  rsiCapBreakout: 0,
  volumeSpike: 0,
  macdCross: 0,
  bbSqueeze: 0,
  totalCandidates: 0
};

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

function last<T>(arr: T[]) {
  return arr[arr.length - 1];
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getVolumeSpike(volumes: number[], avgVol20: number) {
  const latestVolume = volumes[volumes.length - 1] ?? 0;
  return latestVolume >= avgVol20 * 1.2;
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

export function analyzeMarket(candles: Candle[], signalPrice?: number) {
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
  const lastAtr = last(atr);
  const lastBb = last(bb);
  const lastCandle = last(candles);

  const regime = regimeInfo.regime;
  const regimeIndicators = regimeInfo.indicators;

  const macdCrossUp =
    previousMacd.MACD! < previousMacd.signal! &&
    lastMacd.MACD! > lastMacd.signal!;

  const macdCrossDown =
    previousMacd.MACD! > previousMacd.signal! &&
    lastMacd.MACD! < lastMacd.signal!;

  // Счётчик: macdCross (только для кандидатов)
  if (macdCrossUp || macdCrossDown) {
    vetoCounters.macdCross++;
  }

  // RSI: тренд 45-75, пробой 50-75
  const rsiBull = regime === 'trend_up'
    ? (lastRsi > 45 && lastRsi < 75)
    : (lastRsi > 50 && lastRsi < 75);

  const rsiBear = lastRsi < 60 && lastRsi > 35;

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

  const partialCloseInfo = {
    enabled: false,
    closeFraction: 0,
    triggerAtr: 0
  };

  const trailingInfo = {
    enabled: false,
    stopAtr: 0
  };

  // ========== Фильтр ликвидности: отсекаем мёртвые инструменты ==========
  if (regimeIndicators.atrPct < MIN_ATR_PCT) {
    return {
      price,
      buy: false,
      sell: false,
      side: 'none' as 'long' | 'short' | 'none',
      takeProfitPrice: null,
      stopLossPrice: null,
      positionSize: null,
      regime,
      skipReason: `Low volatility (ATR% ${(regimeIndicators.atrPct * 100).toFixed(2)}% < ${(MIN_ATR_PCT * 100).toFixed(1)}%)`,
      indicators: {
        macdCrossUp,
        macdCrossDown,
        lastRsi,
        lastAtr,
        rsiBull,
        rsiBear,
        bbUpper: lastBb.upper,
        bbMiddle: lastBb.middle,
        bbLower: lastBb.lower,
        regimeReady: regimeInfo.ready,
        regimeIndicators,
        breakoutAtrBufferK: BREAKOUT_ATR_BUFFER_K,
        breakoutBodyAtrMin: BREAKOUT_BODY_ATR_MIN,
        entrySlippageAtrMax: ENTRY_SLIPPAGE_ATR_MAX,
        maxEntryExtensionTrendAtr: MAX_ENTRY_EXTENSION_TREND_ATR,
        maxEntryExtensionBreakoutAtr: MAX_ENTRY_EXTENSION_BREAKOUT_ATR,
        entryExtensionAtr: null,
        maxEntryExtensionAtr: null,
        entryTooExtended: false,
        trendUpTradesEnabled: ENABLE_TREND_UP_TRADES,
        tradeFeeRate: TRADE_FEE_RATE,
        ready: true,
        beTriggerAtr: BE_TRIGGER_ATR,
        partialCloseAtr: PARTIAL_CLOSE_ATR,
        trailingStopAtr: TRAILING_STOP_ATR,
        partialCloseInfo,
        trailingInfo,
        vetoCounters: { ...vetoCounters }
      }
    };
  }

  // ========== Логика входов ==========

  if (
    ENABLE_TREND_UP_TRADES &&
    regime === 'trend_up' &&
    macdCrossUp &&
    rsiBull &&
    price > regimeIndicators.ema200
  ) {
    side = 'long';
    buy = true;
    stopLossPrice = price - lastAtr * 1.4;
    takeProfitPrice = price + lastAtr * 2.8;

    partialCloseInfo.enabled = true;
    partialCloseInfo.closeFraction = 0.5;
    partialCloseInfo.triggerAtr = PARTIAL_CLOSE_ATR;

    trailingInfo.enabled = true;
    trailingInfo.stopAtr = TRAILING_STOP_ATR;
  }

  if (
    regime === 'trend_down' &&
    macdCrossDown &&
    rsiBear &&
    price < regimeIndicators.ema200
  ) {
    side = 'short';
    sell = true;
    stopLossPrice = price + lastAtr * 1.4;
    takeProfitPrice = price - lastAtr * 2.8;

    partialCloseInfo.enabled = true;
    partialCloseInfo.closeFraction = 0.5;
    partialCloseInfo.triggerAtr = PARTIAL_CLOSE_ATR;

    trailingInfo.enabled = true;
    trailingInfo.stopAtr = TRAILING_STOP_ATR;
  }

  if (regime === 'breakout_watch') {
    const candleBody = Math.abs(lastCandle.close - lastCandle.open);
    const atrBuffer = lastAtr * BREAKOUT_ATR_BUFFER_K;
    const minBody = lastAtr * BREAKOUT_BODY_ATR_MIN;

    const breakoutUp =
      price > lastBb.upper + atrBuffer &&
      candleBody >= minBody &&
      lastRsi > 50 &&
      lastRsi < 75;

    // Счётчик: RSI cap для пробоя
    if (
      price > lastBb.upper + atrBuffer &&
      candleBody >= minBody &&
      lastRsi >= 75
    ) {
      vetoCounters.rsiCapBreakout++;
    }

    const breakoutDown =
      price < lastBb.lower - atrBuffer &&
      candleBody >= minBody &&
      lastRsi < 50 &&
      lastRsi > 30;

    if (breakoutUp) {
      side = 'long';
      buy = true;
      sell = false;
      stopLossPrice = price - lastAtr * 1.5;
      takeProfitPrice = price + lastAtr * 3.0;

      partialCloseInfo.enabled = true;
      partialCloseInfo.closeFraction = 0.5;
      partialCloseInfo.triggerAtr = BREAKOUT_PARTIAL_CLOSE_ATR;

      trailingInfo.enabled = true;
      trailingInfo.stopAtr = TRAILING_STOP_ATR;
    } else if (breakoutDown) {
      side = 'short';
      sell = true;
      buy = false;
      stopLossPrice = price + lastAtr * 1.5;
      takeProfitPrice = price - lastAtr * 3.0;

      partialCloseInfo.enabled = true;
      partialCloseInfo.closeFraction = 0.5;
      partialCloseInfo.triggerAtr = BREAKOUT_PARTIAL_CLOSE_ATR;

      trailingInfo.enabled = true;
      trailingInfo.stopAtr = TRAILING_STOP_ATR;
    }
  }

  if (regime === 'high_volatility' || regime === 'range') {
    buy = false;
    sell = false;
    side = 'none';
    takeProfitPrice = null;
    stopLossPrice = null;
    positionSize = null;
  }

  // ========== Фильтр: price moved away from signal ==========
  if ((buy || sell) && signalPrice != null && lastAtr > 0) {
    const distanceFromSignal = Math.abs(price - signalPrice);
    const signalDistanceAtr = distanceFromSignal / lastAtr;

    if (signalDistanceAtr > ENTRY_SLIPPAGE_ATR_MAX) {
      buy = false;
      sell = false;
      side = 'none';
      takeProfitPrice = null;
      stopLossPrice = null;
      positionSize = null;

      skipReason =
        `Price moved ${signalDistanceAtr.toFixed(2)} ATR ` +
        `from signal (max ${ENTRY_SLIPPAGE_ATR_MAX.toFixed(2)} ATR)`;
    }
  }

  // ========== Фильтр: EMA20 extension (ТОЛЬКО для трендов) ==========
  if (
    side !== 'none' &&
    regimeIndicators &&
    regimeIndicators.ema20 > 0 &&
    (regime === 'trend_up' || regime === 'trend_down')
  ) {
    const distanceFromEma20 =
      side === 'long'
        ? (price - regimeIndicators.ema20) / regimeIndicators.ema20 * 100
        : (regimeIndicators.ema20 - price) / regimeIndicators.ema20 * 100;

    if (distanceFromEma20 > 1.5) {
      vetoCounters.ema20Extension++;

      return {
        price,
        buy: false,
        sell: false,
        side: 'none' as 'long' | 'short' | 'none',
        takeProfitPrice: null,
        stopLossPrice: null,
        positionSize: null,
        regime,
        skipReason: `Too extended from EMA20 (${distanceFromEma20.toFixed(2)}%)`,
        indicators: {
          macdCrossUp,
          macdCrossDown,
          lastRsi,
          lastAtr,
          rsiBull,
          rsiBear,
          bbUpper: lastBb.upper,
          bbMiddle: lastBb.middle,
          bbLower: lastBb.lower,
          regimeReady: regimeInfo.ready,
          regimeIndicators,
          breakoutAtrBufferK: BREAKOUT_ATR_BUFFER_K,
          breakoutBodyAtrMin: BREAKOUT_BODY_ATR_MIN,
          entrySlippageAtrMax: ENTRY_SLIPPAGE_ATR_MAX,
          maxEntryExtensionTrendAtr: MAX_ENTRY_EXTENSION_TREND_ATR,
          maxEntryExtensionBreakoutAtr: MAX_ENTRY_EXTENSION_BREAKOUT_ATR,
          entryExtensionAtr: null,
          maxEntryExtensionAtr: null,
          entryTooExtended: false,
          trendUpTradesEnabled: ENABLE_TREND_UP_TRADES,
          tradeFeeRate: TRADE_FEE_RATE,
          ready: true,
          beTriggerAtr: BE_TRIGGER_ATR,
          partialCloseAtr: PARTIAL_CLOSE_ATR,
          trailingStopAtr: TRAILING_STOP_ATR,
          partialCloseInfo,
          trailingInfo
        }
      };
    }
  }

  // ========== Фильтр: Entry extension ATR ==========
  if (side !== 'none' && lastAtr > 0) {
    const referencePrice =
      regime === 'breakout_watch'
        ? (side === 'long' ? lastBb.upper : lastBb.lower)
        : regimeIndicators.ema20;

    const distanceFromRef =
      side === 'long'
        ? price - referencePrice
        : referencePrice - price;

    entryExtensionAtr = distanceFromRef / lastAtr;

    maxEntryExtensionAtr =
      regime === 'breakout_watch'
        ? MAX_ENTRY_EXTENSION_BREAKOUT_ATR
        : MAX_ENTRY_EXTENSION_TREND_ATR;

    entryTooExtended =
      entryExtensionAtr > maxEntryExtensionAtr;

    if (entryTooExtended) {
      vetoCounters.entryExtensionAtr++;

      const direction = side === 'long' ? 'above' : 'below';
      const refLabel = regime === 'breakout_watch'
        ? (side === 'long' ? 'BB.upper' : 'BB.lower')
        : 'EMA20';

      buy = false;
      sell = false;
      side = 'none';
      takeProfitPrice = null;
      stopLossPrice = null;
      positionSize = null;

      skipReason =
        `Entry too extended: ${entryExtensionAtr.toFixed(2)} ATR ` +
        `${direction} ${refLabel} (max ${maxEntryExtensionAtr.toFixed(2)} ATR, ` +
        `regime ${regime})`;
    }
  }

  if (side !== 'none' && stopLossPrice != null) {
    const riskPerUnit = Math.abs(price - stopLossPrice);

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
      lastRsi,
      lastAtr,
      rsiBull,
      rsiBear,
      bbUpper: lastBb.upper,
      bbMiddle: lastBb.middle,
      bbLower: lastBb.lower,
      regimeReady: regimeInfo.ready,
      regimeIndicators,
      breakoutAtrBufferK: BREAKOUT_ATR_BUFFER_K,
      breakoutBodyAtrMin: BREAKOUT_BODY_ATR_MIN,
      entrySlippageAtrMax: ENTRY_SLIPPAGE_ATR_MAX,
      maxEntryExtensionTrendAtr: MAX_ENTRY_EXTENSION_TREND_ATR,
      maxEntryExtensionBreakoutAtr: MAX_ENTRY_EXTENSION_BREAKOUT_ATR,
      entryExtensionAtr,
      maxEntryExtensionAtr,
      entryTooExtended,
      trendUpTradesEnabled: ENABLE_TREND_UP_TRADES,
      tradeFeeRate: TRADE_FEE_RATE,
      ready: true,
      beTriggerAtr: BE_TRIGGER_ATR,
      partialCloseAtr:
        regime === 'breakout_watch'
          ? BREAKOUT_PARTIAL_CLOSE_ATR
          : PARTIAL_CLOSE_ATR,
      trailingStopAtr: TRAILING_STOP_ATR,
      partialCloseInfo,
      trailingInfo,
      vetoCounters: { ...vetoCounters }
    }
  };
}
