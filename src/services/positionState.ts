// src/services/positionState.ts

import { randomUUID } from 'node:crypto';

import {
  MAX_RISK_PER_TRADE,
  STARTING_BALANCE,
  TRADE_FEE_RATE
} from './strategy';

import {
  logPositionOpen,
  logPositionClose
} from './logger';

import {
  notifyPositionOpen,
  notifyPositionClose
} from './telegram';

import {
  MexcAuthenticatedClient,
  FuturesOrder
} from './mexcClient';

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
  marginMode: 'isolated' | 'cross';
  positionMode: 1 | 2;
  positionId?: number;
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

type PartialCloseResult =
  | {
      ok: true;
      realizedPnL: number;
      netPnL: number;
      exitFee: number;
      entryFeeShare: number;
      position: VirtualPosition;
      quantityClosed: number;
      exitPrice: number;
    }
  | {
      ok: false;
      message: string;
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
    .trim()
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
    `Invalid Futures symbol "${symbol}". ` +
    `Expected BASE_USDT`
  );
}

function createPositionId(): string {
  return randomUUID();
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
    (total, position) =>
      total + position.reservedCapital,
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
  if (!isValidFuturesQuantity(executedQuantity)) {
    throw new Error(
      `Invalid executed quantity: ${executedQuantity}. ` +
      `Requested quantity: ${requestedQuantity}`
    );
  }

  return executedQuantity;
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
    const calculatedPrice =
      executedQuoteQty / executedQty;

    if (isFinitePositive(calculatedPrice)) {
      return calculatedPrice;
    }
  }

  if (isFinitePositive(orderPrice)) {
    return orderPrice;
  }

  if (isFinitePositive(fallbackPrice)) {
    return fallbackPrice;
  }

  throw new Error(
    `Cannot determine executed price. ` +
    `fallback=${fallbackPrice}, ` +
    `orderPrice=${orderPrice}, ` +
    `quote=${executedQuoteQty}, ` +
    `qty=${executedQty}`
  );
}

function getActualOrderFee(
  order: FuturesOrder,
  fallbackNotional: number
): number {
  if (
    Number.isFinite(order.totalFee) &&
    order.totalFee !== 0
  ) {
    return order.totalFee;
  }

  return fallbackNotional * TRADE_FEE_RATE;
}

function validateConfig(): string | null {
  if (
    !Number.isInteger(FUTURES_LEVERAGE) ||
    FUTURES_LEVERAGE < 1 ||
    FUTURES_LEVERAGE > 200
  ) {
    return (
      `Invalid MEXC_FUTURES_LEVERAGE: ` +
      `${FUTURES_LEVERAGE}`
    );
  }

  if (
    FUTURES_MARGIN_MODE !== 'isolated' &&
    FUTURES_MARGIN_MODE !== 'cross'
  ) {
    return (
      `Invalid MEXC_FUTURES_MARGIN_MODE: ` +
      `${FUTURES_MARGIN_MODE}`
    );
  }

  if (
    FUTURES_POSITION_MODE !== 1 &&
    FUTURES_POSITION_MODE !== 2
  ) {
    return (
      `Invalid MEXC_FUTURES_POSITION_MODE: ` +
      `${FUTURES_POSITION_MODE}`
    );
  }

  return null;
}

function getPositionType(
  side: PositionSide
): 1 | 2 {
  return side === 'long' ? 1 : 2;
}

function updateReservedCapital(): void {
  reservedCapital = Math.max(
    0,
    calculateReservedCapital()
  );
}

function updatePositionAfterPartialClose(
  position: VirtualPosition,
  actualQuantity: number,
  entryFeeShare: number
): void {
  const newQuantity =
    position.quantity - actualQuantity;

  if (
    !isValidFuturesQuantity(newQuantity)
  ) {
    throw new Error(
      `Invalid remaining quantity: ${newQuantity}`
    );
  }

  position.quantity = newQuantity;
  position.notional =
    position.quantity * position.entryPrice;

  position.reservedCapital =
    position.notional / FUTURES_LEVERAGE;

  position.entryFee = Math.max(
    0,
    position.entryFee - entryFeeShare
  );

  position.metadata = {
    ...(position.metadata ?? {}),
    partialClosed: true
  };

  updateReservedCapital();
}

function buildActualFill(
  requestedQuantity: number,
  fallbackPrice: number,
  order: FuturesOrder
): {
  quantity: number;
  price: number;
  notional: number;
  fee: number;
} {
  const quantity = getExecutedQuantity(
    requestedQuantity,
    order.executedQty
  );

  const price = getExecutedPrice(
    fallbackPrice,
    order.avgPrice || order.price,
    order.executedQuoteQty,
    quantity
  );

  const notional = quantity * price;

  if (!isFinitePositive(notional)) {
    throw new Error(
      `Invalid fill notional: ${notional}`
    );
  }

  const fee = getActualOrderFee(
    order,
    notional
  );

  return {
    quantity,
    price,
    notional,
    fee
  };
}

export function setBalance(
  newBalance: number
): void {
  if (
    !Number.isFinite(newBalance) ||
    newBalance <= 0
  ) {
    console.warn(
      `[${new Date().toISOString()}] ` +
      `⚠️ Invalid balance: ${newBalance}`
    );

    return;
  }

  const oldBalance = balance;
  balance = newBalance;

  console.log(
    `[${new Date().toISOString()}] ` +
    `💰 Futures balance updated: ` +
    `$${oldBalance.toFixed(2)} → ` +
    `$${balance.toFixed(2)}`
  );
}

export function getBalance(): number {
  return balance;
}

export function getReservedCapital(): number {
  return reservedCapital;
}

export function getAvailableBalance(): number {
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
    const normalizedInput =
      normalizeSymbol(symbol);

    return (
      currentPositions.find(
        position =>
          normalizeSymbol(position.symbol) ===
          normalizedInput
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

  const normalizedInput =
    normalizeSymbol(symbol);

  return currentPositions.some(
    position =>
      normalizeSymbol(position.symbol) ===
      normalizedInput
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
  const availableBalanceBefore =
    getAvailableBalance();

  const configError = validateConfig();

  if (configError) {
    return createRejectedResult(
      configError,
      balanceBefore,
      reservedCapitalBefore,
      availableBalanceBefore
    );
  }

  if (
    currentPositions.length >=
    MAX_PARALLEL_POSITIONS
  ) {
    return createRejectedResult(
      `Max ${MAX_PARALLEL_POSITIONS} ` +
      `open positions reached`,
      balanceBefore,
      reservedCapitalBefore,
      availableBalanceBefore
    );
  }

  const normalizedSymbol =
    normalizeSymbol(data.symbol);

  if (hasOpenPosition(normalizedSymbol)) {
    return createRejectedResult(
      `Position for ${normalizedSymbol} ` +
      `is already open`,
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
    Math.abs(
      data.entryPrice - data.stopLossPrice
    );

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

  if (
    !isFinitePositive(
      requestedNotionalByPercent
    )
  ) {
    return createRejectedResult(
      'Invalid maximum position notional',
      balanceBefore,
      reservedCapitalBefore,
      availableBalanceBefore
    );
  }

  const maxNotionalByAvailableBalance =
    Math.min(
      requestedNotionalByPercent,
      availableBalanceBefore *
        FUTURES_LEVERAGE
    );

  if (
    !isFinitePositive(
      maxNotionalByAvailableBalance
    )
  ) {
    return createRejectedResult(
      'Calculated Futures notional is invalid',
      balanceBefore,
      reservedCapitalBefore,
      availableBalanceBefore
    );
  }

  const maxQuantityByNotional =
    maxNotionalByAvailableBalance /
    data.entryPrice;

  const riskCapital =
    data.riskCapital ??
    getRiskCapital();

  if (!isFinitePositive(riskCapital)) {
    return createRejectedResult(
      'Invalid risk capital',
      balanceBefore,
      reservedCapitalBefore,
      availableBalanceBefore
    );
  }

  const worstCaseFeePerUnit =
    (data.entryPrice + data.stopLossPrice) *
    TRADE_FEE_RATE;

  const totalRiskPerUnit =
    data.totalRiskPerUnit ??
    stopDistance + worstCaseFeePerUnit;

  if (!isFinitePositive(totalRiskPerUnit)) {
    return createRejectedResult(
      'Invalid total risk per unit',
      balanceBefore,
      reservedCapitalBefore,
      availableBalanceBefore
    );
  }

  const riskQuantity =
    data.calculatedQuantity ??
    riskCapital / totalRiskPerUnit;

  if (!isValidFuturesQuantity(riskQuantity)) {
    return createRejectedResult(
      'Invalid calculated risk quantity',
      balanceBefore,
      reservedCapitalBefore,
      availableBalanceBefore
    );
  }

  const quantity = Math.min(
    riskQuantity,
    maxQuantityByNotional
  );

  const notional =
    quantity * data.entryPrice;

  const initialMargin =
    notional / FUTURES_LEVERAGE;

  const estimatedEntryFee =
    notional * TRADE_FEE_RATE;

  if (
    !isValidFuturesQuantity(quantity) ||
    !isFinitePositive(notional) ||
    !isFinitePositive(initialMargin) ||
    !Number.isFinite(estimatedEntryFee)
  ) {
    return createRejectedResult(
      'Calculated Futures position size is invalid',
      balanceBefore,
      reservedCapitalBefore,
      availableBalanceBefore
    );
  }

  if (
    initialMargin > availableBalanceBefore
  ) {
    return createRejectedResult(
      'Insufficient margin for Futures position',
      balanceBefore,
      reservedCapitalBefore,
      availableBalanceBefore
    );
  }

  try {
    await mexcClient.setFuturesLeverage(
      normalizedSymbol,
      FUTURES_LEVERAGE,
      FUTURES_MARGIN_MODE
    );

    console.log(
      `[${new Date().toISOString()}] ` +
      `🚀 Opening MEXC Futures ` +
      `${data.side.toUpperCase()} ` +
      `${normalizedSymbol} ` +
      `qty=${quantity.toFixed(8)} ` +
      `leverage=${FUTURES_LEVERAGE}x ` +
      `margin=${FUTURES_MARGIN_MODE} ` +
      `positionMode=${FUTURES_POSITION_MODE}`
    );

    const mexcOrder =
      await mexcClient.openFuturesPosition(
        normalizedSymbol,
        data.side,
        quantity,
        FUTURES_LEVERAGE,
        FUTURES_MARGIN_MODE,
        FUTURES_POSITION_MODE
      );

    const fill = buildActualFill(
      quantity,
      data.entryPrice,
      mexcOrder
    );

    const marginReserved =
      fill.notional / FUTURES_LEVERAGE;

    const position: VirtualPosition = {
      id: String(
        mexcOrder.orderId ||
        createPositionId()
      ),
      symbol: normalizedSymbol,
      side: data.side,
      entryPrice: fill.price,
      quantity: fill.quantity,
      notional: fill.notional,
      reservedCapital: marginReserved,
      takeProfitPrice: data.takeProfitPrice,
      stopLossPrice: data.stopLossPrice,
      entryFee: fill.fee,
      openedAt: new Date().toISOString(),
      marginMode: FUTURES_MARGIN_MODE,
      positionMode: FUTURES_POSITION_MODE,
      positionId: mexcOrder.positionId,
      metadata: data.metadata
    };

    currentPositions = [
      ...currentPositions,
      position
    ];

    updateReservedCapital();

    const entryExtensionAtr =
      data.metadata?.entryExtensionAtr ?? 0;

    const entryDistanceFromEma20 =
      data.metadata?.ema20 != null
        ? data.side === 'long'
          ? fill.price - data.metadata.ema20
          : data.metadata.ema20 - fill.price
        : 0;

    const entryDistanceFromEma20Percent =
      data.metadata?.ema20 != null &&
      data.metadata.ema20 > 0
        ? (
            entryDistanceFromEma20 /
            data.metadata.ema20
          ) * 100
        : 0;

    logPositionOpen({
      timestamp: position.openedAt,
      positionId: position.id,
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      quantity: position.quantity,
      notional: position.notional,
      takeProfitPrice:
        position.takeProfitPrice,
      stopLossPrice:
        position.stopLossPrice,
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
      lastRsi:
        data.metadata?.lastRsi ?? 0,
      lastAtr:
        data.metadata?.lastAtr ?? 0,
      adx:
        data.metadata?.adx ?? 0,
      bbWidth:
        data.metadata?.bbWidth ?? 0,
      atrPct:
        data.metadata?.atrPct ?? 0,
      ema20:
        data.metadata?.ema20 ?? 0,
      ema50:
        data.metadata?.ema50 ?? 0,
      ema200:
        data.metadata?.ema200 ?? 0,
      entryDistanceFromEma20,
      entryDistanceFromEma20Percent,
      entryDistanceFromEma20Atr:
        entryExtensionAtr,
      entryTooExtended:
        data.metadata?.entryTooExtended ??
        false
    });

    void notifyPositionOpen({
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      quantity: position.quantity,
      notional: position.notional,
      takeProfitPrice:
        position.takeProfitPrice,
      stopLossPrice:
        position.stopLossPrice,
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
      `[${new Date().toISOString()}] ` +
      `❌ Failed to open MEXC Futures ` +
      `position: ${errorMsg}`
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
  const index =
    currentPositions.findIndex(
      position => position.id === positionId
    );

  if (index === -1) {
    return createRejectedResult(
      'No open position'
    );
  }

  if (!isFinitePositive(exitPrice)) {
    return createRejectedResult(
      'Invalid exit price'
    );
  }

  const position =
    currentPositions[index];

  const balanceBefore = balance;
  const reservedCapitalBefore =
    reservedCapital;
  const availableBalanceBefore =
    getAvailableBalance();

  try {
    console.log(
      `[${new Date().toISOString()}] ` +
      `🚀 Closing MEXC Futures ` +
      `${position.symbol} ` +
      `${position.side.toUpperCase()} ` +
      `qty=${position.quantity.toFixed(8)}`
    );

    const mexcOrder =
      await mexcClient.closeFuturesPosition(
        position.symbol,
        position.side,
        position.quantity,
        position.positionId,
        position.marginMode,
        position.positionMode
      );

    const fill = buildActualFill(
      position.quantity,
      exitPrice,
      mexcOrder
    );

    if (
      fill.quantity > position.quantity
    ) {
      throw new Error(
        `Exchange returned close quantity ` +
        `${fill.quantity}, but position quantity ` +
        `is ${position.quantity}`
      );
    }

    const realizedPnL =
      position.side === 'long'
        ? (
            fill.price - position.entryPrice
          ) * fill.quantity
        : (
            position.entryPrice - fill.price
          ) * fill.quantity;

    const realizedPnLPercent =
      position.notional > 0
        ? (
            realizedPnL /
            position.notional
          ) * 100
        : 0;

    const exitFee = fill.fee;

    const entryFeeShare =
      position.entryFee *
      (fill.quantity / position.quantity);

    const totalFee =
      entryFeeShare + exitFee;

    const netPnL =
      realizedPnL - totalFee;

    const netPnLPercent =
      position.notional > 0
        ? (
            netPnL /
            position.notional
          ) * 100
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
              (closedAtMs - openedAtMs) /
              1000
            )
          )
        : 0;

    const isFullClose =
      fill.quantity >=
      position.quantity * 0.999999;

    if (isFullClose) {
      lastClosedTrade = {
        id: position.id,
        symbol: position.symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice: fill.price,
        quantity: fill.quantity,
        notional:
          position.entryPrice *
          fill.quantity,
        realizedPnL,
        realizedPnLPercent,
        entryFee: entryFeeShare,
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
          openPosition =>
            openPosition.id !== positionId
        );

      updateReservedCapital();
    } else {
      updatePositionAfterPartialClose(
        position,
        fill.quantity,
        entryFeeShare
      );
    }

    balance += netPnL;

    logPositionClose({
      timestamp: closedAt,
      positionId: position.id,
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: fill.price,
      quantity: fill.quantity,
      notional:
        position.entryPrice *
        fill.quantity,
      realizedPnL,
      realizedPnLPercent,
      entryFee: entryFeeShare,
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
        position.metadata
          ?.maxUnrealizedPnLPercent,
      worstUnrealizedPnL:
        position.metadata?.worstUnrealizedPnL,
      worstUnrealizedPnLPercent:
        position.metadata
          ?.worstUnrealizedPnLPercent,
      beTriggered:
        position.metadata?.beTriggered ??
        false,
      partialClosed:
        position.metadata?.partialClosed ??
        false,
      trailingActive:
        position.metadata?.trailingActive ??
        false,
      trailingStopPrice:
        position.metadata?.trailingStopPrice
    });

    void notifyPositionClose({
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: fill.price,
      quantity: fill.quantity,
      notional:
        position.entryPrice *
        fill.quantity,
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
      `[${new Date().toISOString()}] ` +
      `❌ Failed to close MEXC Futures ` +
      `position: ${errorMsg}`
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
): Promise<PartialCloseResult> {
  const index =
    currentPositions.findIndex(
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

  const position =
    currentPositions[index];

  if (
    !isFinitePositive(quantityToClose) ||
    quantityToClose >= position.quantity
  ) {
    return {
      ok: false,
      message:
        'Invalid quantity for partial close'
    };
  }

  try {
    const mexcOrder =
      await mexcClient.closeFuturesPosition(
        position.symbol,
        position.side,
        quantityToClose,
        position.positionId,
        position.marginMode,
        position.positionMode
      );

    const fill = buildActualFill(
      quantityToClose,
      exitPrice,
      mexcOrder
    );

    if (
      fill.quantity <= 0 ||
      fill.quantity >= position.quantity
    ) {
      throw new Error(
        `Invalid partial Futures fill quantity: ` +
        `${fill.quantity}`
      );
    }

    const realizedPnL =
      position.side === 'long'
        ? (
            fill.price - position.entryPrice
          ) * fill.quantity
        : (
            position.entryPrice - fill.price
          ) * fill.quantity;

    const exitFee = fill.fee;

    const entryFeeShare =
      position.entryFee *
      (fill.quantity / position.quantity);

    const netPnL =
      realizedPnL -
      exitFee -
      entryFeeShare;

    updatePositionAfterPartialClose(
      position,
      fill.quantity,
      entryFeeShare
    );

    balance += netPnL;

    return {
      ok: true,
      realizedPnL,
      netPnL,
      exitFee,
      entryFeeShare,
      position: {
        ...position,
        metadata: position.metadata
          ? { ...position.metadata }
          : undefined
      },
      quantityClosed: fill.quantity,
      exitPrice: fill.price
    };
  } catch (error) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : 'Unknown error';

    console.error(
      `[${new Date().toISOString()}] ` +
      `❌ Failed Futures partial close ` +
      `for ${position.symbol}: ${errorMsg}`
    );

    return {
      ok: false,
      message:
        `MEXC Futures API error: ${errorMsg}`
    };
  }
}

export function updatePositionMetadata(
  positionId: string,
  updates: Partial<
    NonNullable<VirtualPosition['metadata']>
  >
): boolean {
  const index =
    currentPositions.findIndex(
      position => position.id === positionId
    );

  if (index === -1) {
    return false;
  }

  const position =
    currentPositions[index];

  currentPositions[index] = {
    ...position,
    metadata: {
      ...(position.metadata ?? {}),
      ...updates
    }
  };

  return true;
}

export function updatePositionStopLoss(
  positionId: string,
  newStopLossPrice: number
): boolean {
  if (!isFinitePositive(newStopLossPrice)) {
    return false;
  }

  const index =
    currentPositions.findIndex(
      position => position.id === positionId
    );

  if (index === -1) {
    return false;
  }

  currentPositions[index].stopLossPrice =
    newStopLossPrice;

  return true;
}
