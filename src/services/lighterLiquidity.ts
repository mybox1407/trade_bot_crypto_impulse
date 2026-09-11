import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

const LIGHTER_API_URL =
  process.env.LIGHTER_API_URL ??
  'https://mainnet.zklighter.elliot.ai';

export interface LighterMarket {
  symbol: string;
  marketId: number;
  priceDecimals: number;
  sizeDecimals: number;
  minBaseAmount: number;
  minQuoteAmount: number;
  dailyQuoteTokenVolume: number;
  dailyTradesCount: number;
  openInterest: number;
}

interface ApiMarket {
  symbol: string;
  market_id: number;
  market_type: string;
  status: string;
  price_decimals: number;
  size_decimals: number;
  min_base_amount: string | number;
  min_quote_amount: string | number;
  daily_quote_token_volume: string | number;
  daily_trades_count: string | number;
  open_interest: string | number;
}

interface ApiResponse {
  code: number;
  message?: string;
  order_book_details?: ApiMarket[];
}

const NON_CRYPTO_SYMBOLS = new Set([
  'SAMSUNG',
  'KIOXIA',
  'CTR',
  'WTI',
  'AXS',
  'INTC',
  'SPCX',
  'PONS',
  'URA',
  'IWM',
  'ROBO',
  'MINIMAX',
  'CASHCAT',
  'META',
  'BOT',
  'BB',
  'KRCOMP',
  'EURUSD',
  'GBPUSD',
  'NZDUSD',
  'US500',
  'US100',
  'XAU',
  'XAG',
  'BRENT'
]);

function toNumber(value: string | number): number {
  const result = Number(value);

  return Number.isFinite(result) ? result : 0;
}

export function toTradingPair(
  market: LighterMarket
): string {
  return `${market.symbol}/USDT`;
}

export async function fetchTopLighterMarkets(
  limit: number
): Promise<LighterMarket[]> {
  const response = await fetch(
    `${LIGHTER_API_URL}/api/v1/orderBookDetails`
  );

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `Lighter markets HTTP ${response.status}: ${body}`
    );
  }

  const data = JSON.parse(body) as ApiResponse;

  if (data.code !== 200) {
    throw new Error(
      `Lighter markets API error ${data.code}: ` +
        `${data.message ?? 'unknown error'}`
    );
  }

  const markets = (data.order_book_details ?? [])
    .filter(market =>
      market.market_type === 'perp' &&
      market.status === 'active' &&
      !NON_CRYPTO_SYMBOLS.has(market.symbol)
    )
    .map(market => ({
      symbol: market.symbol,
      marketId: market.market_id,
      priceDecimals: market.price_decimals,
      sizeDecimals: market.size_decimals,
      minBaseAmount: toNumber(market.min_base_amount),
      minQuoteAmount: toNumber(market.min_quote_amount),
      dailyQuoteTokenVolume: toNumber(
        market.daily_quote_token_volume
      ),
      dailyTradesCount: toNumber(
        market.daily_trades_count
      ),
      openInterest: toNumber(market.open_interest)
    }))
    .sort((a, b) => {
      if (
        b.dailyQuoteTokenVolume !==
        a.dailyQuoteTokenVolume
      ) {
        return (
          b.dailyQuoteTokenVolume -
          a.dailyQuoteTokenVolume
        );
      }

      return b.dailyTradesCount - a.dailyTradesCount;
    })
    .slice(0, limit);

  return markets;
}

export async function saveMarketsSnapshot(
  markets: LighterMarket[]
): Promise<void> {
  mkdirSync('runtime', { recursive: true });

  const snapshot = {
    updatedAt: new Date().toISOString(),
    markets
  };

  await writeFile(
    'runtime/lighter-top-markets.json',
    JSON.stringify(snapshot, null, 2),
    'utf8'
  );
}
