import {
  SignerClient
} from 'zklighter-sdk';

import {
  getPositions,
  openPosition,
  closePosition,
  VirtualPosition
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

import {
  loadOpenPositions
} from './persistence';

import {
  updateLiveAccountState
} from './liveState';

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

type ReconciliationMismatch = {
  symbol: string;
  local?: ReturnType<
    typeof getPositions
  >[number];
  remote?: LighterPosition;
  reason:
    | 'missing_remote'
    | 'missing_local'
    | 'quantity_mismatch'
    | 'side_mismatch'
    | 'price_mismatch';
};

type ReconciliationResult = {
  ok: boolean;
  localPositions: ReturnType<
    typeof getPositions
  >;
  remotePositions: LighterPosition[];
  mismatches: ReconciliationMismatch[];
  error?: string;
};

function toNumber(
  value: unknown
): number | null {
  const number =
    Number(value);

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

  return value as Record<
    string,
    unknown
  >;
}

function getString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value =
      record[key];

    if (
      typeof value === 'string' &&
      value.trim().length > 0
    ) {
      return value.trim();
    }
  }

  return undefined;
}

function recordsFromValue(
  value: unknown
): Array<
  Record<string, unknown>
> {
  if (Array.isArray(value)) {
    return value
      .map(getRecord)
      .filter(
        (
          item
        ): item is Record<
          string,
          unknown
        > =>
          item !== null
      );
  }

  const record =
    getRecord(value);

  if (!record) {
    return [];
  }

  return Object.values(record)
    .map(getRecord)
    .filter(
      (
        item
      ): item is Record<
        string,
        unknown
      > =>
        item !== null
    );
}

function getPositionRecords(
  response: unknown
): Array<
  Record<string, unknown>
> {
  const root =
    getRecord(response);

  if (!root) {
    return [];
  }

  const directPositions =
    recordsFromValue(
      root.positions
    );

  if (
    directPositions.length > 0
  ) {
    return directPositions;
  }

  const candidates: unknown[] = [
    root.data,
    root.account,
    root.accounts
  ];

  for (
    const candidate
    of candidates
  ) {
    const candidateRecord =
      getRecord(candidate);

    if (!candidateRecord) {
      continue;
    }

    const nestedPositions =
      recordsFromValue(
        candidateRecord.positions
      );

    if (
      nestedPositions.length > 0
    ) {
      return nestedPositions;
    }

    const nestedAccounts =
      recordsFromValue(
        candidateRecord.accounts
      );

    for (
      const account
      of nestedAccounts
    ) {
      const accountPositions =
        recordsFromValue(
          account.positions
        );

      if (
        accountPositions.length > 0
      ) {
        return accountPositions;
      }
    }
  }

  return [];
}

function parsePosition(
  rawPosition: Record<string, unknown>
): LighterPosition | null {
  const marketId =
    toNumber(
      rawPosition.market_id ??
        rawPosition.market_index ??
        rawPosition.marketId
    );

  const rawSize =
    toNumber(
      rawPosition.position ??
        rawPosition.position_size ??
        rawPosition.size ??
        rawPosition.quantity
    );

  const entryPrice =
    toNumber(
      rawPosition.avg_entry_price ??
        rawPosition.entry_price ??
        rawPosition.average_entry_price ??
        rawPosition.entryPrice
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

  const explicitSide =
    getString(
      rawPosition,
      'position_side',
      'side'
    )?.toLowerCase();

  const sign =
    toNumber(
      rawPosition.sign
    );

  let side:
    | 'long'
    | 'short';

  if (
    explicitSide === 'long' ||
    explicitSide === 'short'
  ) {
    side = explicitSide;
  } else if (
    sign != null &&
    sign !== 0
  ) {
    side =
      sign > 0
        ? 'long'
        : 'short';
  } else {
    side =
      rawSize > 0
        ? 'long'
        : 'short';
  }

  const symbol =
    getString(
      rawPosition,
      'symbol',
      'market_symbol',
      'marketSymbol'
    ) ??
    `MARKET_${marketId}`;

  return {
    symbol:
      normalizeSymbol(symbol),
    marketId,
    side,
    quantity:
      Math.abs(rawSize),
    entryPrice
  };
}

export async function fetchAccountPositions(
  _signerClient: SignerClient,
  accountIndex: number
): Promise<LighterPosition[]> {
  if (
    !Number.isInteger(accountIndex) ||
    accountIndex < 0
  ) {
    throw new Error(
      `Invalid Lighter account index: ${accountIndex}`
    );
  }

  const url =
    new URL(
      `${LIGHTER_API_URL}/api/v1/account`
    );

  url.searchParams.set(
    'by',
    'index'
  );

  url.searchParams.set(
    'value',
    String(accountIndex)
  );

  const response =
    await fetch(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      }
    );

  const responseText =
    await response.text();

  let responseData: unknown = null;

  try {
    responseData =
      responseText
        ? JSON.parse(
            responseText
          )
        : null;
  } catch {
    throw new Error(
      `Invalid JSON from Lighter account endpoint: ` +
      `${responseText.slice(0, 300)}`
    );
  }

  if (!response.ok) {
    const record =
      getRecord(responseData);

    throw new Error(
      `Lighter account request failed ` +
        `(${response.status}): ` +
        `${String(
          record?.message ??
            record?.error ??
            record?.code ??
            response.statusText
        )}`
    );
  }

  const responseRecord =
    getRecord(responseData);

  if (
    responseRecord?.code != null &&
    Number(
      responseRecord.code
    ) !== 200
  ) {
    throw new Error(
      `Lighter account API error: ` +
        `${String(
          responseRecord.message ??
            responseRecord.code
        )}`
    );
  }

  const positionRecords =
    getPositionRecords(
      responseData
    );

  return positionRecords
    .map(parsePosition)
    .filter(
      (
        position
      ): position is LighterPosition =>
        position !== null
    );
}

function getPositionKey(
  position: {
    marketId?: number;
    symbol: string;
  }
): string {
  if (
    position.marketId != null
  ) {
    return `market:${position.marketId}`;
  }

  return (
    `symbol:${normalizeSymbol(
      position.symbol
    )}`
  );
}

function buildRestoredPosition(
  persisted: VirtualPosition
): ReturnType<
  typeof openPosition
> {
  return openPosition({
    symbol:
      persisted.symbol,
    marketId:
      persisted.marketId,
    side:
      persisted.side,
    entryPrice:
      persisted.entryPrice,
    quantity:
      persisted.quantity,
    takeProfitPrice:
      persisted.takeProfitPrice,
    stopLossPrice:
      persisted.stopLossPrice,
    exchangeStopLossPrice:
      persisted.exchangeStopLossPrice,
    exchangeTakeProfitPrice:
      persisted.exchangeTakeProfitPrice,
    exchangeStopLossOrderId:
      persisted.exchangeStopLossOrderId,
    exchangeTakeProfitOrderId:
      persisted.exchangeTakeProfitOrderId,
    exchangeStopLossClientOrderIndex:
      persisted.exchangeStopLossClientOrderIndex,
    exchangeTakeProfitClientOrderIndex:
      persisted.exchangeTakeProfitClientOrderIndex,
    metadata:
      persisted.metadata,
    executionOrderId:
      persisted.executionOrderId,
    clientOrderId:
      persisted.clientOrderId
  });
}

export async function reconcileAccount(
  signerClient: SignerClient,
  accountIndex: number,
  options?: {
    autoFix?: boolean;
    dryRun?: boolean;
  }
): Promise<ReconciliationResult> {
  const autoFix =
    options?.autoFix ?? false;

  const dryRun =
    options?.dryRun ?? false;

  const localPositions =
    getPositions();

  let remotePositions:
    LighterPosition[] = [];

  let remoteError:
    string | undefined;

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
      timestamp:
        new Date().toISOString(),
      context:
        'reconciliation',
      error:
        remoteError
    });

    notifyError({
      context:
        'reconciliation',
      error:
        remoteError
    });
  }

  const mismatches:
    ReconciliationMismatch[] =
    [];

  const localByKey =
    new Map(
      localPositions.map(
        position => [
          getPositionKey(position),
          position
        ]
      )
    );

  const remoteByKey =
    new Map(
      remotePositions.map(
        position => [
          getPositionKey(position),
          position
        ]
      )
    );

  for (
    const [key, local]
    of localByKey
  ) {
    const remote =
      remoteByKey.get(key);

    const symbol =
      normalizeSymbol(
        local.symbol
      );

    if (!remote) {
      mismatches.push({
        symbol,
        local,
        reason:
          'missing_remote'
      });

      continue;
    }

    if (
      local.side !== remote.side
    ) {
      mismatches.push({
        symbol,
        local,
        remote,
        reason:
          'side_mismatch'
      });

      continue;
    }

    const quantityTolerance =
      Math.max(
        local.quantity * 0.01,
        1e-12
      );

    if (
      Math.abs(
        local.quantity -
          remote.quantity
      ) > quantityTolerance
    ) {
      mismatches.push({
        symbol,
        local,
        remote,
        reason:
          'quantity_mismatch'
      });

      continue;
    }

    const priceTolerance =
      Math.max(
        local.entryPrice * 0.01,
        1e-12
      );

    if (
      Math.abs(
        local.entryPrice -
          remote.entryPrice
      ) > priceTolerance
    ) {
      mismatches.push({
        symbol,
        local,
        remote,
        reason:
          'price_mismatch'
      });
    }
  }

  for (
    const [key, remote]
    of remoteByKey
  ) {
    if (
      localByKey.has(key)
    ) {
      continue;
    }

    mismatches.push({
      symbol:
        normalizeSymbol(
          remote.symbol
        ),
      remote,
      reason:
        'missing_local'
    });
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

  if (
    autoFix &&
    !dryRun &&
    remoteError == null
  ) {
    for (
      const mismatch
      of mismatches
    ) {
      try {
        if (
          mismatch.reason ===
          'missing_remote'
        ) {
          const local =
            mismatch.local;

          if (!local) {
            continue;
          }

          const result =
            closePosition(
              local.id,
              local.entryPrice,
              'reconciliation_missing_remote'
            );

          if (!result.ok) {
            throw new Error(
              result.message
            );
          }
        } else if (
          mismatch.reason ===
          'missing_local'
        ) {
          const remote =
            mismatch.remote;

          if (!remote) {
            continue;
          }

          const persisted =
            await loadOpenPositions();

          const persistedPosition =
            persisted.find(
              position =>
                getPositionKey(
                  position
                ) ===
                getPositionKey(
                  remote
                )
            );

          if (
            !persistedPosition
          ) {
            throw new Error(
              `Remote position ${remote.symbol} ` +
                `cannot be restored: persisted state ` +
                `not found`
            );
          }

          const restored =
            buildRestoredPosition(
              persistedPosition
            );

          if (!restored.ok) {
            throw new Error(
              `Failed to restore ${remote.symbol}: ` +
                `${restored.message}`
            );
          }
        } else {
          throw new Error(
            `Severe reconciliation mismatch for ` +
              `${mismatch.symbol}: ` +
              `${mismatch.reason}`
          );
        }
      } catch (error) {
        const errorMsg =
          error instanceof Error
            ? error.message
            : 'Unknown error';

        logError({
          timestamp:
            new Date().toISOString(),
          context:
            'reconciliation-fix',
          symbol:
            mismatch.symbol,
          error:
            errorMsg
        });

        notifyError({
          context:
            'reconciliation-fix',
          symbol:
            mismatch.symbol,
          error:
            errorMsg
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
    error:
      remoteError
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
  const persisted =
    await loadOpenPositions();

  const result =
    await reconcileAccount(
      signerClient,
      accountIndex,
      {
        autoFix: true,
        dryRun: false
      }
    );

  if (result.error) {
    return {
      restored: 0,
      closed: 0,
      errors: 1
    };
  }

  let restored = 0;
  let closed = 0;
  let errors = 0;

  for (
    const mismatch
    of result.mismatches
  ) {
    if (
      mismatch.reason ===
      'missing_local'
    ) {
      const remote =
        mismatch.remote;

      if (!remote) {
        errors++;
        continue;
      }

      const exists =
        persisted.some(
          position =>
            getPositionKey(
              position
            ) ===
            getPositionKey(
              remote
            )
        );

      if (exists) {
        restored++;
      } else {
        errors++;
      }
    } else if (
      mismatch.reason ===
      'missing_remote'
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

    const normalizedSymbol =
      normalizeSymbol(symbol);

    const remote =
      remotePositions.find(
        position =>
          normalizeSymbol(
            position.symbol
          ) === normalizedSymbol
      );

    if (!remote) {
      return {
        ok: false,
        mismatch:
          `Position ${symbol} not found on exchange ` +
          `after fill`
      };
    }

    if (
      remote.side !== expectedSide
    ) {
      return {
        ok: false,
        mismatch:
          `Side mismatch for ${symbol}: ` +
          `expected=${expectedSide}, ` +
          `remote=${remote.side}`
      };
    }

    const quantityTolerance =
      Math.max(
        expectedQuantity * 0.02,
        1e-12
      );

    if (
      Math.abs(
        remote.quantity -
          expectedQuantity
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

export async function syncLiveBalance(
  accountIndex: number
): Promise<void> {
  const response = await fetch(
    `${LIGHTER_API_URL}/api/v1/account?` +
      new URLSearchParams({
        by: 'index',
        value: String(accountIndex)
      }).toString(),
    {
      headers: {
        Accept: 'application/json'
      }
    }
  );

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `Failed to fetch live balance: ` +
        `${response.status} ${body}`
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      'Invalid JSON while fetching live balance'
    );
  }

  const root = getRecord(parsed);
  const account = getRecord(root?.account) ?? root;

  // Правильные поля из Lighter API
  const balance =
    toNumber(
      account?.collateral ??           // ✅ Основное поле
        account?.total_collateral ??   // ✅ Альтернатива
        account?.balance ??            // ✅ На случай изменений
        account?.available_balance ??  // ✅ Доступный баланс
        account?.availableBalance      // ✅ camelCase версия
    );

  if (
    balance == null ||
    balance < 0
  ) {
    console.warn(
      `[${new Date().toISOString()}] ` +
        `Live balance field not found in account response. ` +
        `Response keys: ${Object.keys(account ?? {}).join(', ')}`
    );

    // Не падаем, а просто пропускаем синхронизацию
    return;
  }

  updateLiveAccountState({
    balance
  });
}
