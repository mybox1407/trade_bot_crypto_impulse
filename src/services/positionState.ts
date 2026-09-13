import {
  MAX_RISK_PER_TRADE,
  STARTING_BALANCE,
  TRADE_FEE_RATE
} from './strategy';

import {
  logPositionOpen,
  logPositionClose,
  logPartialClose
} from './logger';

import {
  notifyPositionOpen,
  notifyPositionClose
} from './telegram';

import {
  saveOpenPositions,
  loadOpenPositions
} from './persistence';

export const POSITION_PERCENT = 0.30;
export const MAX_PARALLEL_POSITIONS = 3;

export type PositionCloseReason =
  | 'take_profit'
  | 'stop_loss'
  | 'manual'
  | 'time_stop'
  | 'breakeven_stop'
  | 'dead_trade_mfe'
  | 'reconciliation_missing_remote'
  | 'reconciliation_severe_mismatch';

export interface VirtualPosition {
  id: string;
  symbol: string;
  marketId?: number;
  side: 'long' | 'short';
  entryPrice: number;
  quantity: number;
  notional: number;
  reservedCapital: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  exchangeStopLossPrice: number;
  exchangeTakeProfitPrice: number;
  exchangeStopLossOrderId?: string;
  exchangeTakeProfitOrderId?: string;
  exchangeStopLossClientOrderIndex?: number;
  exchangeTakeProfitClientOrderIndex?: number;
  entryFee: number;
  openedAt: string;
  executionOrderId?: string;
  clientOrderId?: string;
  metadata?: {
    regime: string;
    macdCrossUp: boolean;
    macdCrossDown: boolean;
    lastRsi: number;
    lastAtr: number;
    adx: number;
    bbWidth: number;
    atrPct: number;
    ema20?: number;
    ema50?: number;
    ema200?: number;
    entryExtensionAtr?: number;
    maxEntryExtensionAtr?: number;
    entryTooExtended?: boolean;
    maxUnrealizedPnL?: number;
    maxUnrealizedPnLPercent?: number;
    worstUnrealizedPnL?: number;
    worstUnrealizedPnLPercent?: number;
    beTriggered?: boolean;
    partialClosed?: boolean;
    trailingActive?: boolean;
    trailingStopPrice?: number;
    reconciliationIssue?: string;
  };
}

export interface ClosedTrade {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  notional: number;
  realizedPnL: number;
  entryFee: number;
  exitFee: number;
  totalFee: number;
  netPnL: number;
  openedAt: string;
  closedAt: string;
  reason: PositionCloseReason;
  executionOrderId?: string;
  clientOrderId?: string;
}

let balance = STARTING_BALANCE;
let reservedCapital = 0;
let currentPositions: VirtualPosition[] = [];
let lastClosedTrade: ClosedTrade | null = null;
let persistenceQueue: Promise<void> = Promise.resolve();
let reconciliationPendingSymbols = new Set<string>();
const openingSymbols = new Set<string>();

function normalizeSymbol(symbol: string): string {
  const value = symbol.trim().toUpperCase();
  return value.endsWith('/USDT') ? value : `${value}/USDT`;
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function createPositionId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isValidLevels(params: {
  side: 'long' | 'short';
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
}): boolean {
  const { side, entryPrice, takeProfitPrice, stopLossPrice } = params;
  if (!isFinitePositive(entryPrice) || !isFinitePositive(takeProfitPrice) || !isFinitePositive(stopLossPrice)) return false;
  return side === 'long'
    ? stopLossPrice < entryPrice && takeProfitPrice > entryPrice
    : stopLossPrice > entryPrice && takeProfitPrice < entryPrice;
}

function calculateReservedCapital(): number {
  return currentPositions.reduce((total, position) => total + position.reservedCapital, 0);
}

function syncReservedCapital(): void {
  reservedCapital = calculateReservedCapital();
  if (!Number.isFinite(reservedCapital) || reservedCapital < 0) {
    throw new Error(`Invalid reserved capital calculated: ${reservedCapital}`);
  }
}

function schedulePersistence(): void {
  const snapshot = getPositions();
  const pendingSymbols = getReconciliationPendingSymbols();
  persistenceQueue = persistenceQueue
    .catch(() => undefined)
    .then(() => saveOpenPositions(snapshot, pendingSymbols))
    .catch(error => {
      console.error(`[${new Date().toISOString()}] Failed to persist position state:`, error);
    });
}

export async function flushPositionPersistence(): Promise<void> {
  await persistenceQueue;
}

export async function loadReconciliationPendingSymbols(): Promise<string[]> {
  const { reconciliationPendingSymbols: pending } = await loadOpenPositions();
  reconciliationPendingSymbols = new Set(pending);
  return pending;
}

export function getReconciliationPendingSymbols(): string[] {
  return [...reconciliationPendingSymbols];
}

export function addReconciliationPendingSymbol(symbol: string): void {
  reconciliationPendingSymbols.add(normalizeSymbol(symbol));
}

export function removeReconciliationPendingSymbol(symbol: string): void {
  reconciliationPendingSymbols.delete(normalizeSymbol(symbol));
}

export function isReconciliationPendingSymbol(symbol: string): boolean {
  return reconciliationPendingSymbols.has(normalizeSymbol(symbol));
}

export function beginPositionOpening(symbol: string): boolean {
  const normalized = normalizeSymbol(symbol);
  if (openingSymbols.has(normalized) || hasOpenPosition(normalized)) return false;
  openingSymbols.add(normalized);
  return true;
}

export function endPositionOpening(symbol: string): void {
  openingSymbols.delete(normalizeSymbol(symbol));
}

export function isPositionOpening(symbol: string): boolean {
  return openingSymbols.has(normalizeSymbol(symbol));
}

export function getBalance(): number { return balance; }

export function setBalance(nextBalance: number): void {
  if (!Number.isFinite(nextBalance) || nextBalance < 0) throw new Error(`Invalid balance: ${nextBalance}`);
  balance = nextBalance;
}

export function getReservedCapital(): number {
  syncReservedCapital();
  return reservedCapital;
}

export function getAvailableBalance(): number {
  syncReservedCapital();
  return Math.max(0, balance - reservedCapital);
}

export function getTotalOpenNotional(): number {
  return currentPositions.reduce((total, position) => total + position.notional, 0);
}

export function getPositions(): VirtualPosition[] {
  return currentPositions.map(position => ({
    ...position,
    metadata: position.metadata ? { ...position.metadata } : undefined
  }));
}

export function getPosition(symbol?: string): VirtualPosition | null {
  if (!symbol) return currentPositions[0] ?? null;
  const normalized = normalizeSymbol(symbol);
  return currentPositions.find(position => normalizeSymbol(position.symbol) === normalized) ?? null;
}

export function getPositionById(positionId: string): VirtualPosition | null {
  return currentPositions.find(position => position.id === positionId) ?? null;
}

export function hasOpenPosition(symbol?: string): boolean {
  if (!symbol) return currentPositions.length > 0;
  const normalized = normalizeSymbol(symbol);
  return currentPositions.some(position => normalizeSymbol(position.symbol) === normalized);
}

export function getLastClosedTrade(): ClosedTrade | null { return lastClosedTrade; }

export function getPositionNotional(): number { return getAvailableBalance() * POSITION_PERCENT; }
export function getRiskCapital(): number { return balance * MAX_RISK_PER_TRADE; }
export function getOpenPositionsCount(): number { return currentPositions.length; }

export function openPosition(data: {
  symbol: string;
  marketId?: number;
  side: 'long' | 'short';
  entryPrice: number;
  quantity: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  exchangeStopLossPrice?: number;
  exchangeTakeProfitPrice?: number;
  exchangeStopLossOrderId?: string;
  exchangeTakeProfitOrderId?: string;
  exchangeStopLossClientOrderIndex?: number;
  exchangeTakeProfitClientOrderIndex?: number;
  metadata?: VirtualPosition['metadata'];
  executionOrderId?: string;
  clientOrderId?: string;
}) {
  const normalizedSymbol = normalizeSymbol(data.symbol);
  const balanceBefore = balance;
  const reservedCapitalBefore = reservedCapital;
  const availableBalanceBefore = getAvailableBalance();

  const fail = (message: string) => ({
    ok: false as const,
    message,
    positions: getPositions(),
    balanceBefore,
    balanceAfter: balance,
    reservedCapitalBefore,
    reservedCapitalAfter: reservedCapital,
    availableBalanceBefore,
    availableBalanceAfter: getAvailableBalance()
  });

  if (currentPositions.length >= MAX_PARALLEL_POSITIONS) return fail(`Max ${MAX_PARALLEL_POSITIONS} open positions reached`);
  if (hasOpenPosition(normalizedSymbol)) return fail(`Position for ${normalizedSymbol} is already open`);
  if (isPositionOpening(normalizedSymbol)) return fail(`Position opening already in progress for ${normalizedSymbol}`);
  if (data.marketId != null && (!Number.isInteger(data.marketId) || data.marketId < 0)) return fail(`Invalid marketId: ${data.marketId}`);
  if (!isValidLevels({ side: data.side, entryPrice: data.entryPrice, takeProfitPrice: data.takeProfitPrice, stopLossPrice: data.stopLossPrice })) return fail('Invalid entry / stop / take-profit levels');
  if (!isFinitePositive(data.quantity)) return fail('Invalid quantity');

  const exchangeStopLossPrice = data.exchangeStopLossPrice ?? data.stopLossPrice;
  const exchangeTakeProfitPrice = data.exchangeTakeProfitPrice ?? data.takeProfitPrice;
  if (!isValidLevels({ side: data.side, entryPrice: data.entryPrice, takeProfitPrice: exchangeTakeProfitPrice, stopLossPrice: exchangeStopLossPrice })) return fail('Invalid exchange SL/TP levels');

  const notional = data.quantity * data.entryPrice;
  const entryFee = notional * TRADE_FEE_RATE;
  if (!isFinitePositive(notional) || !Number.isFinite(entryFee)) return fail('Calculated notional or fee is invalid');
  if (notional > availableBalanceBefore) return fail('Insufficient available balance to reserve position notional');

  const position: VirtualPosition = {
    id: createPositionId(),
    symbol: normalizedSymbol,
    marketId: data.marketId,
    side: data.side,
    entryPrice: data.entryPrice,
    quantity: data.quantity,
    notional,
    reservedCapital: notional,
    takeProfitPrice: data.takeProfitPrice,
    stopLossPrice: data.stopLossPrice,
    exchangeStopLossPrice,
    exchangeTakeProfitPrice,
    exchangeStopLossOrderId: data.exchangeStopLossOrderId,
    exchangeTakeProfitOrderId: data.exchangeTakeProfitOrderId,
    exchangeStopLossClientOrderIndex: data.exchangeStopLossClientOrderIndex,
    exchangeTakeProfitClientOrderIndex: data.exchangeTakeProfitClientOrderIndex,
    entryFee,
    openedAt: new Date().toISOString(),
    executionOrderId: data.executionOrderId,
    clientOrderId: data.clientOrderId,
    metadata: data.metadata
  };

  currentPositions = [...currentPositions, position];
  syncReservedCapital();
  schedulePersistence();

  logPositionOpen({
    timestamp: new Date().toISOString(),
    positionId: position.id,
    symbol: position.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    quantity: position.quantity,
    notional: position.notional,
    takeProfitPrice: position.takeProfitPrice,
    stopLossPrice: position.stopLossPrice,
    entryFee: position.entryFee,
    balanceBefore,
    balanceAfter: balance,
    riskCapital: getRiskCapital(),
    maxNotionalByPercent: getPositionNotional(),
    stopDistance: data.side === 'long' ? data.entryPrice - data.stopLossPrice : data.stopLossPrice - data.entryPrice,
    totalRiskPerUnit: 0,
    calculatedQuantity: data.quantity,
    regime: data.metadata?.regime ?? '',
    macdCrossUp: data.metadata?.macdCrossUp ?? false,
    macdCrossDown: data.metadata?.macdCrossDown ?? false,
    lastRsi: data.metadata?.lastRsi ?? 0,
    lastAtr: data.metadata?.lastAtr ?? 0,
    adx: data.metadata?.adx ?? 0,
    bbWidth: data.metadata?.bbWidth ?? 0,
    atrPct: data.metadata?.atrPct ?? 0,
    ema20: data.metadata?.ema20 ?? 0,
    ema50: data.metadata?.ema50 ?? 0,
    ema200: data.metadata?.ema200 ?? 0,
    entryDistanceFromEma20: 0,
    entryDistanceFromEma20Percent: 0,
    entryDistanceFromEma20Atr: data.metadata?.entryExtensionAtr ?? 0,
    entryTooExtended: data.metadata?.entryTooExtended ?? false
  });

  notifyPositionOpen({
    symbol: position.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    quantity: position.quantity,
    notional: position.notional,
    takeProfitPrice: position.takeProfitPrice,
    stopLossPrice: position.stopLossPrice,
    positionId: position.id,
    regime: data.metadata?.regime ?? '',
    balance
  });

  return {
    ok: true as const,
    balance,
    position,
    positions: getPositions(),
    balanceBefore,
    balanceAfter: balance,
    reservedCapitalBefore,
    reservedCapitalAfter: reservedCapital,
    availableBalanceBefore,
    availableBalanceAfter: getAvailableBalance()
  };
}

export function closePosition(positionId: string, exitPrice: number, reason: PositionCloseReason, options?: { executionOrderId?: string; clientOrderId?: string; fee?: number }) {
  const index = currentPositions.findIndex(position => position.id === positionId);
  if (index === -1) return { ok: false as const, message: 'No open position' };
  if (!isFinitePositive(exitPrice)) return { ok: false as const, message: 'Invalid exit price' };

  const position = currentPositions[index];
  const balanceBefore = balance;
  const reservedCapitalBefore = reservedCapital;
  const availableBalanceBefore = getAvailableBalance();
  const realizedPnL = position.side === 'long' ? (exitPrice - position.entryPrice) * position.quantity : (position.entryPrice - exitPrice) * position.quantity;
  const exitFee = options?.fee ?? exitPrice * position.quantity * TRADE_FEE_RATE;
  if (!Number.isFinite(exitFee) || exitFee < 0) return { ok: false as const, message: 'Invalid exit fee' };

  const netPnL = realizedPnL - exitFee - position.entryFee;
  const closedAt = new Date().toISOString();
  const openedAtMs = new Date(position.openedAt).getTime();
  const positionAgeSeconds = Math.max(0, Math.floor((Date.now() - openedAtMs) / 1000));

  lastClosedTrade = {
    id: position.id,
    symbol: position.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    quantity: position.quantity,
    notional: position.notional,
    realizedPnL,
    entryFee: position.entryFee,
    exitFee,
    totalFee: position.entryFee + exitFee,
    netPnL,
    openedAt: position.openedAt,
    closedAt,
    reason,
    executionOrderId: options?.executionOrderId ?? position.executionOrderId,
    clientOrderId: options?.clientOrderId ?? position.clientOrderId
  };

  currentPositions = currentPositions.filter(openPosition => openPosition.id !== positionId);
  syncReservedCapital();
  balance += netPnL;
  schedulePersistence();

  logPositionClose({
    timestamp: closedAt,
    positionId: position.id,
    symbol: position.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    quantity: position.quantity,
    notional: position.notional,
    realizedPnL,
    realizedPnLPercent: position.notional > 0 ? realizedPnL / position.notional * 100 : 0,
    entryFee: position.entryFee,
    exitFee,
    totalFee: position.entryFee + exitFee,
    netPnL,
    netPnLPercent: position.notional > 0 ? netPnL / position.notional * 100 : 0,
    balanceBefore,
    balanceAfter: balance,
    reason,
    positionAgeSeconds,
    openedAt: position.openedAt,
    closedAt,
    maxUnrealizedPnL: position.metadata?.maxUnrealizedPnL,
    maxUnrealizedPnLPercent: position.metadata?.maxUnrealizedPnLPercent,
    worstUnrealizedPnL: position.metadata?.worstUnrealizedPnL,
    worstUnrealizedPnLPercent: position.metadata?.worstUnrealizedPnLPercent,
    beTriggered: position.metadata?.beTriggered ?? false,
    partialClosed: position.metadata?.partialClosed ?? false,
    trailingActive: position.metadata?.trailingActive ?? false,
    trailingStopPrice: position.metadata?.trailingStopPrice
  });

  notifyPositionClose({
    symbol: position.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    quantity: position.quantity,
    notional: position.notional,
    realizedPnL,
    netPnL,
    netPnLPercent: position.notional > 0 ? netPnL / position.notional * 100 : 0,
    reason,
    positionAgeSeconds,
    balance,
    positionId: position.id
  });

  return {
    ok: true as const,
    balance,
    lastClosedTrade,
    positions: getPositions(),
    balanceBefore,
    balanceAfter: balance,
    reservedCapitalBefore,
    reservedCapitalAfter: reservedCapital,
    availableBalanceBefore,
    availableBalanceAfter: getAvailableBalance()
  };
}

export function partialClosePosition(positionId: string, quantityToClose: number, exitPrice: number, options?: { executionOrderId?: string; clientOrderId?: string; fee?: number }): { ok: true; realizedPnL: number; position: VirtualPosition } | { ok: false; message: string } {
  const index = currentPositions.findIndex(position => position.id === positionId);
  if (index === -1) return { ok: false, message: 'No open position' };
  if (!isFinitePositive(exitPrice)) return { ok: false, message: 'Invalid exit price' };
  const position = currentPositions[index];
  if (!isFinitePositive(quantityToClose) || quantityToClose >= position.quantity) return { ok: false, message: 'Invalid quantity for partial close' };

  const exitFee = options?.fee ?? exitPrice * quantityToClose * TRADE_FEE_RATE;
  if (!Number.isFinite(exitFee) || exitFee < 0) return { ok: false, message: 'Invalid partial close fee' };

  const realizedPnL = position.side === 'long' ? (exitPrice - position.entryPrice) * quantityToClose : (position.entryPrice - exitPrice) * quantityToClose;
  const proportionalEntryFee = position.entryFee * quantityToClose / position.quantity;
  const netPnL = realizedPnL - exitFee - proportionalEntryFee;
  const newQuantity = position.quantity - quantityToClose;
  const newNotional = newQuantity * position.entryPrice;
  const updatedPosition: VirtualPosition = {
    ...position,
    quantity: newQuantity,
    notional: newNotional,
    reservedCapital: newNotional,
    entryFee: Math.max(0, position.entryFee - proportionalEntryFee)
  };

  currentPositions = currentPositions.map(current => current.id === positionId ? updatedPosition : current);
  balance += netPnL;
  syncReservedCapital();
  schedulePersistence();

  logPartialClose({
    timestamp: new Date().toISOString(),
    positionId: position.id,
    symbol: position.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    quantity: quantityToClose,
    remainingQuantity: newQuantity,
    originalNotional: position.notional,
    remainingNotional: newNotional,
    realizedPnL,
    realizedPnLPercent: position.notional > 0 ? realizedPnL / position.notional * 100 : 0,
    entryFee: proportionalEntryFee,
    exitFee,
    totalFee: proportionalEntryFee + exitFee,
    netPnL,
    netPnLPercent: position.notional > 0 ? netPnL / position.notional * 100 : 0,
    balanceBefore: balance - netPnL,
    balanceAfter: balance,
    executionOrderId: options?.executionOrderId,
    clientOrderId: options?.clientOrderId
  });

  return { ok: true, realizedPnL: netPnL, position: { ...updatedPosition, metadata: updatedPosition.metadata ? { ...updatedPosition.metadata } : undefined } };
}

export function updatePositionMetadata(positionId: string, updates: Partial<NonNullable<VirtualPosition['metadata']>>): boolean {
  if (!currentPositions.some(position => position.id === positionId)) return false;
  currentPositions = currentPositions.map(position => position.id === positionId ? { ...position, metadata: { ...(position.metadata ?? {}), ...updates } as NonNullable<VirtualPosition['metadata']> } : position);
  schedulePersistence();
  return true;
}

export function updatePositionStopLoss(positionId: string, newStopLossPrice: number): boolean {
  if (!isFinitePositive(newStopLossPrice)) return false;
  if (!currentPositions.some(position => position.id === positionId)) return false;
  currentPositions = currentPositions.map(position => position.id === positionId ? { ...position, stopLossPrice: newStopLossPrice } : position);
  schedulePersistence();
  return true;
}
