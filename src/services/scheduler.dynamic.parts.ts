import {
  MARKET_REFRESH_INTERVAL_MS,
  TOP_MARKETS_LIMIT
} from '../config/constants';

import {
  fetchTopLighterMarkets,
  LighterMarket,
  saveMarketsSnapshot,
  toTradingPair
} from './lighterLiquidity';

import {
  startMarketDataByMarket,
  stopMarketData
} from './exchange';

import {
  getPositions
} from './positionState';

let activeMarkets: LighterMarket[] = [];

let marketRefreshInterval:
  NodeJS.Timeout | null = null;

function hasPositionForPair(
  pair: string
): boolean {
  return getPositions().some(
    position => position.symbol === pair
  );
}

export function getActiveTradingPairs(): string[] {
  return activeMarkets.map(toTradingPair);
}

export function getActiveMarkets(): LighterMarket[] {
  return [...activeMarkets];
}

export async function refreshTopMarkets(): Promise<void> {
  console.log(
    `[${new Date().toISOString()}] ` +
      `Refreshing Lighter top-${TOP_MARKETS_LIMIT} markets...`
  );

  const nextMarkets =
    await fetchTopLighterMarkets(
      TOP_MARKETS_LIMIT
    );

  if (nextMarkets.length === 0) {
    throw new Error(
      'Lighter returned zero eligible markets'
    );
  }

  const previousMarkets = activeMarkets;

  const previousPairs = new Set(
    previousMarkets.map(toTradingPair)
  );

  const nextPairs = new Set(
    nextMarkets.map(toTradingPair)
  );

  for (const previousMarket of previousMarkets) {
    const pair = toTradingPair(previousMarket);

    if (
      !nextPairs.has(pair) &&
      !hasPositionForPair(pair)
    ) {
      stopMarketData(pair);

      console.log(
        `[${new Date().toISOString()}] ` +
          `Stopped market data: ${pair}`
      );
    }
  }

  for (const nextMarket of nextMarkets) {
    const pair = toTradingPair(nextMarket);

    if (!previousPairs.has(pair)) {
      await startMarketDataByMarket(
        nextMarket,
        '15m'
      );

      console.log(
        `[${new Date().toISOString()}] ` +
          `Started market data: ${pair}`
      );
    }
  }

  activeMarkets = nextMarkets;

  await saveMarketsSnapshot(nextMarkets);

  console.table(
    nextMarkets.map((market, index) => ({
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
}

export function startMarketRefresh(): void {
  if (marketRefreshInterval) {
    return;
  }

  marketRefreshInterval = setInterval(() => {
    void refreshTopMarkets().catch(error => {
      console.error(
        `[${new Date().toISOString()}] ` +
          `Failed to refresh Lighter markets:`,
        error
      );
    });
  }, MARKET_REFRESH_INTERVAL_MS);
}

export function stopMarketRefresh(): void {
  if (!marketRefreshInterval) {
    return;
  }

  clearInterval(marketRefreshInterval);
  marketRefreshInterval = null;
}
