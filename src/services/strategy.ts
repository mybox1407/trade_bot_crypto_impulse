import {
  MACD,
  RSI,
  ATR,
  ADX,
  BollingerBands,
  EMA
} from 'technicalindicators';

// ========== БАЗОВАЯ КОНФИГУРАЦИЯ ==========

export const STARTING_BALANCE = 150;
export const MAX_RISK_PER_TRADE = 0.01;
export const TRADE_FEE_RATE = 0.0;

export const ENABLE_TREND_UP_TRADES = true;
export const ENABLE_BREAKOUT_TRADES = false;

// Время: UTC+4.
// Торговля разрешена с 14:00 до 01:59.
// В 02:00–13:59 новые позиции не открываются.
export const TRADING_START_HOUR_UTC_PLUS_4 = 12;
export const TRADING_END_HOUR_UTC_PLUS_4 = 2;

// RSI
export const MIN_ENTRY_RSI = 39;
export const MAX_ENTRY_RSI = 42;

// ADX
export const MIN_ENTRY_ADX = 22;
export const MAX_ENTRY_ADX = 40;

// ATR: абсолютное значение для конкретного тикера
export const MIN_LAST_ATR = 0.005;
export const MAX_LAST_ATR = 5.0;

// Ширина Bollinger Bands
export const MIN_BB_WIDTH = 0.025;

// Минимальное расстояние от EMA20.
// 90% ATR = 0.9 ATR.
export const MIN_ENTRY_DISTANCE_FROM_EMA20_PERCENT = 90;
export const MIN_ENTRY_DISTANCE_FROM_EMA20_ATR =
  MIN_ENTRY_DISTANCE_FROM_EMA20_PERCENT / 100;

// Максимальное растяжение входа относительно EMA20
export const MAX_ENTRY_EXTENSION_TREND_ATR = 1.5;

// Не брать растянутый вход
export const REJECT_ENTRY_TOO_EXTENDED = true;

// Управление сделкой
export const STOP_LOSS_ATR_MULTIPLIER = 1.4;
export const TAKE_PROFIT_ATR_MULTIPLIER = 1.8;

// Trailing не используем в базовой версии
export const ENABLE_TRAILING_STOP = false;

// ========== ФУНКЦИИ ВРЕМЕНИ ==========

function getUtcPlus4(date = new Date()): number {
  return (date.getUTCHours() + 4) % 24;
}

export function isTradingTimeUtcPlus4(date = new Date()): boolean {
  const hour = getUtcPlus4(date);

  // 12:00–23:59 и 00:00–01:59 UTC+4
  return hour >= 12 || hour < 2;
}

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getVolumeSpike(
  volumes: number[],
  avgVol20: number
): boolean {
  const latestVolume = volumes[volumes.length - 1] ?? 0;

  return latestVolume >= avgVol20 * 1.3;
}

// Поиск локального экстремума за lookback свечей
function findLocalExtremum(
  candles: Candle[],
  side: 'long' | 'short',
  lookback: number
): {
  extremePrice: number;
} {
  const slice = candles.slice(-lookback);

  if (slice.length === 0) {
    return {
      extremePrice: 0
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

// ========== ТИПЫ ==========

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
  indicators: StrategyIndicators;
};

// ========== ДЕТЕКЦИЯ РЕЖИМА РЫНКА ==========

const MIN_ADX_TREND = 21;
const MIN_ADX_RANGE = 20;
const BB_SQUEEZE_THRESHOLD = 0.05;

// Фильтры breakout_watch
const BREAKOUT_ATR_BUFFER_K = 0.2;
const BREAKOUT_BODY_ATR_MIN = 0.6;

// Фильтр расстояния до локального экстремума
const MAX_EXTREMUM_DISTANCE_ATR = 2.5;
const EXTREMUM_LOOKBACK = 30;

// Диапазон волатильности для пробоев
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
    }
  };
}

// ========== ФИНАЛЬНАЯ ПРОВЕРКА ВХОДА ==========

export function canOpenTrade(params: {
  symbol: string;
  side: 'long' | 'short' | 'none';
  lastRsi: number;
  lastAtr: number;
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
    lastAtr,
    adx,
    bbWidth,
    entryDistanceFromEma20Atr,
    entryTooExtended,
    now = new Date()
  } = params;

  // Оставлено для совместимости и будущего symbol-filter.
  void symbol;
  void side;

  if (!isTradingTimeUtcPlus4(now)) {
    return false;
  }

  if (lastRsi < MIN_ENTRY_RSI || lastRsi > MAX_ENTRY_RSI) {
    return false;
  }

  if (lastAtr < MIN_LAST_ATR || lastAtr > MAX_LAST_ATR) {
    return false;
  }

  if (adx < MIN_ENTRY_ADX || adx > MAX_ENTRY_ADX) {
    return false;
  }

  if (bbWidth < MIN_BB_WIDTH) {
    return false;
  }

  // Минимум 90% ATR расстояния от EMA20
  if (entryDistanceFromEma20Atr < MIN_ENTRY_DISTANCE_FROM_EMA20_ATR) {
    return false;
  }

  if (REJECT_ENTRY_TOO_EXTENDED && entryTooExtended) {
    return false;
  }

  return true;
}

// ========== АНАЛИЗ РЫНКА ==========

export function analyzeMarket(
  candles: Candle[],
  symbol: string,
  signalPrice?: number
): StrategyResult {
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
    const lastCandle = last(candles);
    const signalTime = lastCandle?.time ?? Date.now();

    const signalTimeIso = new Date(
      signalTime < 1_000_000_000_000
        ? signalTime * 1000
        : signalTime
    ).toISOString();

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
      indicators: {
        macdCrossUp: false,
        macdCrossDown: false,
        lastRsi: 0,
        lastAtr: 0,
        bbUpper: 0,
        bbMiddle: 0,
        bbLower: 0,
        regimeReady: false,
        regimeIndicators:
          regimeInfo.indicators ?? ({} as RegimeIndicators),
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
  const lastCandle = last(candles);
  const lastClose = last(closes);

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

  // ========== ЛОНГ: TREND UP ==========

  if (
    ENABLE_TREND_UP_TRADES &&
    regime === 'trend_up' &&
    price > regimeIndicators.ema200
  ) {
    side = 'long';
    buy = true;

    stopLossPrice =
      price - lastAtr * STOP_LOSS_ATR_MULTIPLIER;

    takeProfitPrice =
      price + lastAtr * TAKE_PROFIT_ATR_MULTIPLIER;
  }

  // ========== ШОРТ: TREND DOWN ==========

  if (
    regime === 'trend_down' &&
    price < regimeIndicators.ema200
  ) {
    side = 'short';
    sell = true;

    stopLossPrice =
      price + lastAtr * STOP_LOSS_ATR_MULTIPLIER;

    takeProfitPrice =
      price - lastAtr * TAKE_PROFIT_ATR_MULTIPLIER;
  }

  // ========== ПРОБОЙ: BREAKOUT WATCH ==========

  if (
    ENABLE_BREAKOUT_TRADES &&
    regime === 'breakout_watch'
  ) {
    const candleBody = Math.abs(
      lastCandle.close - lastCandle.open
    );

    const atrBuffer =
      lastAtr * BREAKOUT_ATR_BUFFER_K;

    const minBody =
      lastAtr * BREAKOUT_BODY_ATR_MIN;

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
      lastClose > 0
        ? lastAtr / lastClose
        : 0;

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
      const sideForExtremum =
        breakoutUp ? 'long' : 'short';

      const { extremePrice } =
        findLocalExtremum(
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

        if (
          distanceAtr > MAX_EXTREMUM_DISTANCE_ATR
        ) {
          extremumOk = false;
        }
      }
    }

    if (
      volatilityOkForBreakout &&
      extremumOk
    ) {
      if (breakoutUp) {
        side = 'long';
        buy = true;
        sell = false;

        stopLossPrice =
          price - lastAtr * 1.5;

        takeProfitPrice =
          price + lastAtr * 2.2;
      } else if (breakoutDown) {
        side = 'short';
        sell = true;
        buy = false;

        stopLossPrice =
          price + lastAtr * 1.5;

        takeProfitPrice =
          price - lastAtr * 2.2;
      }
    }
  }

  // ========== БЛОКИРОВКА: HIGH VOLATILITY / RANGE ==========

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

    if (skipReason == null) {
      skipReason = `Trading disabled for regime: ${regime}`;
    }
  }

  // ========== ПРОВЕРКА СЛИППЕЙДЖА ОТ СИГНАЛА ==========

  if (
    (buy || sell) &&
    signalPrice != null &&
    lastAtr > 0
  ) {
    const distanceFromSignal =
      Math.abs(price - signalPrice);

    const signalDistanceAtr =
      distanceFromSignal / lastAtr;

    if (signalDistanceAtr > 1.0) {
      buy = false;
      sell = false;
      side = 'none';
      takeProfitPrice = null;
      stopLossPrice = null;
      positionSize = null;

      skipReason =
        `Price moved ${signalDistanceAtr.toFixed(2)} ATR ` +
        `from signal (max 1.00 ATR)`;
    }
  }

  // ========== РАССТОЯНИЕ ОТ EMA20 / BB ==========

  if (
    side !== 'none' &&
    lastAtr > 0
  ) {
    const referencePrice =
      regime === 'breakout_watch'
        ? side === 'long'
          ? lastBb.upper
          : lastBb.lower
        : regimeIndicators.ema20;

    // Направленное расстояние:
    // long: price - referencePrice
    // short: referencePrice - price
    const distanceFromRef =
      side === 'long'
        ? price - referencePrice
        : referencePrice - price;

    entryExtensionAtr =
      distanceFromRef / lastAtr;

    maxEntryExtensionAtr =
      regime === 'breakout_watch'
        ? 1.5
        : MAX_ENTRY_EXTENSION_TREND_ATR;

    entryTooExtended =
      entryExtensionAtr > maxEntryExtensionAtr;

    if (entryTooExtended) {
      const direction =
        side === 'long'
          ? 'above'
          : 'below';

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

  // ========== ФИНАЛЬНАЯ ПРОВЕРКА ВХОДА ==========

  if (
    side !== 'none' &&
    stopLossPrice != null
  ) {
    const entryDistanceFromEma20 =
      side === 'long'
        ? price - regimeIndicators.ema20
        : regimeIndicators.ema20 - price;

    const entryDistanceFromEma20Atr =
      lastAtr > 0
        ? entryDistanceFromEma20 / lastAtr
        : 0;

    const canOpen = canOpenTrade({
      symbol,
      side,
      lastRsi,
      lastAtr,
      adx: regimeIndicators.adx,
      bbWidth: regimeIndicators.bbWidth,
      entryDistanceFromEma20,
      entryDistanceFromEma20Atr,
      entryTooExtended,
      now: new Date()
    });

    if (!canOpen) {
      buy = false;
      sell = false;
      side = 'none';
      takeProfitPrice = null;
      stopLossPrice = null;
      positionSize = null;

      skipReason =
        'Entry filters failed ' +
        '(RSI/ADX/ATR/BB/EMA20/trading window)';
    }
  }

  // ========== РАЗМЕР ПОЗИЦИИ ==========

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

  // ========== ВРЕМЯ СИГНАЛА ==========

  const signalTime = lastCandle.time;

  const signalTimeIso = new Date(
    signalTime < 1_000_000_000_000
      ? signalTime * 1000
      : signalTime
  ).toISOString();

  // ========== РАССТОЯНИЕ ОТ EMA20 ДЛЯ ЛОГА ==========

  const entryDistanceFromEma20ForLog =
    side !== 'none'
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
      priceVsEma200:
        regimeIndicators.ema200 > 0
          ? (price - regimeIndicators.ema200) /
            regimeIndicators.ema200
          : null,
      entryDistanceFromEma20:
        entryDistanceFromEma20ForLog,
      entryDistanceFromEma20Atr:
        entryDistanceFromEma20AtrForLog,
      isCandleClosed: false
    }
  };
}
