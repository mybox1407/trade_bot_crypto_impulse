import {
  startMarketData,
  getCandles,
  getCurrentPrice,
  getMarketPrice
} from './src/services/exchange';

async function main() {
  await startMarketData('ETH/USDT', '15m');

  const timer = setInterval(() => {
    const candles = getCandles(
      'ETH/USDT',
      '15m',
      250
    );

    const price = getCurrentPrice('ETH/USDT');
    const marketPrice = getMarketPrice('ETH/USDT');

    console.log({
      candlesCount: candles.length,
      firstCandle: candles[0],
      lastCandle: candles.at(-1),
      price,
      marketPrice
    });
  }, 5_000);

  setTimeout(() => {
    clearInterval(timer);
    process.exit(0);
  }, 30_000);
}

main().catch(error => {
  console.error(
    error instanceof Error ? error.message : error
  );

  process.exit(1);
});
