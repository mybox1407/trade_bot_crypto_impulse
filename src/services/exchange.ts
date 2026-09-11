import {
  LighterWsClient,
  Candle,
  MarketPrice
} from './lighterWs';
import {
  getLighterMarket
} from '../config/lighterMarkets';

const candlesByMarket = new Map<number, Candle[]>();
const pricesByMarket = new Map<number, MarketPrice>();
const clients = new Map<number, LighterWsClient>();

export function startMarketData(
  symbol: string,
  timeframe = '15m'
): void {
  const market = getLighterMarket(symbol);

  if (clients.has(market.marketId)) {
    return;
  }

  candlesByMarket.set(market.marketId, []);

  const client = new LighterWsClient(
    market.marketId,
    timeframe,
    candle => {
      const candles =
        candlesByMarket.get(market.marketId) ?? [];

      const last = candles.at(-1);

      if (!last || candle.time > last.time) {
        candles.push(candle);
      } else if (candle.time === last.time) {
        candles[candles.length - 1] = candle;
      }

      candles.sort((a, b) => a.time - b.time);

      if (candles.length > 250) {
        candles.splice(0, candles.length - 250);
      }

      candlesByMarket.set(market.marketId, candles);
    },
    price => {
      pricesByMarket.set(market.marketId, price);
    }
  );

  clients.set(market.marketId, client);
  client.connect();
}

export function getCandles(
  symbol: string,
  _timeframe = '15m',
  limit = 250
): Candle[] {
  const market = getLighterMarket(symbol);
  const candles =
    candlesByMarket.get(market.marketId) ?? [];

  return candles.slice(-limit);
}

export function getCurrentPrice(
  symbol: string
): number | null {
  const market = getLighterMarket(symbol);
  const price = pricesByMarket.get(market.marketId);

  return (
    price?.lastTradePrice ??
    price?.markPrice ??
    price?.midPrice ??
    price?.bestBid ??
    price?.bestAsk ??
    candlesByMarket.get(market.marketId)?.at(-1)?.close ??
    null
  );
}

export function getMarketPrice(
  symbol: string
): MarketPrice | null {
  const market = getLighterMarket(symbol);

  return pricesByMarket.get(market.marketId) ?? null;
}

export function stopMarketData(symbol: string): void {
  const market = getLighterMarket(symbol);

  clients.get(market.marketId)?.stop();

  clients.delete(market.marketId);
  candlesByMarket.delete(market.marketId);
  pricesByMarket.delete(market.marketId);
}
