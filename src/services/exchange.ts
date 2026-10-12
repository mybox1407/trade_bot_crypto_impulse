import {
  LighterWsClient,
  type Candle,
  type LighterTrade,
  type MarketPrice
} from './lighterWs';

import {
  getLighterMarket
} from '../config/lighterMarkets';

import {
  TradeFlowBaselineTracker,
  type TradeFlowBaseline
} from './strategy';

const LIGHTER_API_URL =
  process.env.LIGHTER_API_URL ??
  'https://mainnet.zklighter.elliot.ai';

const MAX_CANDLES = 250;
const MAX_TRADES = 5_000;
const TRADE_ID_CACHE_SIZE = 20_000;

export type MarketReference = {
  symbol: string;
  marketId: number;
};

type MarketClient = {
  client: LighterWsClient;
  timeframe: string;
};

export type TradeListener = (
  symbol: string,
  trade: LighterTrade
) => void | Promise<void>;

const candlesByMarket =
  new Map<number, Candle[]>();

const pricesByMarket =
  new Map<number, MarketPrice>();

const tradesByMarket =
  new Map<number, LighterTrade[]>();

const baselineTrackersByMarket =
  new Map<number, TradeFlowBaselineTracker>();

const clients =
  new Map<number, MarketClient>();

const dynamicMarketsBySymbol =
  new Map<string, MarketReference>();

const startingMarkets =
  new Set<number>();

const tradeListeners =
  new Set<TradeListener>();

const seenTradeIdsByMarket =
  new Map<number, Set<string>>();

export function subscribeToTrades(
  listener: TradeListener
): () => void {
  tradeListeners.add(listener);

  return () => {
    tradeListeners.delete(listener);
  };
}

function normalizeCandleTime(
  value: number
): number {
  if (!Number.isFinite(value)) {
    return value;
  }

  return value > 10_000_000_000
    ? Math.floor(value / 1000)
    : Math.floor(value);
}

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
    time: normalizeCandleTime(Number(raw.t)),
    open: Number(raw.o),
    high: Number(raw.h),
    low: Number(raw.l),
    close: Number(raw.c),
    volume: Number(raw.v)
  };
}

export function normalizeSymbol(
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
    dynamicMarketsBySymbol.get(normalizedSymbol);

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
  for (const [symbol, market] of dynamicMarketsBySymbol) {
    if (market.marketId === marketId) {
      dynamicMarketsBySymbol.delete(symbol);
    }
  }
}

function rememberTradeId(
  marketId: number,
  tradeId: string
): boolean {
  let ids = seenTradeIdsByMarket.get(marketId);

  if (!ids) {
    ids = new Set<string>();
    seenTradeIdsByMarket.set(marketId, ids);
  }

  if (ids.has(tradeId)) {
    return false;
  }

  ids.add(tradeId);

  if (ids.size > TRADE_ID_CACHE_SIZE) {
    const oldestId = ids.values().next().value;

    if (oldestId !== undefined) {
      ids.delete(oldestId);
    }
  }

  return true;
}

function publishTrade(
  market: MarketReference,
  trade: LighterTrade
): void {
  if (!trade.tradeId) {
    console.error(
      `[${new Date().toISOString()}] ` +
        `Ignoring Lighter trade without tradeId`,
      trade
    );
    return;
  }

  if (!rememberTradeId(market.marketId, trade.tradeId)) {
    return;
  }

  const trades =
    tradesByMarket.get(market.marketId) ?? [];

  trades.push(trade);

  if (trades.length > MAX_TRADES) {
    trades.splice(0, trades.length - MAX_TRADES);
  }

  tradesByMarket.set(market.marketId, trades);

  let baselineTracker =
    baselineTrackersByMarket.get(market.marketId);

  if (!baselineTracker) {
    baselineTracker = new TradeFlowBaselineTracker();
    baselineTrackersByMarket.set(
      market.marketId,
      baselineTracker
    );
  }

  baselineTracker.addTrade(trade);

  const symbol = normalizeSymbol(market.symbol);

  for (const listener of tradeListeners) {
    try {
      void Promise.resolve(
        listener(symbol, trade)
      ).catch(error => {
        console.error(
          `[${new Date().toISOString()}] ` +
            `Trade listener failed for ${symbol}:`,
          error
        );
      });
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ` +
          `Trade listener failed for ${symbol}:`,
        error
      );
    }
  }
}

export function getTradeFlowBaseline(
  symbol: string,
  now = Date.now()
): TradeFlowBaseline {
  const market = resolveMarket(symbol);
  const tracker =
    baselineTrackersByMarket.get(market.marketId);

  if (!tracker) {
    return {
      ready: false,
      nonEmptyBuckets: 0,
      volumePerWindow: null,
      reason: 'Trade-flow baseline tracker is not initialized'
    };
  }

  return tracker.getBaseline(now);
}

export function getTradeFlowBaselineTracker(
  symbol: string
): TradeFlowBaselineTracker {
  const market = resolveMarket(symbol);

  let tracker =
    baselineTrackersByMarket.get(market.marketId);

  if (!tracker) {
    tracker = new TradeFlowBaselineTracker();
    baselineTrackersByMarket.set(market.marketId, tracker);
  }

  return tracker;
}

async function loadHistoricalCandles(
  marketId: number,
  timeframe: string,
  limit: number
): Promise<Candle[]> {
  const now = Math.floor(Date.now() / 1000);
  const candleSeconds = timeframeToSeconds(timeframe);
  const startTimestamp = now - limit * candleSeconds;

  const params = new URLSearchParams({
    market_id: String(marketId),
    resolution: timeframe,
    start_timestamp: String(startTimestamp),
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
      `Lighter candles HTTP ${response.status}: ${body}`
    );
  }

  let data: {
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

  try {
    data = JSON.parse(body) as typeof data;
  } catch {
    throw new Error(
      `Invalid JSON from Lighter candles endpoint: ` +
        `${body.slice(0, 300)}`
    );
  }

  if (data.code !== 200) {
    throw new Error(
      `Lighter candles API error ${data.code}: ` +
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
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

function attachClient(
  market: MarketReference,
  timeframe: string,
  historicalCandles: Candle[]
): void {
  const marketId = market.marketId;

  candlesByMarket.set(marketId, historicalCandles);

  if (!tradesByMarket.has(marketId)) {
    tradesByMarket.set(marketId, []);
  }

  if (!baselineTrackersByMarket.has(marketId)) {
    baselineTrackersByMarket.set(
      marketId,
      new TradeFlowBaselineTracker()
    );
  }

  const client = new LighterWsClient(
    marketId,
    timeframe,
    candle => {
      const candles =
        candlesByMarket.get(marketId) ?? [];

      const normalizedCandle: Candle = {
        ...candle,
        time: normalizeCandleTime(candle.time)
      };

      const last = candles[candles.length - 1];

      if (!last || normalizedCandle.time > last.time) {
        candles.push(normalizedCandle);
      } else if (normalizedCandle.time === last.time) {
        candles[candles.length - 1] = normalizedCandle;
      }

      candles.sort((a, b) => a.time - b.time);

      if (candles.length > MAX_CANDLES) {
        candles.splice(0, candles.length - MAX_CANDLES);
      }

      candlesByMarket.set(marketId, candles);
    },
    price => {
      pricesByMarket.set(marketId, price);
    },
    trade => {
      publishTrade(market, trade);
    }
  );

  clients.set(marketId, {
    client,
    timeframe
  });

  client.connect();
}

async function startResolvedMarket(
  market: MarketReference,
  timeframe: string
): Promise<void> {
  const marketId = market.marketId;

  if (clients.has(marketId)) {
    const existing = clients.get(marketId)!;

    if (existing.timeframe !== timeframe) {
      console.warn(
        `[${new Date().toISOString()}] ` +
          `Market ${market.symbol} already started with timeframe ` +
          `${existing.timeframe}, ignoring request for ${timeframe}`
      );
    }

    return;
  }

  if (startingMarkets.has(marketId)) {
    console.log(
      `[${new Date().toISOString()}] ` +
        `Market ${market.symbol} is already starting, ` +
        `skipping duplicate request`
    );

    return;
  }

  startingMarkets.add(marketId);

  try {
    const historicalCandles =
      await loadHistoricalCandles(
        marketId,
        timeframe,
        MAX_CANDLES
      );

    if (historicalCandles.length === 0) {
      throw new Error(
        `No historical candles received for ${market.symbol}`
      );
    }

    attachClient(
      market,
      timeframe,
      historicalCandles
    );

    console.log(
      `[${new Date().toISOString()}] ` +
        `Market data started: ${normalizeSymbol(market.symbol)}, ` +
        `marketId=${marketId}, timeframe=${timeframe}, ` +
        `candles=${historicalCandles.length}`
    );
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] ` +
        `Failed to start market data for ${market.symbol}:`,
      error instanceof Error
        ? error.message
        : 'Unknown error'
    );

    throw error;
  } finally {
    startingMarkets.delete(marketId);
  }
}

export async function startMarketData(
  symbol: string,
  timeframe = '15m'
): Promise<void> {
  await startResolvedMarket(
    resolveMarket(symbol),
    timeframe
  );
}

export async function startMarketDataByMarket(
  market: MarketReference,
  timeframe = '15m'
): Promise<void> {
  const normalizedMarket = {
    symbol: normalizeSymbol(market.symbol),
    marketId: market.marketId
  };

  registerDynamicMarket(normalizedMarket);

  await startResolvedMarket(
    normalizedMarket,
    timeframe
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

export function getTrades(
  symbol: string,
  limit = MAX_TRADES
): LighterTrade[] {
  const market = resolveMarket(symbol);
  const trades =
    tradesByMarket.get(market.marketId) ?? [];

  return trades.slice(-limit);
}

export function getMarketTimeframe(
  symbol: string
): string | null {
  const market = resolveMarket(symbol);

  return clients.get(market.marketId)?.timeframe ?? null;
}

export function isMarketDataStarted(
  marketId: number
): boolean {
  return clients.has(marketId);
}

export function getMarkPrice(
  symbol: string
): number | null {
  const market = resolveMarket(symbol);
  const price =
    pricesByMarket.get(market.marketId);

  return (
    price?.markPrice ??
    price?.midPrice ??
    price?.lastTradePrice ??
    null
  );
}

export function getExitPrice(
  symbol: string,
  side: 'long' | 'short'
): number | null {
  const market = resolveMarket(symbol);
  const price =
    pricesByMarket.get(market.marketId);

  if (side === 'long') {
    return (
      price?.bestBid ??
      price?.markPrice ??
      price?.midPrice ??
      price?.lastTradePrice ??
      price?.bestAsk ??
      null
    );
  }

  return (
    price?.bestAsk ??
    price?.markPrice ??
    price?.midPrice ??
    price?.lastTradePrice ??
    price?.bestBid ??
    null
  );
}

export function getCurrentPrice(
  symbol: string
): number | null {
  return getMarkPrice(symbol);
}

export function getMarketPrice(
  symbol: string
): MarketPrice | null {
  const market = resolveMarket(symbol);

  return (
    pricesByMarket.get(market.marketId) ?? null
  );
}

export function stopMarketDataByMarketId(
  marketId: number
): void {
  clients.get(marketId)?.client.stop();

  clients.delete(marketId);
  candlesByMarket.delete(marketId);
  pricesByMarket.delete(marketId);
  tradesByMarket.delete(marketId);
  baselineTrackersByMarket.delete(marketId);
  seenTradeIdsByMarket.delete(marketId);

  unregisterDynamicMarket(marketId);
}

export function stopMarketData(
  symbol: string
): void {
  const market = resolveMarket(symbol);

  stopMarketDataByMarketId(market.marketId);
}

export { resolveMarket };
