import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

const LIGHTER_API_URL =
  process.env.LIGHTER_API_URL ??
  'https://mainnet.zklighter.elliot.ai';

const MIN_DAILY_VOLUME = 0;
const MIN_DAILY_TRADES = 0;

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
  market_margin_mode?: number;
  force_reduce_only?: boolean;
  trading_hours?: string;
  hidden?: boolean;
  rfq_enabled?: boolean;
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
  market_flags?: number;
  strategy_index?: number;
  base_asset_id?: number;
  quote_asset_id?: number;
}

interface ApiResponse {
  code: number;
  message?: string;
  order_book_details?: ApiMarket[];
}

function toNumber(
  value: string | number | undefined
): number {
  const result = Number(value);

  return Number.isFinite(result) ? result : 0;
}

function isClearlyNonCrypto(
  market: ApiMarket
): boolean {
  const symbol = market.symbol.toUpperCase();

  /*
   * Crypto markets normally trade 24/7.
   * Non-empty trading_hours is a strong RWA indicator.
   */
  if (
    market.market_config?.trading_hours &&
    market.market_config.trading_hours.trim() !== ''
  ) {
    return true;
  }

  /*
   * RWA and special markets may be forced into
   * reduce-only mode. They should not be selected
   * for new crypto strategy entries.
   */
  if (
    market.market_config?.force_reduce_only === true
  ) {
    return true;
  }

  /*
   * These symbols are obvious non-crypto instruments.
   * This is only a safety fallback for symbols that
   * expose incomplete classification metadata.
   */
  const obviousRwaName =
    symbol.includes('USD') ||
    symbol.includes('OIL') ||
    symbol.includes('GOLD') ||
    symbol.includes('SILVER') ||
    symbol.includes('BRENT') ||
    symbol.includes('WTI') ||
    symbol === 'SPY' ||
    symbol === 'QQQ' ||
    symbol === 'IWM' ||
    symbol === 'US500' ||
    symbol === 'US100' ||
    symbol === 'MSFT' ||
    symbol === 'NVDA' ||
    symbol === 'INTC' ||
    symbol === 'META' ||
    symbol === 'MU' ||
    symbol === 'SNDK' ||
    symbol === 'SAMSUNG' ||
    symbol === 'KIOXIA' ||
    symbol === 'SKHYNIX';

  if (obviousRwaName) {
    return true;
  }

  return false;
}

function isEligibleMarket(
  market: ApiMarket
): boolean {
  if (market.market_type !== 'perp') {
    return false;
  }

  if (market.status !== 'active') {
    return false;
  }

  if (
    market.market_config?.hidden === true
  ) {
    return false;
  }

  if (isClearlyNonCrypto(market)) {
    return false;
  }

  const dailyVolume = toNumber(
    market.daily_quote_token_volume
  );

  const dailyTrades = toNumber(
    market.daily_trades_count
  );

  if (dailyVolume < MIN_DAILY_VOLUME) {
    return false;
  }

  if (dailyTrades < MIN_DAILY_TRADES) {
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
      `Lighter markets HTTP ${response.status}: ${body}`
    );
  }

  let data: ApiResponse;

  try {
    data = JSON.parse(body) as ApiResponse;
  } catch {
    throw new Error(
      `Invalid JSON from Lighter markets API: ${body}`
    );
  }

  if (data.code !== 200) {
    throw new Error(
      `Lighter markets API error ${data.code}: ` +
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

      return b.openInterest - a.openInterest;
    })
    .slice(0, limit);

  console.log(
    `[${new Date().toISOString()}] ` +
      `Lighter markets: total=${allMarkets.length}, ` +
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
