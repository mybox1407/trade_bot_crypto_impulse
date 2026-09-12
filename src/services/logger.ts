import fs from 'fs';
import path from 'path';

const LOG_DIR = '/app/logs';

type CsvValue =
  | string
  | number
  | boolean
  | null
  | undefined;

const FILE_HEADERS: Record<
  string,
  string[]
> = {
  'signal_log.csv': [
    'timestamp',
    'symbol',
    'timeframe',
    'side',
    'price',
    'regime',
    'takeProfitPrice',
    'stopLossPrice',
    'positionSize',
    'macdCrossUp',
    'macdCrossDown',
    'lastRsi',
    'lastAtr',
    'rsiBull',
    'rsiBear',
    'bbUpper',
    'bbMiddle',
    'bbLower',
    'adx',
    'adxRising',
    'ema20',
    'ema50',
    'ema200',
    'bbWidth',
    'atrPct',
    'signalTriggered',
    'positionOpened',
    'openPositionError'
  ],

  'position_open_log.csv': [
    'timestamp',
    'positionId',
    'symbol',
    'side',
    'entryPrice',
    'quantity',
    'notional',
    'takeProfitPrice',
    'stopLossPrice',
    'entryFee',
    'balanceBefore',
    'balanceAfter',
    'riskCapital',
    'maxNotionalByPercent',
    'stopDistance',
    'totalRiskPerUnit',
    'calculatedQuantity',
    'regime',
    'macdCrossUp',
    'macdCrossDown',
    'lastRsi',
    'lastAtr',
    'adx',
    'bbWidth',
    'atrPct',
    'ema20',
    'ema50',
    'ema200',
    'entryDistanceFromEma20',
    'entryDistanceFromEma20Percent',
    'entryDistanceFromEma20Atr',
    'entryTooExtended'
  ],

  'position_check_log.csv': [
    'timestamp',
    'positionId',
    'symbol',
    'side',
    'entryPrice',
    'currentPrice',
    'takeProfitPrice',
    'stopLossPrice',
    'unrealizedPnL',
    'unrealizedPnLPercent',
    'distanceToTP',
    'distanceToTPPercent',
    'distanceToSL',
    'distanceToSLPercent',
    'hitTakeProfit',
    'hitStopLoss',
    'action',
    'positionAgeSeconds'
  ],

  'trade_log.csv': [
    'timestamp',
    'positionId',
    'symbol',
    'side',
    'entryPrice',
    'exitPrice',
    'quantity',
    'notional',
    'realizedPnL',
    'realizedPnLPercent',
    'entryFee',
    'exitFee',
    'totalFee',
    'netPnL',
    'netPnLPercent',
    'balanceBefore',
    'balanceAfter',
    'reason',
    'positionAgeSeconds',
    'openedAt',
    'closedAt',
    'maxUnrealizedPnL',
    'maxUnrealizedPnLPercent',
    'worstUnrealizedPnL',
    'worstUnrealizedPnLPercent',
    'beTriggered',
    'partialClosed',
    'trailingActive',
    'trailingStopPrice'
  ],

  'partial_close_log.csv': [
    'timestamp',
    'positionId',
    'symbol',
    'side',
    'entryPrice',
    'exitPrice',
    'quantity',
    'remainingQuantity',
    'originalNotional',
    'remainingNotional',
    'realizedPnL',
    'realizedPnLPercent',
    'entryFee',
    'exitFee',
    'totalFee',
    'netPnL',
    'netPnLPercent',
    'balanceBefore',
    'balanceAfter',
    'executionOrderId',
    'clientOrderId'
  ],

  'error_log.csv': [
    'timestamp',
    'context',
    'symbol',
    'positionId',
    'error',
    'stack'
  ]
};

function ensureDirExists(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, {
      recursive: true
    });
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

function escapeCsvValue(
  value: CsvValue
): string {
  if (
    value === null ||
    value === undefined
  ) {
    return '';
  }

  const stringValue =
    String(value);

  if (
    stringValue.includes(',') ||
    stringValue.includes('"') ||
    stringValue.includes('\n')
  ) {
    return (
      `"${stringValue.replace(
        /"/g,
        '""'
      )}"`
    );
  }

  return stringValue;
}

function writeRow(
  fileName: string,
  row: Record<string, CsvValue>
): void {
  ensureDirExists();

  const filePath =
    path.join(LOG_DIR, fileName);

  const headers =
    FILE_HEADERS[fileName] ??
    Object.keys(row);

  ensureFileExists(
    filePath,
    headers
  );

  const values = headers.map(
    header =>
      escapeCsvValue(row[header])
  );

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
  writeRow(
    'signal_log.csv',
    row
  );
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
  writeRow(
    'position_open_log.csv',
    row
  );
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
  writeRow(
    'position_check_log.csv',
    row
  );
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
  writeRow(
    'trade_log.csv',
    row
  );
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
  writeRow(
    'partial_close_log.csv',
    row
  );
}

export function logError(row: {
  timestamp: string;
  context: string;
  symbol?: string;
  positionId?: string;
  error: string;
  stack?: string;
}): void {
  writeRow(
    'error_log.csv',
    row
  );
}
