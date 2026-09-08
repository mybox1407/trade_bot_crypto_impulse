import fs from 'fs';
import path from 'path';

const LOG_DIR = '/app/logs';

function ensureDirExists() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function ensureFileExists(filePath: string, headers: string[]) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, headers.join(',') + '\n');
  }
}

function writeRow(
  fileName: string,
  row: Record<string, string | number | boolean | null | undefined>
) {
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

  fs.appendFileSync(filePath, `${values.join(',')}\n`);
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
}) {
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

  // Индикаторы на момент фактического входа.
  // Нужны для анализа качества входа и симуляции фильтров.
  ema20: number;
  ema50: number;
  ema200: number;

  // Для long: entryPrice - EMA20.
  // Для short: EMA20 - entryPrice.
  // Положительное значение означает, что вход сделан
  // в направлении импульса относительно EMA20.
  entryDistanceFromEma20: number;

  // То же отклонение, но в процентах от EMA20.
  entryDistanceFromEma20Percent: number;

  // Главный аналитический показатель:
  // entryDistanceFromEma20 / lastAtr.
  // Например, 1.20 означает, что entry расположен
  // на 1.2 ATR выше EMA20 для long.
  entryDistanceFromEma20Atr: number;

  // true, когда вход расположен дальше допустимого
  // расстояния от EMA20 и должен быть отфильтрован.
  entryTooExtended: boolean;
}) {
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
}) {
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

  // Необязательные поля для будущего анализа управления выходом.
  beTriggered?: boolean;
  partialClosed?: boolean;
  trailingActive?: boolean;
  trailingStopPrice?: number;
}) {
  writeRow('trade_log.csv', row);
}

export function logError(row: {
  timestamp: string;
  context: string;
  symbol?: string;
  positionId?: string;
  error: string;
  stack?: string;
}) {
  writeRow('error_log.csv', row);
}
