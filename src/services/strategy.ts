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
const BREAKOUT_BODY_ATR_MIN = 0.6;  // было 0.5, теперь 0.7 ATR

// Skip entry if price moved too far from the original signal level.
// Поднят с 0.5 до 1.0 — режет ~7% сигналов вместо 38%
const ENTRY_SLIPPAGE_ATR_MAX = 1.0;

// Entry quality filter.
// Trend entries should be relatively near EMA20.
// Breakout entries are allowed to be farther because the setup is momentum-based.
const MAX_ENTRY_EXTENSION_TREND_ATR = 1.5;
const MAX_ENTRY_EXTENSION_BREAKOUT_ATR = 1.5;  // было 3.0, теперь мерим от границы BB

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
  return latestVolume >= avgVol20 * 1.3;  // было 1.1, теперь 1.3
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

  // ИЗМЕНЕНИЕ 1: убран adxRising и ema50 > ema200 из условия тренда
  const strongTrendUp =
    lastClose > lastEma200 &&
    lastEma20 > lastEma50 &&
    lastAdx.adx >= MIN_ADX_TREND;
    // было: && lastEma50 > lastEma200 && adxRising;

  const strongTrendDown =
    lastClose < lastEma200 &&
    lastEma20 < lastEma50 &&
    lastAdx.adx >= MIN_ADX_TREND;
    // было: && lastEma50 < lastEma200 && adxRising;

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

  // ИЗМЕНЕНИЕ 3: RSI-окно расширено — тренд 45-75, пробой 50-70
  const rsiBull = regime === 'trend_up'
    ? (lastRsi > 45 && lastRsi < 75)
    : (lastRsi > 50 && lastRsi < 70);  // было 45-65, теперь 50-70 для пробоя

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
  }

  if (regime === 'breakout_watch') {
    const candleBody = Math.abs(lastCandle.close - lastCandle.open);
    const atrBuffer = lastAtr * BREAKOUT_ATR_BUFFER_K;
    const minBody = lastAtr * BREAKOUT_BODY_ATR_MIN;  // теперь 0.7 ATR

    // ИЗМЕНЕНИЕ 4: RSI для пробоя — 50-70 вместо 55+
    const breakoutUp =
      price > lastBb.upper + atrBuffer &&
      candleBody >= minBody &&
      lastRsi > 50 &&
      lastRsi < 70;

    const breakoutDown =
      price < lastBb.lower - atrBuffer &&
      candleBody >= minBody &&
      lastRsi < 50 &&
      lastRsi > 30;

    if (breakoutUp) {
      side = 'long';
      buy = true;
      sell = false;
      // ИЗМЕНЕНИЕ 6: стоп-лосс шире — 1.5 ATR вместо 1.3
      stopLossPrice = price - lastAtr * 1.5;
      takeProfitPrice = price + lastAtr * 3.0;
    } else if (breakoutDown) {
      side = 'short';
      sell = true;
      buy = false;
      // ИЗМЕНЕНИЕ 6: стоп-лосс шире — 1.5 ATR вместо 1.3
      stopLossPrice = price + lastAtr * 1.5;
      takeProfitPrice = price - lastAtr * 3.0;
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

  // Existing protection: skip a signal if price has moved away
  // too far from the original signal level before execution.
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

  // ИЗМЕНЕНИЕ 2: Entry-quality filter — мерим extension от границы BB в пробоях
  if (side !== 'none' && lastAtr > 0) {
    // Для пробоев reference = граница BB, для трендов = EMA20
    const referencePrice =
      regime === 'breakout_watch'
        ? (side === 'long' ? lastBb.upper : lastBb.lower)
        : regimeIndicators.ema20;

    const distanceFromRef =
      side === 'long'
        ? price - referencePrice
        : referencePrice - price;

    entryExtensionAtr = distanceFromRef / lastAtr;

    // Для пробоев лимит 1.5 ATR от границы BB (было 3.0 от EMA20)
    maxEntryExtensionAtr =
      regime === 'breakout_watch'
        ? MAX_ENTRY_EXTENSION_BREAKOUT_ATR  // 1.5
        : MAX_ENTRY_EXTENSION_TREND_ATR;    // 1.5

    entryTooExtended =
      entryExtensionAtr > maxEntryExtensionAtr;

    if (entryTooExtended) {
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
      ready: true
    }
  };
}
