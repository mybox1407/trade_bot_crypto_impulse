import {
  startMarketData,
  getCandles,
  getCurrentPrice,
  getMarketPrice
} from './src/services/exchange';

startMarketData('ETH/USDT', '15m');

const timer = setInterval(() => {
  const candles = getCandles('ETH/USDT', '15m', 10);
  const price = getCurrentPrice('ETH/USDT');
  const marketPrice = getMarketPrice('ETH/USDT');

  console.log({
    candlesCount: candles.length,
    lastCandle: candles.at(-1),
    price,
    marketPrice
  });
}, 5_000);

setTimeout(() => {
  clearInterval(timer);
  process.exit(0);
}, 30_000);
