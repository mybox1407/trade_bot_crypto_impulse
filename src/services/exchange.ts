// src/services/exchange.ts
import { LighterWsClient, Candle } from './lighterWs';

const candlesByMarket = new Map<number, Candle[]>();
const clients = new Map<number, LighterWsClient>();

export function startMarketData(
  marketIndex: number,
  timeframe = '15m',
) {
  if (clients.has(marketIndex)) return;

  candlesByMarket.set(marketIndex, []);

  const client = new LighterWsClient(
    marketIndex,
    timeframe,
    candle => {
      const candles = candlesByMarket.get(marketIndex)!;
      const last = candles[candles.length - 1];

      if (last?.time === candle.time) {
        candles[candles.length - 1] = candle;
      } else {
        candles.push(candle);
      }

      if (candles.length > 250) {
        candles.splice(0, candles.length - 250);
      }
    },
  );

  clients.set(marketIndex, client);
  client.connect();
}

export function getCandles(
  marketIndex: number,
  limit = 250,
): Candle[] {
  const candles = candlesByMarket.get(marketIndex) ?? [];
  return candles.slice(-limit);
}

export function getCurrentPrice(marketIndex: number): number | null {
  const candles = candlesByMarket.get(marketIndex) ?? [];
  return candles.at(-1)?.close ?? null;
}

export function stopMarketData(marketIndex: number) {
  clients.get(marketIndex)?.stop();
  clients.delete(marketIndex);
  candlesByMarket.delete(marketIndex);
}
