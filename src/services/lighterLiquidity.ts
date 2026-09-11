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

interface ApiMarketConfig {
  force_reduce_only?: boolean;
  trading_hours?: string;
  hidden?: boolean;
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
  market_config?: ApiMarketConfig;
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
  'BRENT',
  'BRENTOIL',
  'SKHYNIXUSD',
  'SNDK',
  'MSFT',
  'NVDA',
  'MU',
  'QQQ',
  'SPY',
  'USELESS',
  'STRC',
  'AAPL',
  'HOOD',
  'ORCL'
]);

function toNumber(
  value: string | number | undefined
): number {
  const result = Number(value);

  return Number.isFinite(result)
    ? result
    : 0;
}

function isEligibleMarket(
  market: ApiMarket
): boolean {
  if (
    market.market_type !== 'perp' ||
    market.status !== 'active'
  ) {
    return false;
  }

  if (
    market.market_config?.hidden === true
  ) {
    return false;
  }

  if (
    market.market_config?.force_reduce_only === true
  ) {
    return false;
  }

  if (
    market.market_config?.trading_hours &&
    market.market_config.trading_hours.trim() !== ''
  ) {
    return false;
  }

  if (
    NON_CRYPTO_SYMBOLS.has(
      market.symbol.toUpperCase()
    )
  ) {
    return false;
  }

  return true;
}

export function toTradingPair(
  market: LighterMarket
): string {
  return `${market.symbol}/USDT`;
}

export async function fetchTopLighterMarkets(
  limit: number
): Promise<LighterMarket[]> {
  if (
    !Number.isInteger(limit) ||
    limit <= 0
  ) {
    throw new Error(
      `Invalid markets limit: ${limit}`
    );
  }

  const response = await fetch(
    `${LIGHTER_API_URL}/api/v1/orderBookDetails`
  );

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `Lighter markets HTTP ` +
        `${response.status}: ${body}`
    );
  }

  const data = JSON.parse(body) as ApiResponse;

  if (data.code !== 200) {
    throw new Error(
      `Lighter markets API error ` +
        `${data.code}: ` +
        `${data.message ?? 'unknown error'}`
    );
  }

  const allMarkets =
    data.order_book_details ?? [];

  const eligibleMarkets =
    allMarkets.filter(isEligibleMarket);

  const markets = eligibleMarkets
    .map(market => ({
      symbol: market.symbol,
      marketId: market.market_id,
      priceDecimals: market.price_decimals,
      sizeDecimals: market.size_decimals,
      minBaseAmount: toNumber(
        market.min_base_amount
      ),
      minQuoteAmount: toNumber(
        market.min_quote_amount
      ),
      dailyQuoteTokenVolume: toNumber(
        market.daily_quote_token_volume
      ),
      dailyTradesCount: toNumber(
        market.daily_trades_count
      ),
      openInterest: toNumber(
        market.open_interest
      )
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

      if (
        b.dailyTradesCount !==
        a.dailyTradesCount
      ) {
        return (
          b.dailyTradesCount -
          a.dailyTradesCount
        );
      }

      return (
        b.openInterest -
        a.openInterest
      );
    })
    .slice(0, limit);

  console.log(
    `[${new Date().toISOString()}] ` +
      `Lighter markets: ` +
      `total=${allMarkets.length}, ` +
      `eligible=${eligibleMarkets.length}, ` +
      `selected=${markets.length}`
  );

  console.table(
    markets.map((market, index) => ({
      rank: index + 1,
      symbol: market.symbol,
      marketId: market.marketId,
      volume24h:
        market.dailyQuoteTokenVolume,
      trades24h:
        market.dailyTradesCount,
      openInterest:
        market.openInterest
    }))
  );

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
