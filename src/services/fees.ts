// src/services/fees.ts
import crypto from 'crypto';

interface TradeFee {
  symbol: string;
  makerFeeRate: number;
  takerFeeRate: number;
}

async function getTradeFeeFromMexc(symbol: string): Promise<TradeFee> {
  const apiKey = process.env.MEXC_API_KEY;
  const apiSecret = process.env.MEXC_SECRET_KEY;

  if (!apiKey || !apiSecret) {
    throw new Error('MEXC API credentials not configured');
  }

  const normalizedSymbol = symbol.replace('/', '').toUpperCase();

  const params = new URLSearchParams({
    symbol: normalizedSymbol,
    timestamp: Date.now().toString(),
    recvWindow: '5000'
  });

  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(params.toString())
    .digest('hex');

  const url = `https://api.mexc.com/api/v3/tradeFee?${params}&signature=${signature}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'X-MEXC-APIKEY': apiKey,
      'Content-Type': 'application/json'
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const data = JSON.parse(text);

  const feeData = Array.isArray(data.data)
    ? data.data[0]
    : data.data ?? data;

  const makerFeeRate = Number(
    feeData?.makerCommission ??
    feeData?.makerFeeRate
  );

  const takerFeeRate = Number(
    feeData?.takerCommission ??
    feeData?.takerFeeRate
  );

  if (
    !Number.isFinite(makerFeeRate) ||
    !Number.isFinite(takerFeeRate)
  ) {
    throw new Error(
      `Invalid fee response for ${normalizedSymbol}: ${JSON.stringify(data)}`
    );
  }

  return {
    symbol: normalizedSymbol,
    makerFeeRate,
    takerFeeRate
  };
}

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
      const tradeFee = await getTradeFeeFromMexc(symbol);

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
