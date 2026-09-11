import {
  SignerClient
} from 'zklighter-sdk';

import {
  getPositions,
  openPosition,
  closePosition,
  hasOpenPosition,
  getPosition,
  getBalance,
  getReservedCapital,
  getAvailableBalance
} from './positionState';

import {
  logError,
  logPositionOpen,
  logPositionClose
} from './logger';

import {
  notifyError
} from './telegram';

import {
  normalizeSymbol
} from './exchange';

const LIGHTER_API_URL =
  process.env.LIGHTER_API_URL ??
  'https://mainnet.zklighter.elliot.ai';

type LighterPosition = {
  symbol: string;
  marketId: number;
  side: 'long' | 'short';
  quantity: number;
  entryPrice: number;
  unrealizedPnL?: number;
};

type ReconciliationResult = {
  ok: boolean;
  localPositions: ReturnType<typeof getPositions>;
  remotePositions: LighterPosition[];
  mismatches: Array<{
    symbol: string;
    local?: ReturnType<typeof getPositions>[number];
    remote?: LighterPosition;
    reason:
      | 'missing_remote'
      | 'missing_local'
      | 'quantity_mismatch'
      | 'side_mismatch'
      | 'price_mismatch';
  }>;
  error?: string;
};

function toNumber(
  value: unknown
): number | null {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

export async function fetchAccountPositions(
  signerClient: SignerClient,
  accountIndex: number
): Promise<LighterPosition[]> {
  try {
    const [
      accountData,
      error
    ] = await signerClient.get_account(
      accountIndex
    );

    if (error || !accountData) {
      throw new Error(
        `Failed to fetch account positions: ` +
        `${error ?? 'unknown error'}`
      );
    }

    const positions: LighterPosition[] = [];

    const account = accountData as Record<string, unknown>;
    const positionsRaw =
      account.positions as Array<Record<string, unknown>> | undefined;

    if (!Array.isArray(positionsRaw)) {
      return [];
    }

    for (const pos of positionsRaw) {
      const marketId = toNumber(pos.market_index);
      const size = toNumber(pos.size);
      const sideValue = pos.side as string | undefined;
      const entryPrice = toNumber(pos.entry_price);

      if (
        marketId == null ||
        size == null ||
        size <= 0 ||
        entryPrice == null ||
        entryPrice <= 0
      ) {
        continue;
      }

      const side: 'long' | 'short' | undefined =
        sideValue === 'long'
          ? 'long'
          : sideValue === 'short'
            ? 'short'
            : undefined;

      if (side == null) {
        continue;
      }

      const symbol =
        (pos.symbol as string | undefined) ??
        `MARKET_${marketId}`;

      positions.push({
        symbol: normalizeSymbol(symbol),
        marketId,
        side,
        quantity: size,
        entryPrice
      });
    }

    return positions;
  } catch (error) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : 'Unknown error';

    throw new Error(
      `Reconciliation: failed to fetch account positions: ${errorMsg}`
    );
  }
}

export async function reconcileAccount(
  signerClient: SignerClient,
  accountIndex: number,
  options?: {
    autoFix?: boolean;
    dryRun?: boolean;
  }
): Promise<ReconciliationResult> {
  const autoFix = options?.autoFix ?? false;
  const dryRun = options?.dryRun ?? false;

  const localPositions = getPositions();

  let remotePositions: LighterPosition[] = [];
  let remoteError: string | undefined;

  try {
    remotePositions =
      await fetchAccountPositions(
        signerClient,
        accountIndex
      );
  } catch (error) {
    remoteError =
      error instanceof Error
        ? error.message
        : 'Unknown error';

    logError({
      timestamp: new Date().toISOString(),
      context: 'reconciliation',
      error: remoteError
    });

    notifyError({
      context: 'reconciliation',
      error: remoteError
    });
  }

  const mismatches: ReconciliationResult['mismatches'] = [];

  const localBySymbol = new Map(
    localPositions.map(p => [
      normalizeSymbol(p.symbol),
      p
    ])
  );

  const remoteBySymbol = new Map(
    remotePositions.map(p => [
      normalizeSymbol(p.symbol),
      p
    ])
  );

  for (const [symbol, local] of localBySymbol) {
    const remote = remoteBySymbol.get(symbol);

    if (!remote) {
      mismatches.push({
        symbol,
        local,
        reason: 'missing_remote'
      });

      continue;
    }

    if (local.side !== remote.side) {
      mismatches.push({
        symbol,
        local,
        remote,
        reason: 'side_mismatch'
      });

      continue;
    }

    const quantityTolerance =
      local.quantity * 0.01;

    if (
      Math.abs(local.quantity - remote.quantity) >
      quantityTolerance
    ) {
      mismatches.push({
        symbol,
        local,
        remote,
        reason: 'quantity_mismatch'
      });

      continue;
    }

    const priceTolerance =
      local.entryPrice * 0.01;

    if (
      Math.abs(local.entryPrice - remote.entryPrice) >
      priceTolerance
    ) {
      mismatches.push({
        symbol,
        local,
        remote,
        reason: 'price_mismatch'
      });

      continue;
    }
  }

  for (const [symbol, remote] of remoteBySymbol) {
    const local = localBySymbol.get(symbol);

    if (!local) {
      mismatches.push({
        symbol,
        remote,
        reason: 'missing_local'
      });
    }
  }

  if (mismatches.length === 0 && remoteError == null) {
    return {
      ok: true,
      localPositions,
      remotePositions,
      mismatches
    };
  }

  if (autoFix && !dryRun) {
    for (const mismatch of mismatches) {
      try {
        if (mismatch.reason === 'missing_remote') {
          const local = mismatch.local!;

          console.warn(
            `[${new Date().toISOString()}] Reconciliation: ` +
            `local position ${local.symbol} not found on exchange, ` +
            `closing local state`
          );

          closePosition(
            local.id,
            local.entryPrice,
            'manual',
            {
              reason: 'reconciliation_missing_remote'
            }
          );
        } else if (mismatch.reason === 'missing_local') {
          const remote = mismatch.remote!;

          console.warn(
            `[${new Date().toISOString()}] Reconciliation: ` +
            `remote position ${remote.symbol} not found locally, ` +
            `creating local state`
          );

          openPosition({
            symbol: remote.symbol,
            marketId: remote.marketId,
            side: remote.side,
            entryPrice: remote.entryPrice,
            quantity: remote.quantity,
            takeProfitPrice: remote.entryPrice * 1.1,
            stopLossPrice: remote.entryPrice * 0.9,
            metadata: {
              regime: 'reconciliation',
              macdCrossUp: false,
              macdCrossDown: false,
              lastRsi: 0,
              lastAtr: 0,
              adx: 0,
              bbWidth: 0,
              atrPct: 0
            }
          });
        } else if (
          mismatch.reason === 'quantity_mismatch' ||
          mismatch.reason === 'side_mismatch' ||
          mismatch.reason === 'price_mismatch'
        ) {
          const local = mismatch.local;
          const remote = mismatch.remote;

          console.error(
            `[${new Date().toISOString()}] Reconciliation: ` +
            `severe mismatch for ${mismatch.symbol}: ` +
            `local=${local ? JSON.stringify(local) : 'none'}, ` +
            `remote=${remote ? JSON.stringify(remote) : 'none'}`,
            `reason=${mismatch.reason}`
          );

          if (local) {
            closePosition(
              local.id,
              local.entryPrice,
              'manual',
              {
                reason: 'reconciliation_severe_mismatch'
              }
            );
          }

          if (remote) {
            openPosition({
              symbol: remote.symbol,
              marketId: remote.marketId,
              side: remote.side,
              entryPrice: remote.entryPrice,
              quantity: remote.quantity,
              takeProfitPrice: remote.entryPrice * 1.1,
              stopLossPrice: remote.entryPrice * 0.9,
              metadata: {
                regime: 'reconciliation',
                macdCrossUp: false,
                macdCrossDown: false,
                lastRsi: 0,
                lastAtr: 0,
                adx: 0,
                bbWidth: 0,
                atrPct: 0
              }
            });
          }
        }
      } catch (error) {
        const errorMsg =
          error instanceof Error
            ? error.message
            : 'Unknown error';

        logError({
          timestamp: new Date().toISOString(),
          context: 'reconciliation-fix',
          symbol: mismatch.symbol,
          error: errorMsg
        });

        notifyError({
          context: 'reconciliation-fix',
          symbol: mismatch.symbol,
          error: errorMsg
        });
      }
    }
  }

  return {
    ok: mismatches.length === 0,
    localPositions,
    remotePositions,
    mismatches,
    error: remoteError
  };
}

export async function restoreStateAfterRestart(
  signerClient: SignerClient,
  accountIndex: number
): Promise<{
  restored: number;
  closed: number;
  errors: number;
}> {
  const result = await reconcileAccount(
    signerClient,
    accountIndex,
    {
      autoFix: true,
      dryRun: false
    }
  );

  let restored = 0;
  let closed = 0;
  let errors = 0;

  for (const mismatch of result.mismatches) {
    if (mismatch.reason === 'missing_local') {
      restored++;
    } else if (mismatch.reason === 'missing_remote') {
      closed++;
    } else {
      errors++;
    }
  }

  return {
    restored,
    closed,
    errors
  };
}
