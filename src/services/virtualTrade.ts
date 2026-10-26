import fs from 'fs';
import path from 'path';

export type VirtualSide = 'long' | 'short';

export interface VirtualTrade {
  id: string;
  symbol: string;
  side: VirtualSide;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  slTpAtr: number;
  openedAt: number;
  closedAt?: number;
  exitPrice?: number;
  netPnL?: number;
  status: 'open' | 'win' | 'loss';
  closeReason?: 'stop_loss' | 'take_profit';
}

const VIRTUAL_TRADE_LOG_FILE =
  process.env.VIRTUAL_TRADE_LOG_FILE ??
  '/root/lighter_trade_live/logs/virtual_trade_log.csv';

const activeVirtualTrades = new Map<string, VirtualTrade>();
let virtualTradeHistory: VirtualTrade[] = [];

const CSV_HEADER =
  'id,symbol,side,entryPrice,stopLossPrice,takeProfitPrice,slTpAtr,' +
  'openedAt,closedAt,exitPrice,netPnL,status,closeReason\n';

export function loadVirtualTradeHistory(): void {
  const directory = path.dirname(VIRTUAL_TRADE_LOG_FILE);

  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  if (!fs.existsSync(VIRTUAL_TRADE_LOG_FILE)) {
    fs.writeFileSync(VIRTUAL_TRADE_LOG_FILE, CSV_HEADER, 'utf8');
    virtualTradeHistory = [];
    return;
  }

  const content = fs.readFileSync(VIRTUAL_TRADE_LOG_FILE, 'utf8');

  virtualTradeHistory = content
    .split('\n')
    .slice(1)
    .filter(line => line.trim().length > 0)
    .map(parseVirtualTradeCsvLine)
    .filter((trade): trade is VirtualTrade => trade !== null);
}

export function getVirtualTradeHistory(): VirtualTrade[] {
  return [...virtualTradeHistory].sort((a, b) => a.openedAt - b.openedAt);
}

export function getActiveVirtualTrade(symbol: string): VirtualTrade | undefined {
  return activeVirtualTrades.get(symbol);
}

export function getActiveVirtualTradeSymbols(): string[] {
  return [...activeVirtualTrades.keys()];
}

export function openVirtualTrade(input: {
  symbol: string;
  side: VirtualSide;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  slTpAtr: number;
}): VirtualTrade {
  const existing = activeVirtualTrades.get(input.symbol);

  if (existing) {
    return existing;
  }

  const trade: VirtualTrade = {
    id: `vt_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    symbol: input.symbol,
    side: input.side,
    entryPrice: input.entryPrice,
    stopLossPrice: input.stopLossPrice,
    takeProfitPrice: input.takeProfitPrice,
    slTpAtr: input.slTpAtr,
    openedAt: Date.now(),
    status: 'open'
  };

  activeVirtualTrades.set(input.symbol, trade);

  console.log(JSON.stringify({
    event: 'VIRTUAL_TRADE_OPENED',
    timestamp: new Date().toISOString(),
    id: trade.id,
    symbol: trade.symbol,
    side: trade.side,
    entryPrice: trade.entryPrice,
    stopLossPrice: trade.stopLossPrice,
    takeProfitPrice: trade.takeProfitPrice,
    slTpAtr: trade.slTpAtr,
    openedAt: trade.openedAt,
    status: trade.status
  }));

  return trade;
}

export function checkVirtualTrade(
  symbol: string,
  price: number,
  now = Date.now()
): VirtualTrade | null {
  const trade = activeVirtualTrades.get(symbol);

  if (!trade) return null;

  const hitStop =
    trade.side === 'long'
      ? price <= trade.stopLossPrice
      : price >= trade.stopLossPrice;

  const hitTarget =
    trade.side === 'long'
      ? price >= trade.takeProfitPrice
      : price <= trade.takeProfitPrice;

  if (!hitStop && !hitTarget) return null;

  // При одновременном касании считаем LOSS — консервативно.
  const closeReason: 'stop_loss' | 'take_profit' =
    hitStop ? 'stop_loss' : 'take_profit';

  const exitPrice =
    closeReason === 'stop_loss'
      ? trade.stopLossPrice
      : trade.takeProfitPrice;

  const signedMove =
    trade.side === 'long'
      ? exitPrice - trade.entryPrice
      : trade.entryPrice - exitPrice;

  const closed: VirtualTrade = {
    ...trade,
    closedAt: now,
    exitPrice,
    netPnL: signedMove,
    status: closeReason === 'take_profit' ? 'win' : 'loss',
    closeReason
  };

  activeVirtualTrades.delete(symbol);
  virtualTradeHistory.push(closed);
  appendVirtualTradeToCsv(closed);

  console.log(JSON.stringify({
    event: 'VIRTUAL_TRADE_CLOSED',
    timestamp: new Date().toISOString(),
    id: closed.id,
    symbol: closed.symbol,
    side: closed.side,
    entryPrice: closed.entryPrice,
    exitPrice: closed.exitPrice,
    stopLossPrice: closed.stopLossPrice,
    takeProfitPrice: closed.takeProfitPrice,
    netPnL: closed.netPnL,
    status: closed.status,
    closeReason: closed.closeReason,
    openedAt: closed.openedAt,
    closedAt: closed.closedAt
  }));

  return closed;
}

function appendVirtualTradeToCsv(trade: VirtualTrade): void {
  const line = [
    trade.id,
    trade.symbol,
    trade.side,
    trade.entryPrice,
    trade.stopLossPrice,
    trade.takeProfitPrice,
    trade.slTpAtr,
    trade.openedAt,
    trade.closedAt ?? '',
    trade.exitPrice ?? '',
    trade.netPnL ?? '',
    trade.status,
    trade.closeReason ?? ''
  ].join(',');

  fs.appendFileSync(VIRTUAL_TRADE_LOG_FILE, `${line}\n`, 'utf8');
}

function parseVirtualTradeCsvLine(line: string): VirtualTrade | null {
  const cells = line.split(',');

  if (cells.length < 13) return null;

  return {
    id: cells[0],
    symbol: cells[1],
    side: cells[2] as VirtualSide,
    entryPrice: Number(cells[3]),
    stopLossPrice: Number(cells[4]),
    takeProfitPrice: Number(cells[5]),
    slTpAtr: Number(cells[6]),
    openedAt: Number(cells[7]),
    closedAt: cells[8] ? Number(cells[8]) : undefined,
    exitPrice: cells[9] ? Number(cells[9]) : undefined,
    netPnL: cells[10] ? Number(cells[10]) : undefined,
    status: cells[11] as VirtualTrade['status'],
    closeReason: cells[12] ? cells[12] as VirtualTrade['closeReason'] : undefined
  };
}
