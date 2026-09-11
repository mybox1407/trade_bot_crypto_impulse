import {
  MAX_RISK_PER_TRADE,
  STARTING_BALANCE,
  TRADE_FEE_RATE
} from './strategy';

import { logPositionOpen, logPositionClose } from './logger';
import { notifyPositionOpen, notifyPositionClose } from './telegram';

export const POSITION_PERCENT = 0.30;
export const MAX_PARALLEL_POSITIONS = 3;

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
  reason:
    | 'take_profit'
    | 'stop_loss'
    | 'manual'
    | 'time_stop'
    | 'breakeven_stop'
    | 'dead_trade_mfe';
  executionOrderId?: string;
  clientOrderId?: string;
}

let balance = STARTING_BALANCE;
let reservedCapital = 0;
let currentPositions: VirtualPosition[] = [];
let lastClosedTrade: ClosedTrade | null = null;

function isFinitePositive(value: number) {
  return Number.isFinite(value) && value > 0;
}

function createPositionId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isValidLevels(params: {
  side: 'long' | 'short';
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
}) {
  const { side, entryPrice, takeProfitPrice, stopLossPrice } = params;

  if (
    !isFinitePositive(entryPrice) ||
    !Number.isFinite(takeProfitPrice) ||
    !Number.isFinite(stopLossPrice)
  ) {
    return false;
  }

  if (side === 'long') {
    return stopLossPrice < entryPrice && takeProfitPrice > entryPrice;
  }

  return stopLossPrice > entryPrice && takeProfitPrice < entryPrice;
}

function calculateReservedCapital() {
  return currentPositions.reduce(
    (total, position) => total + position.reservedCapital,
    0
  );
}

export function getBalance() {
  return balance;
}

export function getReservedCapital() {
  return reservedCapital;
}

export function getAvailableBalance() {
  return Math.max(0, balance - reservedCapital);
}

export function getTotalOpenNotional() {
  return currentPositions.reduce(
    (total, position) => total + position.notional,
    0
  );
}

export function getPositions() {
  return [...currentPositions];
}

export function getPosition(symbol?: string) {
  if (symbol) {
    return (
      currentPositions.find(position => position.symbol === symbol) ?? null
    );
  }

  return currentPositions[0] ?? null;
}

export function getPositionById(positionId: string) {
  return (
    currentPositions.find(position => position.id === positionId) ?? null
  );
}

export function hasOpenPosition(symbol?: string) {
  if (!symbol) {
    return currentPositions.length > 0;
  }

  return currentPositions.some(
    position => position.symbol === symbol
  );
}

export function getLastClosedTrade() {
  return lastClosedTrade;
}

export function getPositionNotional() {
  return balance * POSITION_PERCENT;
}

export function getRiskCapital() {
  return balance * MAX_RISK_PER_TRADE;
}

export function getOpenPositionsCount() {
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
  const balanceBefore = balance;
  const reservedCapitalBefore = reservedCapital;
  const availableBalanceBefore = getAvailableBalance();

  if (currentPositions.length >= MAX_PARALLEL_POSITIONS) {
    return {
      ok: false,
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

  if (hasOpenPosition(data.symbol)) {
    return {
      ok: false,
      message: `Position for ${data.symbol} is already open`,
      positions: getPositions(),
      balanceBefore,
      balanceAfter: balance,
      reservedCapitalBefore,
      reservedCapitalAfter: reservedCapital,
      availableBalanceBefore,
      availableBalanceAfter: getAvailableBalance()
    };
  }

  if (!isValidLevels({
    side: data.side,
    entryPrice: data.entryPrice,
    takeProfitPrice: data.takeProfitPrice,
    stopLossPrice: data.stopLossPrice
  })) {
    return {
      ok: false,
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
      ok: false,
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

  if (!isFinitePositive(notional) || !Number.isFinite(entryFee)) {
    return {
      ok: false,
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
      ok: false,
      message: 'Insufficient available balance to reserve position notional',
      balanceBefore,
      balanceAfter: balance,
      reservedCapitalBefore,
      reservedCapitalAfter: reservedCapital,
      availableBalanceBefore,
      availableBalanceAfter: getAvailableBalance()
    };
  }

  reservedCapital += notional;

  const position: VirtualPosition = {
    id: createPositionId(),
    symbol: data.symbol,
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

  currentPositions = [...currentPositions, position];

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
      ? (entryDistanceFromEma20 / data.metadata.ema20) * 100
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
    macdCrossDown: data.metadata?.macdCrossDown ?? false,
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
    ok: true,
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
    | 'dead_trade_mfe',
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
    return { ok: false, message: 'No open position' };
  }

  if (!isFinitePositive(exitPrice)) {
    return { ok: false, message: 'Invalid exit price' };
  }

  const position = currentPositions[index];

  const balanceBefore = balance;
  const reservedCapitalBefore = reservedCapital;
  const availableBalanceBefore = getAvailableBalance();

  const realizedPnL =
    position.side === 'long'
      ? (exitPrice - position.entryPrice) * position.quantity
      : (position.entryPrice - exitPrice) * position.quantity;

  const realizedPnLPercent =
    position.notional > 0
      ? (realizedPnL / position.notional) * 100
      : 0;

  const exitFee = options?.fee ?? (
    exitPrice * position.quantity * TRADE_FEE_RATE
  );

  const netPnL = realizedPnL - exitFee - position.entryFee;

  const netPnLPercent =
    position.notional > 0
      ? (netPnL / position.notional) * 100
      : 0;

  const openedAtMs = new Date(position.openedAt).getTime();
  const closedAtMs = Date.now();
  const closedAt = new Date(closedAtMs).toISOString();

  const positionAgeSeconds = Math.floor(
    (closedAtMs - openedAtMs) / 1000
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
    totalFee: position.entryFee + exitFee,
    netPnL,
    openedAt: position.openedAt,
    closedAt,
    reason,
    executionOrderId: options?.executionOrderId ?? position.executionOrderId,
    clientOrderId: options?.clientOrderId ?? position.clientOrderId
  };

  currentPositions = currentPositions.filter(
    openPosition => openPosition.id !== positionId
  );

  reservedCapital = Math.max(
    0,
    reservedCapital - position.reservedCapital
  );

  reservedCapital = calculateReservedCapital();

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
    totalFee: position.entryFee + exitFee,
    netPnL,
    netPnLPercent,
    balanceBefore,
    balanceAfter: balance,
    reason,
    positionAgeSeconds,
    openedAt: position.openedAt,
    closedAt,

    maxUnrealizedPnL: position.metadata?.maxUnrealizedPnL,
    maxUnrealizedPnLPercent:
      position.metadata?.maxUnrealizedPnLPercent,
    worstUnrealizedPnL: position.metadata?.worstUnrealizedPnL,
    worstUnrealizedPnLPercent:
      position.metadata?.worstUnrealizedPnLPercent,

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
    netPnLPercent,
    reason,
    positionAgeSeconds,
    balance,
    positionId: position.id
  });

  return {
    ok: true,
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

  const realizedPnL =
    position.side === 'long'
      ? (exitPrice - position.entryPrice) * quantityToClose
      : (position.entryPrice - exitPrice) * quantityToClose;

  const exitFee = options?.fee ?? (
    exitPrice * quantityToClose * TRADE_FEE_RATE
  );

  const proportionalEntryFee =
    position.entryFee * (quantityToClose / position.quantity);

  const netPnL = realizedPnL - exitFee - proportionalEntryFee;

  const oldQuantity = position.quantity;
  const oldNotional = position.notional;

  position.quantity -= quantityToClose;

  position.notional = position.quantity * position.entryPrice;
  position.reservedCapital = position.notional;

  position.entryFee -= proportionalEntryFee;

  const closedNotional =
    (quantityToClose / oldQuantity) * oldNotional;

  reservedCapital = Math.max(
    0,
    reservedCapital - closedNotional
  );

  reservedCapital = calculateReservedCapital();

  balance += netPnL;

  return {
    ok: true,
    realizedPnL: netPnL,
    position
  };
}

export function updatePositionMetadata(
  positionId: string,
  updates: Partial<NonNullable<VirtualPosition['metadata']>>
) {
  const exists = currentPositions.some(
    position => position.id === positionId
  );

  if (!exists) {
    return false;
  }

  currentPositions = currentPositions.map(position => {
    if (position.id !== positionId) {
      return position;
    }

    return {
      ...position,
      metadata: {
        ...(position.metadata ?? {}),
        ...updates
      } as NonNullable<VirtualPosition['metadata']>
    };
  });

  return true;
}

export function updatePositionStopLoss(
  positionId: string,
  newStopLossPrice: number
): boolean {
  if (!isFinitePositive(newStopLossPrice)) {
    return false;
  }

  const index = currentPositions.findIndex(
    position => position.id === positionId
  );

  if (index === -1) {
    return false;
  }

  currentPositions[index].stopLossPrice = newStopLossPrice;

  return true;
}
