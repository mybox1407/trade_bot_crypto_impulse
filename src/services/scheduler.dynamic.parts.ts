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
  stopMarketDataByMarketId
} from './exchange';

import {
  getPositions
} from './positionState';

let activeMarkets: LighterMarket[] = [];

let marketRefreshInterval:
  NodeJS.Timeout | null = null;

let refreshRunning = false;

function hasPositionForPair(
  pair: string
): boolean {
  return getPositions().some(
    position =>
      position.symbol === pair
  );
}

export function getActiveTradingPairs(): string[] {
  return activeMarkets.map(toTradingPair);
}

export function getActiveMarkets(): LighterMarket[] {
  return [...activeMarkets];
}

function normalizePair(
  symbol: string
): string {
  const value =
    symbol.trim().toUpperCase();

  return value.endsWith('/USDT')
    ? value
    : `${value}/USDT`;
}

export function getActiveMarket(
  symbol: string
): LighterMarket | null {
  const normalized =
    normalizePair(symbol);

  return (
    activeMarkets.find(
      market =>
        normalizePair(market.symbol) ===
        normalized
    ) ?? null
  );
}

export async function refreshTopMarkets(): Promise<void> {
  if (refreshRunning) {
    console.warn(
      `[${new Date().toISOString()}] ` +
        `Market refresh already running, skipping`
    );

    return;
  }

  refreshRunning = true;

  try {
    console.log(
      `[${new Date().toISOString()}] ` +
        `Refreshing Lighter top-` +
        `${TOP_MARKETS_LIMIT} markets...`
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

    const previousMarkets =
      activeMarkets;

    const previousPairs = new Set(
      previousMarkets.map(toTradingPair)
    );

    const nextPairs = new Set(
      nextMarkets.map(toTradingPair)
    );

    for (
      const previousMarket
      of previousMarkets
    ) {
      const pair =
        toTradingPair(previousMarket);

      if (
        !nextPairs.has(pair) &&
        !hasPositionForPair(pair)
      ) {
        stopMarketDataByMarketId(
          previousMarket.marketId
        );

        console.log(
          `[${new Date().toISOString()}] ` +
            `Stopped market data: ${pair}`
        );
      }
    }

    const startPromises: Promise<void>[] = [];

    for (
      const nextMarket
      of nextMarkets
    ) {
      const pair =
        toTradingPair(nextMarket);

      if (!previousPairs.has(pair)) {
        const startPromise =
          startMarketDataByMarket(
            nextMarket,
            '15m'
          )
            .then(() => {
              console.log(
                `[${new Date().toISOString()}] ` +
                  `Started market data: ${pair}`
              );
            })
            .catch(error => {
              console.error(
                `[${new Date().toISOString()}] ` +
                  `Failed to start market data ` +
                  `for ${pair}:`,
                error
              );
            });

        startPromises.push(
          startPromise
        );
      }
    }

    await Promise.all(
      startPromises
    );

    activeMarkets = nextMarkets;

    await saveMarketsSnapshot(
      nextMarkets
    );

    console.table(
      nextMarkets.map(
        (market, index) => ({
          rank: index + 1,
          symbol: market.symbol,
          marketId: market.marketId,
          volume24h:
            market.dailyQuoteTokenVolume,
          trades24h:
            market.dailyTradesCount,
          openInterest:
            market.openInterest
        })
      )
    );
  } finally {
    refreshRunning = false;
  }
}

export function startMarketRefresh(): void {
  if (marketRefreshInterval) {
    return;
  }

  marketRefreshInterval =
    setInterval(() => {
      void refreshTopMarkets().catch(
        error => {
          console.error(
            `[${new Date().toISOString()}] ` +
              `Failed to refresh Lighter markets:`,
            error
          );
        }
      );
    }, MARKET_REFRESH_INTERVAL_MS);
}

export function stopMarketRefresh(): void {
  if (!marketRefreshInterval) {
    return;
  }

  clearInterval(
    marketRefreshInterval
  );

  marketRefreshInterval = null;
}
