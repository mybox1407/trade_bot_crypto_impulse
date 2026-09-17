import { SignerClient } from 'zklighter-sdk';
import { getPositions, openPosition, VirtualPosition, updatePositionMetadata } from './positionState';
import { logError } from './logger';
import { notifyError } from './telegram';
import { normalizeSymbol } from './exchange';
import { loadOpenPositions } from './persistence';
import { updateLiveAccountState } from './liveState';

const LIGHTER_API_URL = process.env.LIGHTER_API_URL ?? 'https://mainnet.zklighter.elliot.ai';
const VERIFY_RETRY_DELAYS_MS = [0, 250, 500, 1000, 2000, 3000, 5000];

export type LighterPosition = {
  symbol: string;
  marketId: number;
  side: 'long' | 'short';
  quantity: number;
  entryPrice: number;
};

type ReconciliationMismatch = {
  symbol: string;
  local?: ReturnType<typeof getPositions>[number];
  remote?: LighterPosition;
  reason: 'missing_remote' | 'missing_local' | 'quantity_mismatch' | 'side_mismatch' | 'price_mismatch' | 'remote_unavailable';
};

type ReconciliationResult = {
  ok: boolean;
  localPositions: ReturnType<typeof getPositions>;
  remotePositions: LighterPosition[];
  mismatches: ReconciliationMismatch[];
  error?: string;
};

function reconciliationLog(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    ...data
  }));
}

function reconciliationError(event: string, error: unknown, data: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    ...data
  }));
}

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function recordsFromValue(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.map(getRecord).filter((x): x is Record<string, unknown> => x !== null);
  }
  const record = getRecord(value);
  return record
    ? Object.values(record).map(getRecord).filter((x): x is Record<string, unknown> => x !== null)
    : [];
}

function getPositionRecords(response: unknown): Array<Record<string, unknown>> {
  const root = getRecord(response);
  if (!root) return [];

  const direct = recordsFromValue(root.positions);
  if (direct.length) return direct;

  const account = getRecord(root.account);
  if (account) {
    const positions = recordsFromValue(account.positions);
    if (positions.length) return positions;
  }

  if (Array.isArray(root.accounts)) {
    for (const rawAccount of root.accounts) {
      const accountRecord = getRecord(rawAccount);
      if (!accountRecord) continue;

      const positions = recordsFromValue(accountRecord.positions);
      if (positions.length) return positions;
    }
  }

  const data = getRecord(root.data);
  if (data) {
    const positions = recordsFromValue(data.positions);
    if (positions.length) return positions;

    if (Array.isArray(data.accounts)) {
      for (const rawAccount of data.accounts) {
        const accountRecord = getRecord(rawAccount);
        if (!accountRecord) continue;

        const positions = recordsFromValue(accountRecord.positions);
        if (positions.length) return positions;
      }
    }
  }

  return [];
}

function readNestedPosition(raw: Record<string, unknown>): Record<string, unknown> {
  const nested = getRecord(raw.position);
  return nested ? { ...raw, ...nested } : raw;
}

function parsePosition(rawInput: Record<string, unknown>): LighterPosition | null {
  const raw = readNestedPosition(rawInput);
  const marketId = toNumber(raw.market_id ?? raw.market_index ?? raw.marketId);
  const quantity = toNumber(raw.position_size ?? raw.size ?? raw.quantity ?? raw.position);
  const entryPrice = toNumber(
    raw.avg_entry_price ?? raw.entry_price ?? raw.average_entry_price ?? raw.entryPrice
  );

  if (marketId == null || quantity == null || quantity <= 0 || entryPrice == null || entryPrice <= 0) {
    return null;
  }

  const explicitSide = getString(raw, 'position_side', 'side')?.toLowerCase();
  const sign = toNumber(raw.sign);
  const side: 'long' | 'short' = explicitSide === 'long' || explicitSide === 'short'
    ? explicitSide
    : sign != null && sign !== 0
      ? sign > 0 ? 'long' : 'short'
      : 'long';

  const symbol = getString(raw, 'symbol', 'market_symbol', 'marketSymbol') ?? `MARKET_${marketId}`;

  return {
    symbol: normalizeSymbol(symbol),
    marketId,
    side,
    quantity: Math.abs(quantity),
    entryPrice
  };
}

async function fetchJson(url: URL, logContext: string, authToken?: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (authToken) headers.Authorization = authToken;

  try {
    const response = await fetch(url, { headers });
    const text = await response.text();

    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      reconciliationError('LIGHTER_RESPONSE_JSON_PARSE_FAILED', 'Invalid JSON response', {
        context: logContext,
        status: response.status,
        bodyPreview: text.slice(0, 300)
      });
      throw new Error(`Invalid JSON from Lighter endpoint: ${text.slice(0, 300)}`);
    }

    if (!response.ok) {
      const record = getRecord(data);
      const errorMessage = String(record?.message ?? record?.error ?? response.statusText);
      reconciliationError('LIGHTER_HTTP_REQUEST_FAILED', errorMessage, {
        context: logContext,
        status: response.status
      });
      throw new Error(`Lighter request failed (${response.status}): ${errorMessage}`);
    }

    const record = getRecord(data);
    if (record?.code != null && Number(record.code) !== 200) {
      const errorMessage = String(record.message ?? record.code);
      reconciliationError('LIGHTER_API_REQUEST_FAILED', errorMessage, {
        context: logContext,
        code: record.code
      });
      throw new Error(`Lighter API error: ${errorMessage}`);
    }

    return data;
  } catch (error) {
    if (error instanceof Error && (
      error.message.startsWith('Invalid JSON from Lighter endpoint') ||
      error.message.startsWith('Lighter request failed') ||
      error.message.startsWith('Lighter API error')
    )) {
      throw error;
    }

    reconciliationError('LIGHTER_NETWORK_REQUEST_FAILED', error, { context: logContext });
    throw error;
  }
}

function createAuthToken(signerClient: SignerClient, apiKeyIndex: number): string | undefined {
  try {
    const [authToken, authError] = signerClient.create_auth_token_with_expiry(60 * 60, undefined, apiKeyIndex);
    if (authError || !authToken) {
      reconciliationError('LIGHTER_AUTH_TOKEN_FAILED', authError ?? 'Unknown authentication error', { apiKeyIndex });
      return undefined;
    }
    return authToken;
  } catch (error) {
    reconciliationError('LIGHTER_AUTH_TOKEN_FAILED', error, { apiKeyIndex });
    return undefined;
  }
}

export async function fetchAccountPositions(
  signerClient: SignerClient,
  accountIndex: number
): Promise<LighterPosition[]> {
  if (!Number.isInteger(accountIndex) || accountIndex < 0) {
    throw new Error(`Invalid Lighter account index: ${accountIndex}`);
  }

  const url = new URL(`${LIGHTER_API_URL}/api/v1/account`);
  url.searchParams.set('by', 'index');
  url.searchParams.set('value', String(accountIndex));

  const apiKeyIndex = Number(process.env.LIGHTER_API_KEY_INDEX ?? 0);
  const authToken = createAuthToken(signerClient, apiKeyIndex);

  const data = await fetchJson(url, `fetchAccountPositions accountIndex=${accountIndex}`, authToken);
  const positions = getPositionRecords(data)
    .map(parsePosition)
    .filter((position): position is LighterPosition => position !== null);

  //reconciliationLog('EXCHANGE_POSITIONS_SYNCED', {
  //  accountIndex,
  //  positionsCount: positions.length,
  //  positions: positions.map(position => ({
  //    symbol: position.symbol,
  //    marketId: position.marketId,
  //    side: position.side,
  //    quantity: position.quantity,
  //    entryPrice: position.entryPrice
  //  }))
  //});

  return positions;
}

function getPositionKey(position: { marketId?: number; symbol: string }): string {
  return position.marketId != null
    ? `market:${position.marketId}`
    : `symbol:${normalizeSymbol(position.symbol)}`;
}

function buildRestoredPosition(persisted: VirtualPosition): ReturnType<typeof openPosition> {
  return openPosition({
    symbol: persisted.symbol,
    marketId: persisted.marketId,
    side: persisted.side,
    entryPrice: persisted.entryPrice,
    quantity: persisted.quantity,
    takeProfitPrice: persisted.takeProfitPrice,
    stopLossPrice: persisted.stopLossPrice,
    exchangeStopLossPrice: persisted.exchangeStopLossPrice,
    exchangeTakeProfitPrice: persisted.exchangeTakeProfitPrice,
    exchangeStopLossOrderId: persisted.exchangeStopLossOrderId,
    exchangeTakeProfitOrderId: persisted.exchangeTakeProfitOrderId,
    exchangeStopLossClientOrderIndex: persisted.exchangeStopLossClientOrderIndex,
    exchangeTakeProfitClientOrderIndex: persisted.exchangeTakeProfitClientOrderIndex,
    metadata: persisted.metadata,
    executionOrderId: persisted.executionOrderId,
    clientOrderId: persisted.clientOrderId
  });
}

export async function reconcileAccount(
  signerClient: SignerClient,
  accountIndex: number,
  options?: { autoFix?: boolean; dryRun?: boolean }
): Promise<ReconciliationResult> {
  const autoFix = options?.autoFix ?? false;
  const dryRun = options?.dryRun ?? false;
  reconciliationLog('RECONCILIATION_STARTED', { accountIndex, autoFix, dryRun });

  const localPositions = getPositions();
  let remotePositions: LighterPosition[] = [];
  let remoteError: string | undefined;

  try {
    remotePositions = await fetchAccountPositions(signerClient, accountIndex);
  } catch (error) {
    remoteError = error instanceof Error ? error.message : 'Unknown error';
    reconciliationError('EXCHANGE_SYNC_FAILED', error, { accountIndex });
    logError({ timestamp: new Date().toISOString(), context: 'reconciliation', error: remoteError });
    notifyError({ context: 'reconciliation', error: remoteError });
  }

  const mismatches: ReconciliationMismatch[] = [];
  const localByKey = new Map(localPositions.map(position => [getPositionKey(position), position]));
  const remoteByKey = new Map(remotePositions.map(position => [getPositionKey(position), position]));

  for (const [key, local] of localByKey) {
    const remote = remoteByKey.get(key);
    if (!remote) {
      mismatches.push({ symbol: normalizeSymbol(local.symbol), local, reason: 'missing_remote' });
      reconciliationLog('REMOTE_POSITION_MISSING', {
        symbol: normalizeSymbol(local.symbol),
        positionId: local.id,
        marketId: local.marketId,
        side: local.side,
        quantity: local.quantity
      });
      continue;
    }
    if (local.side !== remote.side) {
      mismatches.push({ symbol: normalizeSymbol(local.symbol), local, remote, reason: 'side_mismatch' });
      reconciliationLog('POSITION_SIDE_MISMATCH', { symbol: normalizeSymbol(local.symbol), localSide: local.side, remoteSide: remote.side });
      continue;
    }
    if (Math.abs(local.quantity - remote.quantity) > Math.max(local.quantity * 0.01, 1e-12)) {
      mismatches.push({ symbol: normalizeSymbol(local.symbol), local, remote, reason: 'quantity_mismatch' });
      reconciliationLog('POSITION_QUANTITY_MISMATCH', { symbol: normalizeSymbol(local.symbol), localQuantity: local.quantity, remoteQuantity: remote.quantity });
      continue;
    }
    if (Math.abs(local.entryPrice - remote.entryPrice) > Math.max(local.entryPrice * 0.01, 1e-12)) {
      mismatches.push({ symbol: normalizeSymbol(local.symbol), local, remote, reason: 'price_mismatch' });
      reconciliationLog('POSITION_PRICE_MISMATCH', { symbol: normalizeSymbol(local.symbol), localEntryPrice: local.entryPrice, remoteEntryPrice: remote.entryPrice });
    }
  }

  for (const [key, remote] of remoteByKey) {
    if (!localByKey.has(key)) {
      mismatches.push({ symbol: normalizeSymbol(remote.symbol), remote, reason: 'missing_local' });
      reconciliationLog('LOCAL_POSITION_MISSING', {
        symbol: normalizeSymbol(remote.symbol),
        marketId: remote.marketId,
        side: remote.side,
        quantity: remote.quantity,
        entryPrice: remote.entryPrice
      });
    }
  }

  if (autoFix && !dryRun && !remoteError) {
    reconciliationLog('RECONCILIATION_AUTOFIX_STARTED', { mismatchesCount: mismatches.length });
    for (const mismatch of mismatches) {
      if (mismatch.reason === 'missing_remote' && mismatch.local) {
        updatePositionMetadata(mismatch.local.id, { reconciliationIssue: 'missing_remote' } as never);
        reconciliationLog('LOCAL_POSITION_MARKED_MISSING_REMOTE', {
          symbol: mismatch.symbol,
          positionId: mismatch.local.id
        });
      }

      if (mismatch.reason === 'missing_local' && mismatch.remote) {
        const persisted = await loadOpenPositions();
        const persistedPosition = persisted.positions.find((position: VirtualPosition) => getPositionKey(position) === getPositionKey(mismatch.remote!));
        if (persistedPosition) {
          const restored = buildRestoredPosition({
            ...persistedPosition,
            marketId: mismatch.remote.marketId,
            quantity: mismatch.remote.quantity,
            entryPrice: mismatch.remote.entryPrice,
            side: mismatch.remote.side
          });
          if (!restored.ok) {
            reconciliationError('LOCAL_POSITION_RESTORE_FAILED', restored.message, { symbol: mismatch.symbol, marketId: mismatch.remote.marketId });
            throw new Error(`Failed to restore ${mismatch.remote.symbol}: ${restored.message}`);
          }
          reconciliationLog('LOCAL_POSITION_RESTORED', { symbol: mismatch.symbol, marketId: mismatch.remote.marketId, quantity: mismatch.remote.quantity });
        } else {
          reconciliationLog('LOCAL_POSITION_RESTORE_SKIPPED', { symbol: mismatch.symbol, reason: 'no persisted state' });
        }
      }
    }
    reconciliationLog('RECONCILIATION_AUTOFIX_FINISHED', { mismatchesCount: mismatches.length });
  }

  const result = {
    ok: mismatches.length === 0 && remoteError == null,
    localPositions,
    remotePositions,
    mismatches,
    error: remoteError
  };

  reconciliationLog('RECONCILIATION_FINISHED', {
    accountIndex,
    ok: result.ok,
    mismatches: mismatches.length,
    error: remoteError ?? null
  });
  return result;
}

export async function restoreStateAfterRestart(
  signerClient: SignerClient,
  accountIndex: number
): Promise<{ restored: number; closed: number; errors: number }> {
  reconciliationLog('RESTORE_AFTER_RESTART_STARTED', { accountIndex });

  const persisted = await loadOpenPositions();
  const result = await reconcileAccount(signerClient, accountIndex, { autoFix: true, dryRun: false });
  if (result.error) {
    reconciliationError('RESTORE_AFTER_RESTART_FAILED', result.error, { accountIndex });
    return { restored: 0, closed: 0, errors: 1 };
  }

  let restored = 0;
  let errors = 0;
  for (const mismatch of result.mismatches) {
    if (mismatch.reason === 'missing_local' && mismatch.remote) {
      const exists = persisted.positions.some((position: VirtualPosition) => getPositionKey(position) === getPositionKey(mismatch.remote!));
      if (exists) restored++; else errors++;
    } else if (mismatch.reason !== 'missing_remote') {
      errors++;
    }
  }

  reconciliationLog('RESTORE_AFTER_RESTART_FINISHED', { accountIndex, restored, errors });
  return { restored, closed: 0, errors };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function verifyPositionAfterFill(
  signerClient: SignerClient,
  accountIndex: number,
  marketId: number,
  symbol: string,
  expectedSide: 'long' | 'short',
  expectedQuantity: number
): Promise<{ ok: boolean; pending?: boolean; mismatch?: string }> {
  reconciliationLog('VERIFY_POSITION_AFTER_FILL_STARTED', { accountIndex, marketId, symbol, expectedSide, expectedQuantity });

  let lastMismatch = `Position ${symbol} not found on exchange after fill`;

  for (let attempt = 0; attempt < VERIFY_RETRY_DELAYS_MS.length; attempt++) {
    const delay = VERIFY_RETRY_DELAYS_MS[attempt];
    if (delay > 0) {
      reconciliationLog('VERIFY_POSITION_AFTER_FILL_RETRY', { symbol, marketId, attempt, delayMs: delay });
      await sleep(delay);
    }

    let remotePositions: LighterPosition[];
    try {
      remotePositions = await fetchAccountPositions(signerClient, accountIndex);
    } catch (error) {
      lastMismatch = error instanceof Error ? error.message : 'Remote account request failed';
      reconciliationError('VERIFY_POSITION_AFTER_FILL_FETCH_FAILED', error, { accountIndex, marketId, symbol, attempt });
      continue;
    }

    const remote = remotePositions.find(position => position.marketId === marketId)
      ?? remotePositions.find(position => normalizeSymbol(position.symbol) === normalizeSymbol(symbol));

    if (!remote) {
      reconciliationLog('VERIFY_POSITION_AFTER_FILL_NOT_FOUND', { symbol, marketId, attempt });
      continue;
    }

    if (remote.side !== expectedSide) {
      lastMismatch = `Side mismatch for ${symbol}: expected=${expectedSide}, remote=${remote.side}`;
      reconciliationLog('VERIFY_POSITION_AFTER_FILL_SIDE_MISMATCH', { symbol, marketId, attempt, expectedSide, remoteSide: remote.side });
      continue;
    }

    const tolerance = Math.max(expectedQuantity * 0.02, 1e-12);
    if (Math.abs(remote.quantity - expectedQuantity) > tolerance) {
      lastMismatch = `Quantity mismatch for ${symbol}: expected=${expectedQuantity}, remote=${remote.quantity}`;
      reconciliationLog('VERIFY_POSITION_AFTER_FILL_QUANTITY_MISMATCH', { symbol, marketId, attempt, expectedQuantity, remoteQuantity: remote.quantity });
      continue;
    }

    reconciliationLog('VERIFY_POSITION_AFTER_FILL_CONFIRMED', { symbol, marketId, attempt, remoteQuantity: remote.quantity, remoteEntryPrice: remote.entryPrice });
    return { ok: true };
  }

  reconciliationError('VERIFY_POSITION_AFTER_FILL_FAILED', lastMismatch, { symbol, marketId, expectedSide, expectedQuantity });
  return { ok: false, pending: true, mismatch: lastMismatch };
}

export async function syncLiveBalance(
  signerClient: SignerClient,
  accountIndex: number
): Promise<void> {
  //reconciliationLog('BALANCE_SYNC_STARTED', { accountIndex });

  const url = new URL(`${LIGHTER_API_URL}/api/v1/account`);
  url.searchParams.set('by', 'index');
  url.searchParams.set('value', String(accountIndex));

  const apiKeyIndex = Number(process.env.LIGHTER_API_KEY_INDEX ?? 0);
  const authToken = createAuthToken(signerClient, apiKeyIndex);
  const data = await fetchJson(url, `syncLiveBalance accountIndex=${accountIndex}`, authToken);
  const root = getRecord(data);
  if (!root) throw new Error('Invalid account response structure');

  const accounts = Array.isArray(root.accounts) ? root.accounts : [];
  const account = (accounts.map(getRecord).find(record =>
    record && (Number(record.index ?? record.account_index) === accountIndex)
  ) ?? getRecord(root.account));

  if (!account) {
    reconciliationLog('BALANCE_SYNC_NO_ACCOUNT', { accountIndex });
    return;
  }

  const balance = toNumber(
    account.collateral ?? account.available_balance ?? account.availableBalance ?? account.balance ?? account.total_asset_value
  );
  if (balance == null || balance < 0) {
    reconciliationError('BALANCE_SYNC_INVALID_VALUE', `Invalid balance: ${balance}`, { accountIndex, balance });
    return;
  }

  updateLiveAccountState({ balance });
  //reconciliationLog('BALANCE_SYNC_FINISHED', { accountIndex, balance });
}
