// src/services/exchange.ts
import ccxt from 'ccxt';

const exchange = new ccxt.mexc({
  apiKey: process.env.MEXC_API_KEY,
  secret: process.env.MEXC_SECRET_KEY,
  // Если нужно: раскомментируй и настрой под спот/фьючерсы
  // options: { defaultType: 'spot' }
});

export async function getCandles(symbol: string, timeframe = '15m', limit = 250) {
  await exchange.loadMarkets();

  const raw = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);

  return raw.map(c => ({
    time: c[0]!, open: c[1]!, high: c[2]!, low: c[3]!, close: c[4]!, volume: c[5]!
  }));
}

export async function getCurrentPrice(symbol: string) {
  const ticker = await exchange.fetchTicker(symbol);
  return ticker.last ?? ticker.close!;
}
