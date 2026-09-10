// src/services/positionState.ts
import {
  MAX_RISK_PER_TRADE,
  STARTING_BALANCE,
  TRADE_FEE_RATE
} from './strategy';
import { logPositionOpen, logPositionClose } from './logger';
import { notifyPositionOpen, notifyPositionClose } from './telegram';
import { MexcAuthenticatedClient } from './mexcClient';

export const POSITION_PERCENT = 0.30;
export const MAX_PARALLEL_POSITIONS = 3;

const FUTURES_LEVERAGE = Number(
  process.env.MEXC_FUTURES_LEVERAGE ?? 1
);

const FUTURES_MARGIN_MODE =
  process.env.MEXC_FUTURES_MARGIN_MODE === 'cross'
    ? 'cross'
    : 'isolated';

const FUTURES_POSITION_MODE =
  process.env.MEXC_FUTURES_POSITION_MODE === '2'
    ? 2
    : 1;

type PositionSide = 'long' | 'short';

type CloseReason =
  | 'take_profit'
  | 'stop_loss'
  | 'manual'
  | 'time_stop'
  | 'breakeven_stop'
  | 'dead_trade_mfe';

export interface VirtualPosition {
  id: string;
  symbol: string;
  side: PositionSide;
  entryPrice: number;
  quantity: number;
  notional: number;
  reservedCapital: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  entryFee: number;
  openedAt: string;
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
  side: PositionSide;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  notional: number;
  realizedPnL: number;
  realizedPnLPercent: number;
  entryFee: number;
  exitFee: number;
  totalFee: number;
  netPnL: number;
  netPnLPercent: number;
  openedAt: string;
  closedAt: string;
  positionAgeSeconds: number;
  reason: CloseReason;
}

type OpenPositionInput = {
  symbol: string;
  side: PositionSide;
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  metadata?: VirtualPosition['metadata'];
  riskCapital?: number;
  maxNotionalByPercent?: number;
  stopDistance?: number;
  totalRiskPerUnit?: number;
  calculatedQuantity?: number;
};

type PositionStateResult = {
  ok: boolean;
  message?: string;
  balance?: number;
  position?: VirtualPosition;
  lastClosedTrade?: ClosedTrade;
  positions: VirtualPosition[];
  balanceBefore: number;
  balanceAfter: number;
  reservedCapitalBefore: number;
  reservedCapitalAfter: number;
  availableBalanceBefore: number;
  availableBalanceAfter: number;
};

let balance = STARTING_BALANCE;
let reservedCapital = 0;
let currentPositions: VirtualPosition[] = [];
let lastClosedTrade: ClosedTrade | null = null;

const mexcClient = new MexcAuthenticatedClient();

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isValidFuturesQuantity(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function normalizeSymbol(symbol: string): string {
  const normalized = symbol
    .toUpperCase()
    .replace('/', '_')
    .replace('-', '_');

  if (normalized.includes('_')) {
    return normalized;
  }

  if (normalized.endsWith('USDT')) {
    return `${normalized.slice(0, -4)}_USDT`;
  }

  throw new Error(
    `Invalid Futures symbol "${symbol}". Expected BASE_USDT`
  );
}

function createPositionId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isValidLevels(params: {
  side: PositionSide;
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
    (total, position) => total + position.reservedCapital,
    0
  );
}

function createRejectedResult(
  message: string,
  balanceBefore: number = balance,
  reservedCapitalBefore: number = reservedCapital,
  availableBalanceBefore: number = getAvailableBalance()
): PositionStateResult {
  return {
    ok: false,
    message,
    positions: getPositions(),
    balanceBefore,
    balanceAfter: balance,
    reservedCapitalBefore,
    reservedCapitalAfter: reservedCapital,
    availableBalanceBefore,
    availableBalanceAfter: getAvailableBalance()
  };
}

function getExecutedQuantity(
  requestedQuantity: number,
  executedQuantity: number
): number {
  return isValidFuturesQuantity(executedQuantity)
    ? executedQuantity
    : requestedQuantity;
}

function getExecutedPrice(
  fallbackPrice: number,
  orderPrice: number,
  executedQuoteQty: number,
  executedQty: number
): number {
  if (
    isFinitePositive(executedQuoteQty) &&
    isFinitePositive(executedQty)
  ) {
    return executedQuoteQty / executedQty;
  }

  if (isFinitePositive(orderPrice)) {
    return orderPrice;
  }

  return fallbackPrice;
}

function getPositionType(side: PositionSide): 1 | 2 {
  return side === 'long' ? 1 : 2;
}

export function setBalance(newBalance: number): void {
  if (!Number.isFinite(newBalance) || newBalance <= 0) {
    console.warn(
      `[${new Date().toISOString()}] ⚠️ Invalid balance: ${newBalance}`
    );
    return;
  }

  const oldBalance = balance;
  balance = newBalance;

  console.log(
    `[${new Date().toISOString()}] 💰 Futures balance updated: ` +
      `$${oldBalance.toFixed(2)} → $${balance.toFixed(2)}`
  );
}

export function getBalance(): number {
  return balance;
}

export function getReservedCapital(): number {
  return reservedCapital;
}

export function getAvailableBalance(): number {
  return Math.max(0, balance - reservedCapital);
}

export function getTotalOpenNotional(): number {
  return currentPositions.reduce(
    (total, position) => total + position.notional,
    0
  );
}

export function getPositions(): VirtualPosition[] {
  return [...currentPositions];
}

export function getPosition(
  symbol?: string
): VirtualPosition | null {
  if (symbol) {
    return (
      currentPositions.find(
        position => position.symbol === symbol
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

export function hasOpenPosition(symbol?: string): boolean {
  if (!symbol) {
    return currentPositions.length > 0;
  }

  return currentPositions.some(
    position => position.symbol === symbol
  );
}

export function getLastClosedTrade(): ClosedTrade | null {
  return lastClosedTrade;
}

export function getPositionNotional(): number {
  return balance * POSITION_PERCENT;
}

export function getRiskCapital(): number {
  return balance * MAX_RISK_PER_TRADE;
}

export function getOpenPositionsCount(): number {
  return currentPositions.length;
}

export async function openPosition(
  data: OpenPositionInput
): Promise<PositionStateResult> {
  const balanceBefore = balance;
  const reservedCapitalBefore = reservedCapital;
  const availableBalanceBefore = getAvailableBalance();

  if (
    !Number.isInteger(FUTURES_LEVERAGE) ||
    FUTURES_LEVERAGE < 1 ||
    FUTURES_LEVERAGE > 200
  ) {
    return createRejectedResult(
      `Invalid MEXC_FUTURES_LEVERAGE: ${FUTURES_LEVERAGE}`,
      balanceBefore,
      reservedCapitalBefore,
      availableBalanceBefore
    );
  }

  if (currentPositions.length >= MAX_PARALLEL_POSITIONS) {
    return createRejectedResult(
      `Max ${MAX_PARALLEL_POSITIONS} open positions reached`,
      balanceBefore,
      reservedCapitalBefore,
      availableBalanceBefore
    );
  }

  if (hasOpenPosition(data.symbol)) {
    return createRejectedResult(
      `Position for ${data.symbol} is already open`,
      balanceBefore,
      reservedCapitalBefore,
      availableBalanceBefore
    );
  }

  if (!isValidLevels(data)) {
    return createRejectedResult(
      'Invalid entry / stop / take-profit levels',
      balanceBefore,
      reservedCapitalBefore,
      availableBalanceBefore
    );
  }

  const stopDistance =
    data.stopDistance ??
    Math.abs(data.entryPrice - data.stopLossPrice);

  if (!isFinitePositive(stopDistance)) {
    return createRejectedResult(
      'Invalid stop distance',
      balanceBefore,
      reservedCapitalBefore,
      availableBalanceBefore
    );
  }

  if (!isFinitePositive(availableBalanceBefore)) {
    return createRejectedResult(
      'Insufficient available margin',
      balanceBefore,
      reservedCapitalBefore,
      availableBalanceBefore
    );
  }

  const requestedNotionalByPercent =
    data.maxNotionalByPercent ??
    getPositionNotional();

  const maxNotionalByAvailableBalance = Math.min(
    requestedNotionalByPercent,
    availableBalanceBefore * FUTURES_LEVERAGE
  );

  if (!isFinitePositive(maxNotionalByAvailableBalance)) {
    return createRejectedResult(
      'Calculated Futures notional is invalid',
      balanceBefore,
      reservedCapitalBefore,
      availableBalanceBefore
    );
  }

  const maxQuantityByNotional =
    maxNotionalByAvailableBalance / data.entryPrice;

  const riskCapital =
    data.riskCapital ?? getRiskCapital();

  const worstCaseFeePerUnit =
    (data.entryPrice + data.stopLossPrice) *
    TRADE_FEE_RATE;

  const totalRiskPerUnit =
    data.totalRiskPerUnit ??
    stopDistance + worstCaseFeePerUnit;

  const riskQuantity =
    data.calculatedQuantity ??
    riskCapital / totalRiskPerUnit;

  const quantity = Math.min(
    riskQuantity,
    maxQuantityByNotional
  );

  const notional = quantity * data.entryPrice;
  const initialMargin =
    notional / FUTURES_LEVERAGE;
  const entryFee =
    notional * TRADE_FEE_RATE;

  if (
    !isValidFuturesQuantity(quantity) ||
    !isFinitePositive(notional) ||
    !isFinitePositive(initialMargin) ||
    !Number.isFinite(entryFee)
  ) {
    return createRejectedResult(
      'Calculated Futures position size is invalid',
      balanceBefore,
      reservedCapitalBefore,
      availableBalanceBefore
    );
  }

  if (initialMargin > availableBalanceBefore) {
    return createRejectedResult(
      'Insufficient margin for Futures position',
      balanceBefore,
      reservedCapitalBefore,
      availableBalanceBefore
    );
  }

  try {
    const futuresSymbol = normalizeSymbol(data.symbol);

    // Ожидается, что этот метод только устанавливает плечо.
    // Если в mexcClient.ts он пока заглушка, плечо задайте заранее
    // в интерфейсе MEXC и не отправляйте неподтверждённый endpoint.
    await mexcClient.setFuturesLeverage(
      futuresSymbol,
      FUTURES_LEVERAGE,
      FUTURES_MARGIN_MODE
    );

    console.log(
      `[${new Date().toISOString()}] 🚀 Opening MEXC Futures ` +
        `${data.side.toUpperCase()} ${futuresSymbol} ` +
        `qty=${quantity.toFixed(8)} ` +
        `leverage=${FUTURES_LEVERAGE}x`
    );

    const mexcOrder =
      await mexcClient.openFuturesPosition(
        futuresSymbol,
        data.side,
        quantity,
        FUTURES_LEVERAGE,
        FUTURES_MARGIN_MODE,
        FUTURES_POSITION_MODE
      );

    const actualQuantity = getExecutedQuantity(
      quantity,
      mexcOrder.executedQty
    );

    const actualEntryPrice = getExecutedPrice(
      data.entryPrice,
      mexcOrder.avgPrice || mexcOrder.price,
      mexcOrder.executedQuoteQty,
      actualQuantity
    );

    const actualNotional =
      actualQuantity * actualEntryPrice;

    const actualEntryFee =
      actualNotional * TRADE_FEE_RATE;

    if (
      !isValidFuturesQuantity(actualQuantity) ||
      !isFinitePositive(actualEntryPrice) ||
      !isFinitePositive(actualNotional)
    ) {
      throw new Error(
        `Invalid Futures fill: qty=${mexcOrder.executedQty}, ` +
          `price=${mexcOrder.avgPrice || mexcOrder.price}, ` +
          `quote=${mexcOrder.executedQuoteQty}`
      );
    }

    const marginReserved =
      actualNotional / FUTURES_LEVERAGE;

    reservedCapital += marginReserved;

    const position: VirtualPosition = {
      id: String(
        mexcOrder.orderId || createPositionId()
      ),
      symbol: data.symbol,
      side: data.side,
      entryPrice: actualEntryPrice,
      quantity: actualQuantity,
      notional: actualNotional,
      reservedCapital: marginReserved,
      takeProfitPrice: data.takeProfitPrice,
      stopLossPrice: data.stopLossPrice,
      entryFee: actualEntryFee,
      openedAt: new Date().toISOString(),
      metadata: data.metadata
    };

    currentPositions = [
      ...currentPositions,
      position
    ];

    const entryExtensionAtr =
      data.metadata?.entryExtensionAtr ?? 0;

    const entryDistanceFromEma20 =
      data.metadata?.ema20 != null
        ? data.side === 'long'
          ? actualEntryPrice - data.metadata.ema20
          : data.metadata.ema20 - actualEntryPrice
        : 0;

    const entryDistanceFromEma20Percent =
      data.metadata?.ema20 != null &&
      data.metadata.ema20 > 0
        ? (entryDistanceFromEma20 /
            data.metadata.ema20) * 100
        : 0;

    logPositionOpen({
      timestamp: position.openedAt,
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
      riskCapital,
      maxNotionalByPercent:
        requestedNotionalByPercent,
      stopDistance,
      totalRiskPerUnit,
      calculatedQuantity: riskQuantity,
      regime: data.metadata?.regime ?? '',
      macdCrossUp:
        data.metadata?.macdCrossUp ?? false,
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
      entryDistanceFromEma20Atr:
        entryExtensionAtr,
      entryTooExtended:
        data.metadata?.entryTooExtended ?? false
    });

    void notifyPositionOpen({
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
      availableBalanceAfter:
        getAvailableBalance()
    };
  } catch (error) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : 'Unknown error';

    console.error(
      `[${new Date().toISOString()}] ❌ Failed to open ` +
        `MEXC Futures position: ${errorMsg}`
    );

    return createRejectedResult(
      `MEXC Futures API error: ${errorMsg}`,
      balanceBefore,
      reservedCapitalBefore,
      availableBalanceBefore
    );
  }
}

export async function closePosition(
  positionId: string,
  exitPrice: number,
  reason: CloseReason
): Promise<PositionStateResult> {
  const index = currentPositions.findIndex(
    position => position.id === positionId
  );

  if (index === -1) {
    return createRejectedResult('No open position');
  }

  if (!isFinitePositive(exitPrice)) {
    return createRejectedResult('Invalid exit price');
  }

  const position = currentPositions[index];

  const balanceBefore = balance;
  const reservedCapitalBefore = reservedCapital;
  const availableBalanceBefore = getAvailableBalance();

  try {
    console.log(
      `[${new Date().toISOString()}] 🚀 Closing MEXC Futures ` +
        `${position.symbol} ${position.side.toUpperCase()} ` +
        `qty=${position.quantity.toFixed(8)}`
    );

    const mexcOrder =
      await mexcClient.closeFuturesPosition(
        position.symbol,
        position.side,
        position.quantity,
        undefined,
        FUTURES_POSITION_MODE
      );

    const actualQuantity = getExecutedQuantity(
      position.quantity,
      mexcOrder.executedQty
    );

    const actualExitPrice = getExecutedPrice(
      exitPrice,
      mexcOrder.avgPrice || mexcOrder.price,
      mexcOrder.executedQuoteQty,
      actualQuantity
    );

    if (
      !isValidFuturesQuantity(actualQuantity) ||
      !isFinitePositive(actualExitPrice)
    ) {
      throw new Error(
        `Invalid Futures close fill: ` +
          `qty=${mexcOrder.executedQty}, ` +
          `price=${mexcOrder.avgPrice || mexcOrder.price}, ` +
          `quote=${mexcOrder.executedQuoteQty}`
      );
    }

    const realizedPnL =
      position.side === 'long'
        ? (actualExitPrice -
            position.entryPrice) *
          actualQuantity
        : (position.entryPrice -
            actualExitPrice) *
          actualQuantity;

    const realizedPnLPercent =
      position.notional > 0
        ? (realizedPnL /
            position.notional) * 100
        : 0;

    const exitFee =
      actualExitPrice *
      actualQuantity *
      TRADE_FEE_RATE;

    const totalFee =
      position.entryFee + exitFee;

    const netPnL =
      realizedPnL - totalFee;

    const netPnLPercent =
      position.notional > 0
        ? (netPnL /
            position.notional) * 100
        : 0;

    const closedAtMs = Date.now();
    const closedAt =
      new Date(closedAtMs).toISOString();

    const openedAtMs =
      new Date(position.openedAt).getTime();

    const positionAgeSeconds =
      Number.isFinite(openedAtMs)
        ? Math.max(
            0,
            Math.floor(
              (closedAtMs - openedAtMs) / 1000
            )
          )
        : 0;

    lastClosedTrade = {
      id: position.id,
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: actualExitPrice,
      quantity: actualQuantity,
      notional: position.notional,
      realizedPnL,
      realizedPnLPercent,
      entryFee: position.entryFee,
      exitFee,
      totalFee,
      netPnL,
      netPnLPercent,
      openedAt: position.openedAt,
      closedAt,
      positionAgeSeconds,
      reason
    };

    currentPositions =
      currentPositions.filter(
        openPosition => openPosition.id !== positionId
      );

    reservedCapital =
      calculateReservedCapital();

    balance += netPnL;

    logPositionClose({
      timestamp: closedAt,
      positionId: position.id,
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: actualExitPrice,
      quantity: actualQuantity,
      notional: position.notional,
      realizedPnL,
      realizedPnLPercent,
      entryFee: position.entryFee,
      exitFee,
      totalFee,
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

    void notifyPositionClose({
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: actualExitPrice,
      quantity: actualQuantity,
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
      availableBalanceAfter:
        getAvailableBalance()
    };
  } catch (error) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : 'Unknown error';

    console.error(
      `[${new Date().toISOString()}] ❌ Failed to close ` +
        `MEXC Futures position: ${errorMsg}`
    );

    return createRejectedResult(
      `MEXC Futures API error: ${errorMsg}`,
      balanceBefore,
      reservedCapitalBefore,
      availableBalanceBefore
    );
  }
}

export async function partialClosePosition(
  positionId: string,
  quantityToClose: number,
  exitPrice: number
): Promise<
  | {
      ok: true;
      realizedPnL: number;
      position: VirtualPosition;
    }
  | {
      ok: false;
      message: string;
    }
> {
  const index = currentPositions.findIndex(
    position => position.id === positionId
  );

  if (index === -1) {
    return {
      ok: false,
      message: 'No open position'
    };
  }

  if (!isFinitePositive(exitPrice)) {
    return {
      ok: false,
      message: 'Invalid exit price'
    };
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

  try {
    const mexcOrder =
      await mexcClient.closeFuturesPosition(
        position.symbol,
        position.side,
        quantityToClose,
        undefined,
        FUTURES_POSITION_MODE
      );

    const actualQuantity = getExecutedQuantity(
      quantityToClose,
      mexcOrder.executedQty
    );

    const actualExitPrice = getExecutedPrice(
      exitPrice,
      mexcOrder.avgPrice || mexcOrder.price,
      mexcOrder.executedQuoteQty,
      actualQuantity
    );

    if (
      !isValidFuturesQuantity(actualQuantity) ||
      actualQuantity >= position.quantity
    ) {
      throw new Error(
        `Invalid partial Futures fill quantity: ` +
          `${actualQuantity}`
      );
    }

    const realizedPnL =
      position.side === 'long'
        ? (actualExitPrice -
            position.entryPrice) *
          actualQuantity
        : (position.entryPrice -
            actualExitPrice) *
          actualQuantity;

    const exitFee =
      actualExitPrice *
      actualQuantity *
      TRADE_FEE_RATE;

    const entryFeeShare =
      position.entryFee *
      (actualQuantity / position.quantity);

    const netPnL =
      realizedPnL - exitFee - entryFeeShare;

    const oldQuantity = position.quantity;
    const oldNotional = position.notional;

    position.quantity =
      oldQuantity - actualQuantity;

    position.notional =
      position.quantity * position.entryPrice;

    position.reservedCapital =
      position.notional / FUTURES_LEVERAGE;

    position.entryFee =
      Math.max(
        0,
        position.entryFee - entryFeeShare
      );

    const closedNotional =
      oldNotional *
      (actualQuantity / oldQuantity);

    reservedCapital = Math.max(
      0,
      reservedCapital -
        closedNotional / FUTURES_LEVERAGE
    );

    reservedCapital =
      calculateReservedCapital();

    balance += netPnL;

    return {
      ok: true,
      realizedPnL: netPnL,
      position
    };
  } catch (error) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : 'Unknown error';

    console.error(
      `[${new Date().toISOString()}] ❌ Failed Futures ` +
        `partial close for ${position.symbol}: ${errorMsg}`
    );

    return {
      ok: false,
      message: `MEXC Futures API error: ${errorMsg}`
    };
  }
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

  currentPositions = currentPositions.map(position => {
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

  currentPositions[index].stopLossPrice =
    newStopLossPrice;

  return true;
}
