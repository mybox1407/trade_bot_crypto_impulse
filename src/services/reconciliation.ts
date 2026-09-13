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

  const candidates = [root.account, root.accounts, root.data];
  for (const candidate of candidates) {
    const record = getRecord(candidate);
    if (!record) continue;

    const positions = recordsFromValue(record.positions);
    if (positions.length) return positions;

    for (const account of recordsFromValue(record.accounts)) {
      const nested = recordsFromValue(account.positions);
      if (nested.length) return nested;
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

async function fetchJson(url: URL): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await response.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch {
    throw new Error(`Invalid JSON from Lighter endpoint: ${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    const record = getRecord(data);
    throw new Error(`Lighter request failed (${response.status}): ${String(record?.message ?? record?.error ?? response.statusText)}`);
  }
  const record = getRecord(data);
  if (record?.code != null && Number(record.code) !== 200) {
    throw new Error(`Lighter API error: ${String(record.message ?? record.code)}`);
  }
  return data;
}

export async function fetchAccountPositions(
  _signerClient: SignerClient,
  accountIndex: number
): Promise<LighterPosition[]> {
  if (!Number.isInteger(accountIndex) || accountIndex < 0) {
    throw new Error(`Invalid Lighter account index: ${accountIndex}`);
  }

  const url = new URL(`${LIGHTER_API_URL}/api/v1/account`);
  url.searchParams.set('by', 'index');
  url.searchParams.set('value', String(accountIndex));

  const data = await fetchJson(url);
  return getPositionRecords(data)
    .map(parsePosition)
    .filter((position): position is LighterPosition => position !== null);
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
  const localPositions = getPositions();
  let remotePositions: LighterPosition[] = [];
  let remoteError: string | undefined;

  try {
    remotePositions = await fetchAccountPositions(signerClient, accountIndex);
  } catch (error) {
    remoteError = error instanceof Error ? error.message : 'Unknown error';
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
      continue;
    }
    if (local.side !== remote.side) {
      mismatches.push({ symbol: normalizeSymbol(local.symbol), local, remote, reason: 'side_mismatch' });
      continue;
    }
    if (Math.abs(local.quantity - remote.quantity) > Math.max(local.quantity * 0.01, 1e-12)) {
      mismatches.push({ symbol: normalizeSymbol(local.symbol), local, remote, reason: 'quantity_mismatch' });
      continue;
    }
    if (Math.abs(local.entryPrice - remote.entryPrice) > Math.max(local.entryPrice * 0.01, 1e-12)) {
      mismatches.push({ symbol: normalizeSymbol(local.symbol), local, remote, reason: 'price_mismatch' });
    }
  }

  for (const [key, remote] of remoteByKey) {
    if (!localByKey.has(key)) {
      mismatches.push({ symbol: normalizeSymbol(remote.symbol), remote, reason: 'missing_local' });
    }
  }

  if (options?.autoFix && !options.dryRun && !remoteError) {
    for (const mismatch of mismatches) {
      if (mismatch.reason === 'missing_remote' && mismatch.local) {
        updatePositionMetadata(mismatch.local.id, { reconciliationIssue: 'missing_remote' } as never);
      }

      if (mismatch.reason === 'missing_local' && mismatch.remote) {
        const persisted = await loadOpenPositions();
        const persistedPosition = persisted.find(position => getPositionKey(position) === getPositionKey(mismatch.remote!));
        if (persistedPosition) {
          const restored = buildRestoredPosition({
            ...persistedPosition,
            marketId: mismatch.remote.marketId,
            quantity: mismatch.remote.quantity,
            entryPrice: mismatch.remote.entryPrice,
            side: mismatch.remote.side
          });
          if (!restored.ok) {
            throw new Error(`Failed to restore ${mismatch.remote.symbol}: ${restored.message}`);
          }
        }
      }
    }
  }

  return {
    ok: mismatches.length === 0 && remoteError == null,
    localPositions,
    remotePositions,
    mismatches,
    error: remoteError
  };
}

export async function restoreStateAfterRestart(
  signerClient: SignerClient,
  accountIndex: number
): Promise<{ restored: number; closed: number; errors: number }> {
  const persisted = await loadOpenPositions();
  const result = await reconcileAccount(signerClient, accountIndex, { autoFix: true, dryRun: false });
  if (result.error) return { restored: 0, closed: 0, errors: 1 };

  let restored = 0;
  let errors = 0;
  for (const mismatch of result.mismatches) {
    if (mismatch.reason === 'missing_local' && mismatch.remote) {
      const exists = persisted.some(position => getPositionKey(position) === getPositionKey(mismatch.remote!));
      if (exists) restored++; else errors++;
    } else if (mismatch.reason !== 'missing_remote') {
      errors++;
    }
  }
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
  let lastMismatch = `Position ${symbol} not found on exchange after fill`;

  for (const delay of VERIFY_RETRY_DELAYS_MS) {
    if (delay > 0) await sleep(delay);

    let remotePositions: LighterPosition[];
    try {
      remotePositions = await fetchAccountPositions(signerClient, accountIndex);
    } catch (error) {
      lastMismatch = error instanceof Error ? error.message : 'Remote account request failed';
      continue;
    }

    const remote = remotePositions.find(position => position.marketId === marketId)
      ?? remotePositions.find(position => normalizeSymbol(position.symbol) === normalizeSymbol(symbol));

    if (!remote) continue;

    if (remote.side !== expectedSide) {
      lastMismatch = `Side mismatch for ${symbol}: expected=${expectedSide}, remote=${remote.side}`;
      continue;
    }

    const tolerance = Math.max(expectedQuantity * 0.02, 1e-12);
    if (Math.abs(remote.quantity - expectedQuantity) > tolerance) {
      lastMismatch = `Quantity mismatch for ${symbol}: expected=${expectedQuantity}, remote=${remote.quantity}`;
      continue;
    }

    return { ok: true };
  }

  return { ok: false, pending: true, mismatch: lastMismatch };
}

export async function syncLiveBalance(accountIndex: number): Promise<void> {
  const url = new URL(`${LIGHTER_API_URL}/api/v1/account`);
  url.searchParams.set('by', 'index');
  url.searchParams.set('value', String(accountIndex));
  const data = await fetchJson(url);
  const root = getRecord(data);
  if (!root) throw new Error('Invalid account response structure');

  const accounts = Array.isArray(root.accounts) ? root.accounts : [];
  const account = (accounts.map(getRecord).find(record =>
    record && (Number(record.index ?? record.account_index) === accountIndex)
  ) ?? getRecord(root.account));

  if (!account) return;

  const balance = toNumber(
    account.collateral ?? account.available_balance ?? account.availableBalance ?? account.balance ?? account.total_asset_value
  );
  if (balance == null || balance < 0) return;

  updateLiveAccountState({ balance });
  console.log(`[${new Date().toISOString()}] Balance synced: $${balance.toFixed(2)}`);
}
