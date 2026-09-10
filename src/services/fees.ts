// src/services/fees.ts

import {
  MexcAuthenticatedClient
} from './mexcClient';

const mexcClient =
  new MexcAuthenticatedClient();

const MAX_MAKER_FEE_RATE =
  0.00048;

const MAX_TAKER_FEE_RATE =
  0.00064;

export type FeeInfo = {
  symbol: string;
  maker: number;
  taker: number;
  isAllowed: boolean;
  source: 'account_real';
  originalMaker?: number;
  originalTaker?: number;
};

function isUsdtPair(
  symbol: string
): boolean {
  return symbol
    .trim()
    .toUpperCase()
    .endsWith('/USDT');
}

function isAllowedFee(
  maker: number,
  taker: number
): boolean {
  return (
    Number.isFinite(maker) &&
    Number.isFinite(taker) &&
    maker >= 0 &&
    taker >= 0 &&
    maker <= MAX_MAKER_FEE_RATE &&
    taker <= MAX_TAKER_FEE_RATE
  );
}

export async function getTradingFees(
  symbols: string[]
): Promise<FeeInfo[]> {
  const feeResults: FeeInfo[] = [];

  const usdtSymbols =
    symbols.filter(isUsdtPair);

  for (const symbol of usdtSymbols) {
    try {
      const tradeFee =
        await mexcClient.getTradeFee(symbol);

      const maker =
        tradeFee.makerFeeRate;

      const taker =
        tradeFee.takerFeeRate;

      const isAllowed =
        isAllowedFee(maker, taker);

      feeResults.push({
        symbol,
        maker,
        taker,
        isAllowed,
        source: 'account_real',
        originalMaker:
          tradeFee.originalMakerFee,
        originalTaker:
          tradeFee.originalTakerFee
      });

      console.log(
        `[${new Date().toISOString()}] 💰 ` +
        `${symbol}: ` +
        `maker=${(maker * 100).toFixed(3)}%, ` +
        `taker=${(taker * 100).toFixed(3)}% ` +
        `${isAllowed ? '✅ allowed' : '⛔ rejected'}`
      );
    } catch (error) {
      const errorMsg =
        error instanceof Error
          ? error.message
          : 'Unknown';

      console.error(
        `[${new Date().toISOString()}] 💥 ` +
        `Failed to fetch fees for ${symbol}: ` +
        `${errorMsg}`
      );
    }
  }

  return feeResults;
}

export function filterAllowedFeePairs(
  fees: FeeInfo[]
): string[] {
  const selectedSymbols =
    fees
      .filter(fee =>
        fee.source === 'account_real' &&
        fee.isAllowed &&
        isUsdtPair(fee.symbol)
      )
      .map(fee => fee.symbol);

  console.log(
    `[${new Date().toISOString()}] ✅ ` +
    `Final allowed USDT pairs: ` +
    `${selectedSymbols.length} → ` +
    `${selectedSymbols.join(', ')}`
  );

  return selectedSymbols;
}
