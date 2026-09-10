// src/services/fees.ts
import ccxt from 'ccxt';

const exchange = new ccxt.mexc({
  apiKey: process.env.MEXC_API_KEY,
  secret: process.env.MEXC_SECRET_KEY,
});

export type FeeInfo = {
  symbol: string;
  maker: number;
  taker: number;
  isZeroFee: boolean;
};

export async function getTradingFees(symbols: string[]): Promise<FeeInfo[]> {
  await exchange.loadMarkets();

  const feeResults: FeeInfo[] = [];

  for (const symbol of symbols) {
    try {
      const market = exchange.market(symbol);
      
      const fees = await exchange.fetchTradingFees();
      const symbolFees = fees[symbol];

      if (!symbolFees) {
        console.warn(`[${new Date().toISOString()}] ⚠️ No fees found for ${symbol}`);
        continue;
      }

      const maker = symbolFees.maker ?? 0;
      const taker = symbolFees.taker ?? 0;
      const isZeroFee = taker === 0;

      feeResults.push({
        symbol,
        maker,
        taker,
        isZeroFee,
      });

      console.log(
        `[${new Date().toISOString()}] 💰 ${symbol}: maker=${(maker * 100).toFixed(3)}%, taker=${(taker * 100).toFixed(3)}% ${isZeroFee ? '✅' : '❌'}`
      );
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] 💥 Failed to fetch fees for ${symbol}: ${error instanceof Error ? error.message : 'Unknown'}`
      );
    }
  }

  return feeResults;
}

export function filterZeroFeePairs(fees: FeeInfo[]): string[] {
  const zeroFeePairs = fees.filter(f => f.isZeroFee).map(f => f.symbol);

  const usdtPairs = zeroFeePairs.filter(s => s.endsWith('/USDT'));
  const usdcPairs = zeroFeePairs.filter(s => s.endsWith('/USDC'));

  const selectedSymbols = new Set<string>();

  for (const usdtPair of usdtPairs) {
    const baseAsset = usdtPair.split('/')[0];
    const correspondingUsdc = `${baseAsset}/USDC`;

    if (usdcPairs.includes(correspondingUsdc)) {
      selectedSymbols.add(usdtPair);
      console.log(
        `[${new Date().toISOString()}] 🎯 ${baseAsset}: Both ${usdtPair} and ${correspondingUsdc} have 0% fees → selected ${usdtPair}`
      );
    } else {
      selectedSymbols.add(usdtPair);
      console.log(
        `[${new Date().toISOString()}] 🎯 ${baseAsset}: Only ${usdtPair} has 0% fees → selected ${usdtPair}`
      );
    }
  }

  for (const usdcPair of usdcPairs) {
    const baseAsset = usdcPair.split('/')[0];
    const correspondingUsdt = `${baseAsset}/USDT`;

    if (!usdtPairs.includes(correspondingUsdt)) {
      selectedSymbols.add(usdcPair);
      console.log(
        `[${new Date().toISOString()}] 🎯 ${baseAsset}: Only ${usdcPair} has 0% fees → selected ${usdcPair}`
      );
    }
  }

  const result = Array.from(selectedSymbols);
  console.log(
    `[${new Date().toISOString()}] ✅ Final zero-fee pairs: ${result.length} → ${result.join(', ')}`
  );

  return result;
}
