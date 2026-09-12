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

export const POSITION_PERCENT = 0.30;
export const MAX_PARALLEL_POSITIONS = 3;

export type PositionCloseReason =
  | 'take_profit'
  | 'stop_loss'
  | 'manual'
  | 'time_stop'
  | 'breakeven_stop'
  | 'dead_trade_mfe';

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

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function normalizeSymbol(symbol: string): string {
  const value = symbol.trim().toUpperCase();

  return value.endsWith('/USDT')
    ? value
    : `${value}/USDT`;
}

function createPositionId(): string {
  return typeof crypto !== 'undefined' &&
    'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
}

function isValidLevels(params: {
  side: 'long' | 'short';
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
}): boolean {
  const {
    side,
    entryPrice,
    takeProfitPrice,
    stopLossPrice
  } = params;

  if (
    !isFinitePositive(entryPrice) ||
    !isFinitePositive(takeProfitPrice) ||
    !isFinitePositive(stopLossPrice)
  ) {
    return false;
  }

  if (side === 'long') {
    return (
      stopLossPrice < entryPrice &&
      takeProfitPrice > entryPrice
    );
  }

  return (
    stopLossPrice > entryPrice &&
    takeProfitPrice < entryPrice
  );
}

function calculateReservedCapital(): number {
  return currentPositions.reduce(
    (total, position) =>
      total + position.reservedCapital,
    0
  );
}

function syncReservedCapital(): void {
  reservedCapital = calculateReservedCapital();

  if (
    !Number.isFinite(reservedCapital) ||
    reservedCapital < 0
  ) {
    throw new Error(
      `Invalid reserved capital calculated: ${reservedCapital}`
    );
  }
}

export function getBalance(): number {
  return balance;
}

export function getReservedCapital(): number {
  syncReservedCapital();
  return reservedCapital;
}

export function getAvailableBalance(): number {
  syncReservedCapital();

  return Math.max(
    0,
    balance - reservedCapital
  );
}

export function getTotalOpenNotional(): number {
  return currentPositions.reduce(
    (total, position) =>
      total + position.notional,
    0
  );
}

export function getPositions(): VirtualPosition[] {
  return currentPositions.map(position => ({
    ...position,
    metadata: position.metadata
      ? { ...position.metadata }
      : undefined
  }));
}

export function getPosition(
  symbol?: string
): VirtualPosition | null {
  if (symbol) {
    const normalized = normalizeSymbol(symbol);

    return (
      currentPositions.find(
        position =>
          normalizeSymbol(position.symbol) === normalized
      ) ?? null
    );
  }

  return currentPositions[0] ?? null;
}

export function getPositionById(
  positionId: string
): VirtualPosition | null {
  return (
    currentPositions.find(
      position => position.id === positionId
    ) ?? null
  );
}

export function hasOpenPosition(
  symbol?: string
): boolean {
  if (!symbol) {
    return currentPositions.length > 0;
  }

  const normalized = normalizeSymbol(symbol);

  return currentPositions.some(
    position =>
      normalizeSymbol(position.symbol) === normalized
  );
}

export function getLastClosedTrade(): ClosedTrade | null {
  return lastClosedTrade;
}

export function getPositionNotional(): number {
  return getAvailableBalance() * POSITION_PERCENT;
}

export function getRiskCapital(): number {
  return balance * MAX_RISK_PER_TRADE;
}

export function getOpenPositionsCount(): number {
  return currentPositions.length;
}

export function openPosition(data: {
  symbol: string;
  marketId?: number;
  side: 'long' | 'short';
  entryPrice: number;
  quantity: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  metadata?: VirtualPosition['metadata'];
  executionOrderId?: string;
  clientOrderId?: string;
}) {
  const normalizedSymbol = normalizeSymbol(data.symbol);

  const balanceBefore = balance;
  const reservedCapitalBefore = reservedCapital;
  const availableBalanceBefore = getAvailableBalance();

  if (currentPositions.length >= MAX_PARALLEL_POSITIONS) {
    return {
      ok: false as const,
      message: `Max ${MAX_PARALLEL_POSITIONS} open positions reached`,
      positions: getPositions(),
      balanceBefore,
      balanceAfter: balance,
      reservedCapitalBefore,
      reservedCapitalAfter: reservedCapital,
      availableBalanceBefore,
      availableBalanceAfter: getAvailableBalance()
    };
  }

  if (hasOpenPosition(normalizedSymbol)) {
    return {
      ok: false as const,
      message: `Position for ${normalizedSymbol} is already open`,
      positions: getPositions(),
      balanceBefore,
      balanceAfter: balance,
      reservedCapitalBefore,
      reservedCapitalAfter: reservedCapital,
      availableBalanceBefore,
      availableBalanceAfter: getAvailableBalance()
    };
  }

  if (
    data.marketId != null &&
    (!Number.isInteger(data.marketId) ||
      data.marketId < 0)
  ) {
    return {
      ok: false as const,
      message: `Invalid marketId: ${data.marketId}`,
      balanceBefore,
      balanceAfter: balance,
      reservedCapitalBefore,
      reservedCapitalAfter: reservedCapital,
      availableBalanceBefore,
      availableBalanceAfter: getAvailableBalance()
    };
  }

  if (
    !isValidLevels({
      side: data.side,
      entryPrice: data.entryPrice,
      takeProfitPrice: data.takeProfitPrice,
      stopLossPrice: data.stopLossPrice
    })
  ) {
    return {
      ok: false as const,
      message: 'Invalid entry / stop / take-profit levels',
      balanceBefore,
      balanceAfter: balance,
      reservedCapitalBefore,
      reservedCapitalAfter: reservedCapital,
      availableBalanceBefore,
      availableBalanceAfter: getAvailableBalance()
    };
  }

  if (!isFinitePositive(data.quantity)) {
    return {
      ok: false as const,
      message: 'Invalid quantity',
      balanceBefore,
      balanceAfter: balance,
      reservedCapitalBefore,
      reservedCapitalAfter: reservedCapital,
      availableBalanceBefore,
      availableBalanceAfter: getAvailableBalance()
    };
  }

  const notional = data.quantity * data.entryPrice;
  const entryFee = notional * TRADE_FEE_RATE;

  if (
    !isFinitePositive(notional) ||
    !Number.isFinite(entryFee)
  ) {
    return {
      ok: false as const,
      message: 'Calculated notional or fee is invalid',
      balanceBefore,
      balanceAfter: balance,
      reservedCapitalBefore,
      reservedCapitalAfter: reservedCapital,
      availableBalanceBefore,
      availableBalanceAfter: getAvailableBalance()
    };
  }

  if (notional > availableBalanceBefore) {
    return {
      ok: false as const,
      message:
        'Insufficient available balance to reserve position notional',
      balanceBefore,
      balanceAfter: balance,
      reservedCapitalBefore,
      reservedCapitalAfter,
      availableBalanceBefore,
      availableBalanceAfter: getAvailableBalance()
    };
  }

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
    entryFee,
    openedAt: new Date().toISOString(),
    executionOrderId: data.executionOrderId,
    clientOrderId: data.clientOrderId,
    metadata: data.metadata
  };

  currentPositions = [
    ...currentPositions,
    position
  ];

  syncReservedCapital();

  const availableBalanceAfter = getAvailableBalance();

  const entryExtensionAtr =
    data.metadata?.entryExtensionAtr ?? 0;

  const entryDistanceFromEma20 =
    data.metadata?.ema20 != null
      ? data.side === 'long'
        ? data.entryPrice - data.metadata.ema20
        : data.metadata.ema20 - data.entryPrice
      : 0;

  const entryDistanceFromEma20Percent =
    data.metadata?.ema20 != null &&
    data.metadata.ema20 > 0
      ? (entryDistanceFromEma20 /
          data.metadata.ema20) *
        100
      : 0;

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
    stopDistance:
      data.side === 'long'
        ? data.entryPrice - data.stopLossPrice
        : data.stopLossPrice - data.entryPrice,
    totalRiskPerUnit: 0,
    calculatedQuantity: data.quantity,
    regime: data.metadata?.regime ?? '',
    macdCrossUp: data.metadata?.macdCrossUp ?? false,
    macdCrossDown:
      data.metadata?.macdCrossDown ?? false,
    lastRsi: data.metadata?.lastRsi ?? 0,
    lastAtr: data.metadata?.lastAtr ?? 0,
    adx: data.metadata?.adx ?? 0,
    bbWidth: data.metadata?.bbWidth ?? 0,
    atrPct: data.metadata?.atrPct ?? 0,
    ema20: data.metadata?.ema20 ?? 0,
    ema50: data.metadata?.ema50 ?? 0,
    ema200: data.metadata?.ema200 ?? 0,
    entryDistanceFromEma20,
    entryDistanceFromEma20Percent,
    entryDistanceFromEma20Atr: entryExtensionAtr,
    entryTooExtended:
      data.metadata?.entryTooExtended ?? false
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
    availableBalanceAfter
  };
}

export function closePosition(
  positionId: string,
  exitPrice: number,
  reason:
    | 'take_profit'
    | 'stop_loss'
    | 'manual'
    | 'time_stop'
    | 'breakeven_stop'
    | 'dead_trade_mfe'
    | 'reconciliation_missing_remote'
    | 'reconciliation_severe_mismatch',
  options?: {
    executionOrderId?: string;
    clientOrderId?: string;
    fee?: number;
  }
) {
  const index = currentPositions.findIndex(
    position => position.id === positionId
  );

  if (index === -1) {
    return {
      ok: false as const,
      message: 'No open position'
    };
  }

  if (!isFinitePositive(exitPrice)) {
    return {
      ok: false as const,
      message: 'Invalid exit price'
    };
  }

  const position = currentPositions[index];

  const balanceBefore = balance;
  const reservedCapitalBefore = reservedCapital;
  const availableBalanceBefore = getAvailableBalance();

  const realizedPnL =
    position.side === 'long'
      ? (exitPrice - position.entryPrice) *
        position.quantity
      : (position.entryPrice - exitPrice) *
        position.quantity;

  const realizedPnLPercent =
    position.notional > 0
      ? (realizedPnL / position.notional) * 100
      : 0;

  const exitFee =
    options?.fee ??
    exitPrice *
      position.quantity *
      TRADE_FEE_RATE;

  if (!Number.isFinite(exitFee) || exitFee < 0) {
    return {
      ok: false as const,
      message: 'Invalid exit fee'
    };
  }

  const netPnL =
    realizedPnL -
    exitFee -
    position.entryFee;

  const netPnLPercent =
    position.notional > 0
      ? (netPnL / position.notional) * 100
      : 0;

  const openedAtMs =
    new Date(position.openedAt).getTime();

  const closedAtMs = Date.now();
  const closedAt =
    new Date(closedAtMs).toISOString();

  const positionAgeSeconds = Math.max(
    0,
    Math.floor(
      (closedAtMs - openedAtMs) / 1000
    )
  );

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
    totalFee:
      position.entryFee + exitFee,
    netPnL,
    openedAt: position.openedAt,
    closedAt,
    reason: reason as any,
    executionOrderId:
      options?.executionOrderId ??
      position.executionOrderId,
    clientOrderId:
      options?.clientOrderId ??
      position.clientOrderId
  };

  currentPositions = currentPositions.filter(
    openPosition =>
      openPosition.id !== positionId
  );

  syncReservedCapital();

  balance += netPnL;

  const availableBalanceAfter = getAvailableBalance();

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
    realizedPnLPercent,
    entryFee: position.entryFee,
    exitFee,
    totalFee:
      position.entryFee + exitFee,
    netPnL,
    netPnLPercent,
    balanceBefore,
    balanceAfter: balance,
    reason,
    positionAgeSeconds,
    openedAt: position.openedAt,
    closedAt,
    maxUnrealizedPnL:
      position.metadata?.maxUnrealizedPnL,
    maxUnrealizedPnLPercent:
      position.metadata?.maxUnrealizedPnLPercent,
    worstUnrealizedPnL:
      position.metadata?.worstUnrealizedPnL,
    worstUnrealizedPnLPercent:
      position.metadata?.worstUnrealizedPnLPercent,
    beTriggered:
      position.metadata?.beTriggered ?? false,
    partialClosed:
      position.metadata?.partialClosed ?? false,
    trailingActive:
      position.metadata?.trailingActive ?? false,
    trailingStopPrice:
      position.metadata?.trailingStopPrice
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
    netPnLPercent,
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
    availableBalanceAfter
  };
}

export function partialClosePosition(
  positionId: string,
  quantityToClose: number,
  exitPrice: number,
  options?: {
    executionOrderId?: string;
    clientOrderId?: string;
    fee?: number;
  }
): { ok: true; realizedPnL: number; position: VirtualPosition } | {
  ok: false;
  message: string;
} {
  const index = currentPositions.findIndex(
    position => position.id === positionId
  );

  if (index === -1) {
    return { ok: false, message: 'No open position' };
  }

  if (!isFinitePositive(exitPrice)) {
    return { ok: false, message: 'Invalid exit price' };
  }

  const position = currentPositions[index];

  if (
    !isFinitePositive(quantityToClose) ||
    quantityToClose >= position.quantity
  ) {
    return {
      ok: false,
      message: 'Invalid quantity for partial close'
    };
  }

  const exitFee =
    options?.fee ??
    exitPrice * quantityToClose * TRADE_FEE_RATE;

  if (!Number.isFinite(exitFee) || exitFee < 0) {
    return {
      ok: false,
      message: 'Invalid partial close fee'
    };
  }

  const balanceBefore = balance;

  const realizedPnL =
    position.side === 'long'
      ? (exitPrice - position.entryPrice) * quantityToClose
      : (position.entryPrice - exitPrice) * quantityToClose;

  const realizedPnLPercent =
    position.notional > 0
      ? (realizedPnL / position.notional) * 100
      : 0;

  const proportionalEntryFee =
    position.entryFee * (quantityToClose / position.quantity);

  const netPnL = realizedPnL - exitFee - proportionalEntryFee;

  const oldQuantity = position.quantity;
  const oldNotional = position.notional;

  const newQuantity = oldQuantity - quantityToClose;
  const newNotional = newQuantity * position.entryPrice;

  const newEntryFee =
    Math.max(
      0,
      position.entryFee - proportionalEntryFee
    );

  const updatedPosition: VirtualPosition = {
    ...position,
    quantity: newQuantity,
    notional: newNotional,
    reservedCapital: newNotional,
    entryFee: newEntryFee
  };

  currentPositions = currentPositions.map(
    current =>
      current.id === positionId
        ? updatedPosition
        : current
  );

  balance += netPnL;
  syncReservedCapital();

  logPartialClose({
    timestamp: new Date().toISOString(),
    positionId: position.id,
    symbol: position.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    quantity: quantityToClose,
    remainingQuantity: newQuantity,
    originalNotional: oldNotional,
    remainingNotional: newNotional,
    realizedPnL,
    realizedPnLPercent,
    entryFee: proportionalEntryFee,
    exitFee,
    totalFee: proportionalEntryFee + exitFee,
    netPnL,
    netPnLPercent:
      oldNotional > 0
        ? (netPnL / oldNotional) * 100
        : 0,
    balanceBefore,
    balanceAfter: balance,
    executionOrderId: options?.executionOrderId,
    clientOrderId: options?.clientOrderId
  });

  return {
    ok: true,
    realizedPnL: netPnL,
    position: {
      ...updatedPosition,
      metadata: updatedPosition.metadata
        ? { ...updatedPosition.metadata }
        : undefined
    }
  };
}

export function updatePositionMetadata(
  positionId: string,
  updates: Partial<
    NonNullable<VirtualPosition['metadata']>
  >
): boolean {
  const exists = currentPositions.some(
    position => position.id === positionId
  );

  if (!exists) {
    return false;
  }

  currentPositions = currentPositions.map(
    position => {
      if (position.id !== positionId) {
        return position;
      }

      return {
        ...position,
        metadata: {
          ...(position.metadata ?? {}),
          ...updates
        } as NonNullable<
          VirtualPosition['metadata']
        >
      };
    }
  );

  return true;
}

export function updatePositionStopLoss(
  positionId: string,
  newStopLossPrice: number
): boolean {
  if (!isFinitePositive(newStopLossPrice)) {
    return false;
  }

  const exists = currentPositions.some(
    position => position.id === positionId
  );

  if (!exists) {
    return false;
  }

  currentPositions = currentPositions.map(
    position =>
      position.id === positionId
        ? {
            ...position,
            stopLossPrice: newStopLossPrice
          }
        : position
  );

  return true;
}
