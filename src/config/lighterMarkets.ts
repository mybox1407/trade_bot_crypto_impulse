export interface LighterMarket {
  symbol: string;
  marketId: number;
  priceDecimals: number;
  sizeDecimals: number;
  minBaseAmount: number;
  minQuoteAmount: number;
}

export const LIGHTER_MARKETS: Record<string, LighterMarket> = {
  'SOL/USDT': {
    symbol: 'SOL',
    marketId: 2,
    priceDecimals: 3,
    sizeDecimals: 3,
    minBaseAmount: 0.1,
    minQuoteAmount: 10
  },

  'AVAX/USDT': {
    symbol: 'AVAX',
    marketId: 9,
    priceDecimals: 4,
    sizeDecimals: 2,
    minBaseAmount: 1,
    minQuoteAmount: 10
  },

  'ADA/USDT': {
    symbol: 'ADA',
    marketId: 39,
    priceDecimals: 5,
    sizeDecimals: 1,
    minBaseAmount: 45,
    minQuoteAmount: 10
  },

  'LINK/USDT': {
    symbol: 'LINK',
    marketId: 8,
    priceDecimals: 5,
    sizeDecimals: 1,
    minBaseAmount: 1,
    minQuoteAmount: 10
  },

  'ETH/USDT': {
    symbol: 'ETH',
    marketId: 0,
    priceDecimals: 2,
    sizeDecimals: 4,
    minBaseAmount: 0.005,
    minQuoteAmount: 10
  },

  'DOT/USDT': {
    symbol: 'DOT',
    marketId: 11,
    priceDecimals: 5,
    sizeDecimals: 1,
    minBaseAmount: 9.5,
    minQuoteAmount: 10
  },

  'BTC/USDT': {
    symbol: 'BTC',
    marketId: 1,
    priceDecimals: 1,
    sizeDecimals: 5,
    minBaseAmount: 0.0001,
    minQuoteAmount: 10
  },

  'XRP/USDT': {
    symbol: 'XRP',
    marketId: 7,
    priceDecimals: 6,
    sizeDecimals: 0,
    minBaseAmount: 7,
    minQuoteAmount: 10
  },

  'UNI/USDT': {
    symbol: 'UNI',
    marketId: 30,
    priceDecimals: 4,
    sizeDecimals: 2,
    minBaseAmount: 2,
    minQuoteAmount: 10
  },

  'SUI/USDT': {
    symbol: 'SUI',
    marketId: 16,
    priceDecimals: 5,
    sizeDecimals: 1,
    minBaseAmount: 10,
    minQuoteAmount: 10
  },

  'NEAR/USDT': {
    symbol: 'NEAR',
    marketId: 10,
    priceDecimals: 5,
    sizeDecimals: 1,
    minBaseAmount: 4,
    minQuoteAmount: 10
  },

  'DOGE/USDT': {
    symbol: 'DOGE',
    marketId: 3,
    priceDecimals: 6,
    sizeDecimals: 0,
    minBaseAmount: 100,
    minQuoteAmount: 10
  },

  'TRX/USDT': {
    symbol: 'TRX',
    marketId: 43,
    priceDecimals: 5,
    sizeDecimals: 1,
    minBaseAmount: 25,
    minQuoteAmount: 10
  },

  'ASTER/USDT': {
    symbol: 'ASTER',
    marketId: 83,
    priceDecimals: 5,
    sizeDecimals: 1,
    minBaseAmount: 10,
    minQuoteAmount: 10
  },

  'AAVE/USDT': {
    symbol: 'AAVE',
    marketId: 27,
    priceDecimals: 3,
    sizeDecimals: 3,
    minBaseAmount: 0.08,
    minQuoteAmount: 10
  },

  'ONDO/USDT': {
    symbol: 'ONDO',
    marketId: 38,
    priceDecimals: 5,
    sizeDecimals: 1,
    minBaseAmount: 20,
    minQuoteAmount: 10
  },

  'ICP/USDT': {
    symbol: 'ICP',
    marketId: 102,
    priceDecimals: 4,
    sizeDecimals: 2,
    minBaseAmount: 3.5,
    minQuoteAmount: 10
  },

  'WLD/USDT': {
    symbol: 'WLD',
    marketId: 6,
    priceDecimals: 5,
    sizeDecimals: 1,
    minBaseAmount: 20,
    minQuoteAmount: 10
  },

  'ARB/USDT': {
    symbol: 'ARB',
    marketId: 50,
    priceDecimals: 5,
    sizeDecimals: 1,
    minBaseAmount: 90,
    minQuoteAmount: 10
  },

  'PENGU/USDT': {
    symbol: 'PENGU',
    marketId: 47,
    priceDecimals: 6,
    sizeDecimals: 0,
    minBaseAmount: 1000,
    minQuoteAmount: 10
  },

  'VIRTUAL/USDT': {
    symbol: 'VIRTUAL',
    marketId: 41,
    priceDecimals: 5,
    sizeDecimals: 1,
    minBaseAmount: 15,
    minQuoteAmount: 10
  }
};

export function getLighterMarket(
  symbol: string
): LighterMarket {
  const market = LIGHTER_MARKETS[symbol];

  if (!market) {
    throw new Error(
      `Lighter market is not configured: ${symbol}`
    );
  }

  return market;
}
