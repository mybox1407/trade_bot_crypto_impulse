import {
  MARKET_REFRESH_INTERVAL_MS,
  TOP_MARKETS_LIMIT
} from '../config/constants';

import {
  fetchTopLighterMarkets,
  type LighterMarket,
  saveMarketsSnapshot,
  toTradingPair
} from './lighterLiquidity';

import {
  startMarketDataByMarket,
  stopMarketDataByMarketId,
  isMarketDataStarted
} from './exchange';

import {
  getPositions
} from './positionState';

const MARKET_DATA_TIMEFRAME = '15m';

let activeMarkets: LighterMarket[] = [];

let marketRefreshInterval: NodeJS.Timeout | null = null;
let refreshRunning = false;

function hasPositionForPair(pair: string): boolean {
  return getPositions().some(
    position =>
      normalizePair(position.symbol) ===
      normalizePair(pair)
  );
}

export function getActiveTradingPairs(): string[] {
  return activeMarkets.map(toTradingPair);
}

export function getActiveMarkets(): LighterMarket[] {
  return [...activeMarkets];
}

function normalizePair(symbol: string): string {
  const value = symbol.trim().toUpperCase();

  return value.endsWith('/USDT')
    ? value
    : `${value}/USDT`;
}

export function getActiveMarket(
  symbol: string
): LighterMarket | null {
  const normalized = normalizePair(symbol);

  return (
    activeMarkets.find(
      market =>
        normalizePair(market.symbol) === normalized
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
        `Refreshing Lighter top-${TOP_MARKETS_LIMIT} markets...`
    );

    const nextMarkets =
      await fetchTopLighterMarkets(TOP_MARKETS_LIMIT);

    if (nextMarkets.length === 0) {
      throw new Error(
        'Lighter returned zero eligible markets'
      );
    }

    const previousMarkets = activeMarkets;

    const nextPairs = new Set(
      nextMarkets.map(market =>
        normalizePair(toTradingPair(market))
      )
    );

    for (const previousMarket of previousMarkets) {
      const pair = normalizePair(
        toTradingPair(previousMarket)
      );

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

    const startResults = await Promise.allSettled(
      nextMarkets.map(async market => {
        const pair = toTradingPair(market);

        // Запускаем также уже известные пары, если их WS-клиент
        // отсутствует. startMarketDataByMarket сам не создаёт дубль,
        // если клиент для marketId уже работает.
        if (!isMarketDataStarted(market.marketId)) {
          await startMarketDataByMarket(
            market,
            MARKET_DATA_TIMEFRAME
          );

          console.log(
            `[${new Date().toISOString()}] ` +
              `Started market data: ${pair}`
          );
        }
      })
    );

    for (let index = 0; index < startResults.length; index += 1) {
      const result = startResults[index];

      if (result.status === 'rejected') {
        console.error(
          `[${new Date().toISOString()}] ` +
            `Failed to start market data for ` +
            `${toTradingPair(nextMarkets[index])}:`,
          result.reason
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
        volume24h: market.dailyQuoteTokenVolume,
        trades24h: market.dailyTradesCount,
        openInterest: market.openInterest,
        wsStarted: isMarketDataStarted(market.marketId)
      }))
    );
  } finally {
    refreshRunning = false;
  }
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
