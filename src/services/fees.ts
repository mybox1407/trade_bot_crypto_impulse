// src/services/fees.ts
import { MexcAuthenticatedClient } from './mexcClient';

const mexcClient = new MexcAuthenticatedClient();

export type FeeInfo = {
  symbol: string;
  maker: number;
  taker: number;
  isZeroFee: boolean;
};

export async function getTradingFees(symbols: string[]): Promise<FeeInfo[]> {
  const feeResults: FeeInfo[] = [];

  for (const symbol of symbols) {
    try {
      const tradeFee = await mexcClient.getTradeFee(symbol);
      
      const maker = tradeFee.makerFeeRate;
      const taker = tradeFee.takerFeeRate;
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
      const errorMsg = error instanceof Error ? error.message : 'Unknown';
      console.error(
        `[${new Date().toISOString()}] 💥 Failed to fetch fees for ${symbol}: ${errorMsg}`
      );
      
      feeResults.push({
        symbol,
        maker: 0,
        taker: 0,
        isZeroFee: false,
      });
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
