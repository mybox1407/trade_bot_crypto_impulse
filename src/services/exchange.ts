import {
  LighterWsClient,
  Candle,
  MarketPrice
} from './lighterWs';

import {
  getLighterMarket
} from '../config/lighterMarkets';

const LIGHTER_API_URL =
  process.env.LIGHTER_API_URL ??
  'https://mainnet.zklighter.elliot.ai';

const MAX_CANDLES = 250;

export type MarketReference = {
  symbol: string;
  marketId: number;
};

const candlesByMarket = new Map<number, Candle[]>();
const pricesByMarket = new Map<number, MarketPrice>();
const clients = new Map<number, LighterWsClient>();

const dynamicMarketsBySymbol =
  new Map<string, MarketReference>();

function timeframeToSeconds(
  timeframe: string
): number {
  const match = timeframe.match(
    /^(\d+)([mhd])$/
  );

  if (!match) {
    throw new Error(
      `Unsupported timeframe: ${timeframe}`
    );
  }

  const amount = Number(match[1]);
  const unit = match[2];

  if (unit === 'm') {
    return amount * 60;
  }

  if (unit === 'h') {
    return amount * 60 * 60;
  }

  return amount * 24 * 60 * 60;
}

function normalizeCandle(raw: {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}): Candle {
  return {
    time: Number(raw.t),
    open: Number(raw.o),
    high: Number(raw.h),
    low: Number(raw.l),
    close: Number(raw.c),
    volume: Number(raw.v)
  };
}

function normalizeSymbol(
  symbol: string
): string {
  const value = symbol.trim().toUpperCase();

  return value.endsWith('/USDT')
    ? value
    : `${value}/USDT`;
}

function resolveMarket(
  symbol: string
): MarketReference {
  const normalizedSymbol =
    normalizeSymbol(symbol);

  const dynamicMarket =
    dynamicMarketsBySymbol.get(
      normalizedSymbol
    );

  if (dynamicMarket) {
    return dynamicMarket;
  }

  return getLighterMarket(normalizedSymbol);
}

export function registerDynamicMarket(
  market: MarketReference
): void {
  const pair = normalizeSymbol(market.symbol);

  dynamicMarketsBySymbol.set(pair, {
    symbol: pair,
    marketId: market.marketId
  });
}

export function unregisterDynamicMarket(
  marketId: number
): void {
  for (
    const [symbol, market]
    of dynamicMarketsBySymbol
  ) {
    if (market.marketId === marketId) {
      dynamicMarketsBySymbol.delete(symbol);
    }
  }
}

async function loadHistoricalCandles(
  marketId: number,
  timeframe: string,
  limit: number
): Promise<Candle[]> {
  const now = Math.floor(
    Date.now() / 1000
  );

  const candleSeconds =
    timeframeToSeconds(timeframe);

  const startTimestamp =
    now - limit * candleSeconds;

  const params = new URLSearchParams({
    market_id: String(marketId),
    resolution: timeframe,
    start_timestamp: String(
      startTimestamp
    ),
    end_timestamp: String(now),
    count_back: String(limit)
  });

  const url =
    `${LIGHTER_API_URL}/api/v1/candles?` +
    params.toString();

  console.log(
    `[${new Date().toISOString()}] ` +
      `Loading historical candles: ${url}`
  );

  const response = await fetch(url);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `Lighter candles HTTP ` +
        `${response.status}: ${body}`
    );
  }

  const data = JSON.parse(body) as {
    code: number;
    message?: string;
    r?: string;
    c?: Array<{
      t: number;
      o: number;
      h: number;
      l: number;
      c: number;
      v: number;
    }>;
  };

  if (data.code !== 200) {
    throw new Error(
      `Lighter candles API error ` +
        `${data.code}: ` +
        `${data.message ?? 'unknown error'}`
    );
  }

  return (data.c ?? [])
    .map(normalizeCandle)
    .filter(candle =>
      Number.isFinite(candle.time) &&
      Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close) &&
      Number.isFinite(candle.volume)
    )
    .sort((a, b) =>
      a.time - b.time
    )
    .slice(-limit);
}

function attachClient(
  market: MarketReference,
  timeframe: string,
  historicalCandles: Candle[]
): void {
  const marketId = market.marketId;

  candlesByMarket.set(
    marketId,
    historicalCandles
  );

  const client = new LighterWsClient(
    marketId,
    timeframe,
    candle => {
      const candles =
        candlesByMarket.get(marketId) ?? [];

      const last =
        candles[candles.length - 1];

      if (
        !last ||
        candle.time > last.time
      ) {
        candles.push(candle);
      } else if (
        candle.time === last.time
      ) {
        candles[candles.length - 1] =
          candle;
      }

      candles.sort((a, b) =>
        a.time - b.time
      );

      if (candles.length > MAX_CANDLES) {
        candles.splice(
          0,
          candles.length - MAX_CANDLES
        );
      }

      candlesByMarket.set(
        marketId,
        candles
      );
    },
    price => {
      pricesByMarket.set(
        marketId,
        price
      );
    }
  );

  clients.set(marketId, client);
  client.connect();
}

export async function startMarketData(
  symbol: string,
  timeframe = '15m'
): Promise<void> {
  const market = resolveMarket(symbol);

  if (clients.has(market.marketId)) {
    return;
  }

  const historicalCandles =
    await loadHistoricalCandles(
      market.marketId,
      timeframe,
      MAX_CANDLES
    );

  if (historicalCandles.length === 0) {
    throw new Error(
      `No historical candles received ` +
        `for ${symbol}`
    );
  }

  attachClient(
    market,
    timeframe,
    historicalCandles
  );

  console.log(
    `[${new Date().toISOString()}] ` +
      `Market data started: ${symbol}, ` +
      `marketId=${market.marketId}, ` +
      `candles=${historicalCandles.length}`
  );
}

export async function startMarketDataByMarket(
  market: MarketReference,
  timeframe = '15m'
): Promise<void> {
  registerDynamicMarket(market);

  if (clients.has(market.marketId)) {
    return;
  }

  const historicalCandles =
    await loadHistoricalCandles(
      market.marketId,
      timeframe,
      MAX_CANDLES
    );

  if (historicalCandles.length === 0) {
    throw new Error(
      `No historical candles received ` +
        `for ${market.symbol}`
    );
  }

  attachClient(
    {
      symbol: normalizeSymbol(market.symbol),
      marketId: market.marketId
    },
    timeframe,
    historicalCandles
  );

  console.log(
    `[${new Date().toISOString()}] ` +
      `Market data started: ` +
      `${normalizeSymbol(market.symbol)}, ` +
      `marketId=${market.marketId}, ` +
      `candles=${historicalCandles.length}`
  );
}

export function getCandles(
  symbol: string,
  _timeframe = '15m',
  limit = MAX_CANDLES
): Candle[] {
  const market = resolveMarket(symbol);

  const candles =
    candlesByMarket.get(market.marketId) ?? [];

  return candles.slice(-limit);
}

export function getCurrentPrice(
  symbol: string
): number | null {
  const market = resolveMarket(symbol);

  const price =
    pricesByMarket.get(market.marketId);

  const candles =
    candlesByMarket.get(market.marketId) ?? [];

  const lastCandle =
    candles[candles.length - 1];

  return (
    price?.lastTradePrice ??
    price?.markPrice ??
    price?.midPrice ??
    price?.bestBid ??
    price?.bestAsk ??
    lastCandle?.close ??
    null
  );
}

export function getMarketPrice(
  symbol: string
): MarketPrice | null {
  const market = resolveMarket(symbol);

  return (
    pricesByMarket.get(market.marketId) ??
    null
  );
}

export function stopMarketDataByMarketId(
  marketId: number
): void {
  clients.get(marketId)?.stop();

  clients.delete(marketId);
  candlesByMarket.delete(marketId);
  pricesByMarket.delete(marketId);

  unregisterDynamicMarket(marketId);
}

export function stopMarketData(
  symbol: string
): void {
  const market = resolveMarket(symbol);

  stopMarketDataByMarketId(
    market.marketId
  );
}

export { resolveMarket };
