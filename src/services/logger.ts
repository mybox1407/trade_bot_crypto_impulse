import fs from 'fs';
import path from 'path';

const LOG_DIR = '/app/logs';

function ensureDirExists(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function ensureFileExists(
  filePath: string,
  headers: string[]
): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(
      filePath,
      `${headers.join(',')}\n`,
      'utf8'
    );
  }
}

function writeRow(
  fileName: string,
  row: Record<
    string,
    string | number | boolean | null | undefined
  >
): void {
  ensureDirExists();

  const filePath = path.join(LOG_DIR, fileName);
  const headers = Object.keys(row);

  ensureFileExists(filePath, headers);

  const values = headers.map(header => {
    const value = row[header];

    if (value === null || value === undefined) {
      return '';
    }

    const stringValue = String(value);

    if (
      stringValue.includes(',') ||
      stringValue.includes('"') ||
      stringValue.includes('\n')
    ) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }

    return stringValue;
  });

  fs.appendFileSync(
    filePath,
    `${values.join(',')}\n`,
    'utf8'
  );
}

export function logSignalCheck(row: {
  timestamp: string;
  symbol: string;
  timeframe: string;
  side: string;
  price: number;
  regime: string;
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
  positionSize: number | null;
  macdCrossUp: boolean;
  macdCrossDown: boolean;
  lastRsi: number;
  lastAtr: number;
  rsiBull: boolean;
  rsiBear: boolean;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  adx: number;
  adxRising: boolean;
  ema20: number;
  ema50: number;
  ema200: number;
  bbWidth: number;
  atrPct: number;
  signalTriggered: boolean;
  positionOpened: boolean;
  openPositionError?: string;
}): void {
  writeRow('signal_log.csv', row);
}

export function logPositionOpen(row: {
  timestamp: string;
  positionId: string;
  symbol: string;
  side: string;
  entryPrice: number;
  quantity: number;
  notional: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  entryFee: number;
  balanceBefore: number;
  balanceAfter: number;
  riskCapital: number;
  maxNotionalByPercent: number;
  stopDistance: number;
  totalRiskPerUnit: number;
  calculatedQuantity: number;
  regime: string;
  macdCrossUp: boolean;
  macdCrossDown: boolean;
  lastRsi: number;
  lastAtr: number;
  adx: number;
  bbWidth: number;
  atrPct: number;
  ema20: number;
  ema50: number;
  ema200: number;
  entryDistanceFromEma20: number;
  entryDistanceFromEma20Percent: number;
  entryDistanceFromEma20Atr: number;
  entryTooExtended: boolean;
}): void {
  writeRow('position_open_log.csv', row);
}

export function logPositionCheck(row: {
  timestamp: string;
  positionId: string;
  symbol: string;
  side: string;
  entryPrice: number;
  currentPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  distanceToTP: number;
  distanceToTPPercent: number;
  distanceToSL: number;
  distanceToSLPercent: number;
  hitTakeProfit: boolean;
  hitStopLoss: boolean;
  action: string;
  positionAgeSeconds: number;
}): void {
  writeRow('position_check_log.csv', row);
}

export function logPositionClose(row: {
  timestamp: string;
  positionId: string;
  symbol: string;
  side: string;
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
  balanceBefore: number;
  balanceAfter: number;
  reason: string;
  positionAgeSeconds: number;
  openedAt: string;
  closedAt: string;
  maxUnrealizedPnL?: number;
  maxUnrealizedPnLPercent?: number;
  worstUnrealizedPnL?: number;
  worstUnrealizedPnLPercent?: number;
  beTriggered?: boolean;
  partialClosed?: boolean;
  trailingActive?: boolean;
  trailingStopPrice?: number;
}): void {
  writeRow('trade_log.csv', row);
}

export function logPartialClose(row: {
  timestamp: string;
  positionId: string;
  symbol: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  remainingQuantity: number;
  originalNotional: number;
  remainingNotional: number;
  realizedPnL: number;
  realizedPnLPercent: number;
  entryFee: number;
  exitFee: number;
  totalFee: number;
  netPnL: number;
  netPnLPercent: number;
  balanceBefore: number;
  balanceAfter: number;
  executionOrderId?: string;
  clientOrderId?: string;
}): void {
  writeRow('partial_close_log.csv', row);
}

export function logError(row: {
  timestamp: string;
  context: string;
  symbol?: string;
  positionId?: string;
  error: string;
  stack?: string;
}): void {
  writeRow('error_log.csv', row);
}
