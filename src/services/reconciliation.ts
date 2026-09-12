import {
  SignerClient
} from 'zklighter-sdk';

import {
  getPositions,
  openPosition,
  closePosition
} from './positionState';

import {
  logError
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

export type LighterPosition = {
  symbol: string;
  marketId: number;
  side: 'long' | 'short';
  quantity: number;
  entryPrice: number;
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

function getRecord(
  value: unknown
): Record<string, unknown> | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }

  return value as Record<string, unknown>;
}

function getArrayFromAccountResponse(
  response: unknown
): Array<Record<string, unknown>> {
  const root = getRecord(response);

  if (!root) {
    return [];
  }

  const candidates: unknown[] = [
    root.positions,
    root.data,
    root.account
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate
        .map(getRecord)
        .filter(
          (
            item
          ): item is Record<string, unknown> =>
            item != null
        );
    }

    const nested = getRecord(candidate);

    if (!nested) {
      continue;
    }

    if (Array.isArray(nested.positions)) {
      return nested.positions
        .map(getRecord)
        .filter(
          (
            item
          ): item is Record<string, unknown> =>
            item != null
        );
    }

    if (Array.isArray(nested.accounts)) {
      for (const accountCandidate of nested.accounts) {
        const account = getRecord(accountCandidate);

        if (
          account &&
          Array.isArray(account.positions)
        ) {
          return account.positions
            .map(getRecord)
            .filter(
              (
                item
              ): item is Record<string, unknown> =>
                item != null
            );
        }
      }
    }
  }

  return [];
}

function getString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function parsePosition(
  pos: Record<string, unknown>
): LighterPosition | null {
  const marketId = toNumber(
    pos.market_index ??
    pos.market_id ??
    pos.marketId
  );

  const rawSize = toNumber(
    pos.size ??
    pos.position_size ??
    pos.position ??
    pos.quantity
  );

  const entryPrice = toNumber(
    pos.entry_price ??
    pos.avg_entry_price ??
    pos.average_entry_price ??
    pos.entryPrice
  );

  if (
    marketId == null ||
    rawSize == null ||
    rawSize === 0 ||
    entryPrice == null ||
    entryPrice <= 0
  ) {
    return null;
  }

  const sideValue = getString(
    pos,
    'side',
    'position_side'
  )?.toLowerCase();

  let side: 'long' | 'short';

  if (
    sideValue === 'long' ||
    sideValue === 'short'
  ) {
    side = sideValue;
  } else {
    side = rawSize > 0
      ? 'long'
      : 'short';
  }

  const symbol =
    getString(
      pos,
      'symbol',
      'market_symbol',
      'marketSymbol'
    ) ??
    `MARKET_${marketId}`;

  return {
    symbol: normalizeSymbol(symbol),
    marketId,
    side,
    quantity: Math.abs(rawSize),
    entryPrice
  };
}

export async function fetchAccountPositions(
  _signerClient: SignerClient,
  accountIndex: number
): Promise<LighterPosition[]> {
  try {
    const url = new URL(
      `${LIGHTER_API_URL}/api/v1/account`
    );

    url.searchParams.set(
      'account_index',
      String(accountIndex)
    );

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json'
      }
    });

    const responseText = await response.text();

    let responseData: unknown;

    try {
      responseData = responseText
        ? JSON.parse(responseText)
        : null;
    } catch {
      throw new Error(
        `Invalid JSON response from Lighter ` +
        `account endpoint: ${responseText.slice(0, 300)}`
      );
    }

    if (!response.ok) {
      const errorMessage =
        getRecord(responseData)?.message ??
        getRecord(responseData)?.error ??
        response.statusText;

      throw new Error(
        `Lighter account request failed ` +
        `(${response.status}): ${String(errorMessage)}`
      );
    }

    const positionsRaw =
      getArrayFromAccountResponse(responseData);

    const positions: LighterPosition[] = [];

    for (const positionRaw of positionsRaw) {
      const position = parsePosition(positionRaw);

      if (position) {
        positions.push(position);
      }
    }

    return positions;
  } catch (error) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : 'Unknown error';

    console.warn(
      `[${new Date().toISOString()}] ` +
      `fetchAccountPositions: ${errorMsg}`
    );

    throw new Error(
      `Failed to fetch account positions: ${errorMsg}`
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
    localPositions.map(position => [
      normalizeSymbol(position.symbol),
      position
    ])
  );

  const remoteBySymbol = new Map(
    remotePositions.map(position => [
      normalizeSymbol(position.symbol),
      position
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
      Math.max(local.quantity * 0.01, 1e-12);

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
      Math.max(local.entryPrice * 0.01, 1e-12);

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

  if (
    mismatches.length === 0 &&
    remoteError == null
  ) {
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
        if (
          mismatch.reason === 'missing_remote'
        ) {
          const local = mismatch.local!;

          console.warn(
            `[${new Date().toISOString()}] ` +
            `Reconciliation: local position ` +
            `${local.symbol} not found on exchange, ` +
            `closing local state`
          );

          closePosition(
            local.id,
            local.entryPrice,
            'reconciliation_missing_remote'
          );
        } else if (
          mismatch.reason === 'missing_local'
        ) {
          const remote = mismatch.remote!;

          console.warn(
            `[${new Date().toISOString()}] ` +
            `Reconciliation: remote position ` +
            `${remote.symbol} not found locally, ` +
            `creating local state`
          );

          openPosition({
            symbol: remote.symbol,
            marketId: remote.marketId,
            side: remote.side,
            entryPrice: remote.entryPrice,
            quantity: remote.quantity,
            takeProfitPrice:
              remote.side === 'long'
                ? remote.entryPrice * 1.1
                : remote.entryPrice * 0.9,
            stopLossPrice:
              remote.side === 'long'
                ? remote.entryPrice * 0.9
                : remote.entryPrice * 1.1,
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
            `[${new Date().toISOString()}] ` +
            `Reconciliation: severe mismatch ` +
            `for ${mismatch.symbol}: ` +
            `local=${
              local
                ? JSON.stringify(local)
                : 'none'
            }, ` +
            `remote=${
              remote
                ? JSON.stringify(remote)
                : 'none'
            }, ` +
            `reason=${mismatch.reason}`
          );

          if (local) {
            closePosition(
              local.id,
              local.entryPrice,
              'reconciliation_severe_mismatch'
            );
          }

          if (remote) {
            openPosition({
              symbol: remote.symbol,
              marketId: remote.marketId,
              side: remote.side,
              entryPrice: remote.entryPrice,
              quantity: remote.quantity,
              takeProfitPrice:
                remote.side === 'long'
                  ? remote.entryPrice * 1.1
                  : remote.entryPrice * 0.9,
              stopLossPrice:
                remote.side === 'long'
                  ? remote.entryPrice * 0.9
                  : remote.entryPrice * 1.1,
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
    ok:
      mismatches.length === 0 &&
      remoteError == null,
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
    } else if (
      mismatch.reason === 'missing_remote'
    ) {
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

export async function verifyPositionAfterFill(
  signerClient: SignerClient,
  accountIndex: number,
  symbol: string,
  expectedSide: 'long' | 'short',
  expectedQuantity: number
): Promise<{
  ok: boolean;
  mismatch?: string;
}> {
  try {
    const remotePositions =
      await fetchAccountPositions(
        signerClient,
        accountIndex
      );

    const normalizedSymbol = normalizeSymbol(symbol);

    const remote = remotePositions.find(
      position =>
        normalizeSymbol(position.symbol) ===
        normalizedSymbol
    );

    if (!remote) {
      return {
        ok: false,
        mismatch:
          `Position ${symbol} not found on exchange ` +
          `after fill`
      };
    }

    if (remote.side !== expectedSide) {
      return {
        ok: false,
        mismatch:
          `Side mismatch for ${symbol}: ` +
          `expected=${expectedSide}, ` +
          `remote=${remote.side}`
      };
    }

    const quantityTolerance =
      Math.max(expectedQuantity * 0.02, 1e-12);

    if (
      Math.abs(
        remote.quantity - expectedQuantity
      ) > quantityTolerance
    ) {
      return {
        ok: false,
        mismatch:
          `Quantity mismatch for ${symbol}: ` +
          `expected=${expectedQuantity}, ` +
          `remote=${remote.quantity}`
      };
    }

    return {
      ok: true
    };
  } catch (error) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : 'Unknown error';

    return {
      ok: false,
      mismatch:
        `Verification error: ${errorMsg}`
    };
  }
}
