import axios from 'axios';
import { env } from '../config/env';

interface TelegramMessage {
  chat_id: string;
  text: string;
  parse_mode?: 'HTML' | 'Markdown';
  disable_web_page_preview?: boolean;
}

async function sendMessage(message: TelegramMessage): Promise<boolean> {
  if (!env.telegramBotToken || !env.telegramChatId) {
    console.log(`[${new Date().toISOString()}] Telegram not configured, skipping message`);
    return false;
  }

  try {
    const url = `https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`;
    
    await axios.post(url, message, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });

    console.log(`[${new Date().toISOString()}] Telegram message sent successfully`);
    return true;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[${new Date().toISOString()}] Failed to send Telegram message: ${errorMsg}`);
    return false;
  }
}

export function notifyPositionOpen(data: {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  quantity: number;
  notional: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  positionId: string;
  regime: string;
  balance: number;
}) {
  const emoji = data.side === 'long' ? '🟢' : '🔴';
  const sideText = data.side === 'long' ? 'LONG' : 'SHORT';
  
  const text = `${emoji} POSITION OPENED ${emoji}

Symbol: ${data.symbol}
Side: ${sideText}
Entry Price: ${data.entryPrice.toFixed(4)}
Quantity: ${data.quantity.toFixed(4)}
Notional: $${data.notional.toFixed(2)}

Take Profit: ${data.takeProfitPrice.toFixed(4)}
Stop Loss: ${data.stopLossPrice.toFixed(4)}

Regime: ${data.regime}
Balance: $${data.balance.toFixed(2)}
Position ID: ${data.positionId}

${new Date().toISOString()}`;

  return sendMessage({
    chat_id: env.telegramChatId,
    text
  });
}

export function notifyPositionClose(data: {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  notional: number;
  realizedPnL: number;
  netPnL: number;
  netPnLPercent: number;
  reason: 'take_profit' | 'stop_loss' | 'manual' | 'time_stop' | 'breakeven_stop';
  positionAgeSeconds: number;
  balance: number;
  positionId: string;
}) {
  const emoji = data.netPnL >= 0 ? '✅' : '❌';
  const pnlEmoji = data.netPnL >= 0 ? '📈' : '📉';
  const reasonEmoji = 
    data.reason === 'take_profit' ? '🎯' : 
    data.reason === 'stop_loss' ? '🛑' : 
    data.reason === 'time_stop' ? '⏱' : 
    data.reason === 'breakeven_stop' ? '🛡' : '✋';
  
  const sideText = data.side === 'long' ? 'LONG' : 'SHORT';
  const pnlSign = data.netPnL >= 0 ? '+' : '';
  
  const hours = Math.floor(data.positionAgeSeconds / 3600);
  const minutes = Math.floor((data.positionAgeSeconds % 3600) / 60);
  const seconds = data.positionAgeSeconds % 60;
  const duration = `${hours}h ${minutes}m ${seconds}s`;

  const text = `${emoji} POSITION CLOSED ${emoji}

Symbol: ${data.symbol}
Side: ${sideText}
Entry: ${data.entryPrice.toFixed(4)}
Exit: ${data.exitPrice.toFixed(4)}
Quantity: ${data.quantity.toFixed(4)}
Notional: $${data.notional.toFixed(2)}

${pnlEmoji} PnL: ${pnlSign}$${data.netPnL.toFixed(2)} (${pnlSign}${data.netPnLPercent.toFixed(2)}%)
Realized PnL: ${pnlSign}$${data.realizedPnL.toFixed(2)}

Reason: ${reasonEmoji} ${data.reason.replace('_', ' ').toUpperCase()}
Duration: ${duration}
Balance: $${data.balance.toFixed(2)}
Position ID: ${data.positionId}

${new Date().toISOString()}`;

  return sendMessage({
    chat_id: env.telegramChatId,
    text
  });
}

export function notifyError(data: {
  context: string;
  symbol?: string;
  error: string;
}) {
  const text = `🚨 ERROR 🚨

Context: ${data.context}
Symbol: ${data.symbol ?? 'N/A'}
Error: ${data.error}

${new Date().toISOString()}`;

  return sendMessage({
    chat_id: env.telegramChatId,
    text
  });
}

export function notifyStartup(data: {
  port: number;
  tradingPairs: string[];
  signalInterval: number;
  positionInterval: number;
}) {
  const text = `🤖 TRADING BOT STARTED 🤖

Port: ${data.port}
Trading Pairs: ${data.tradingPairs.join(', ')}
Signal Check: every ${data.signalInterval}s
Position Check: every ${data.positionInterval}s

Bot is running...

${new Date().toISOString()}`;

  return sendMessage({
    chat_id: env.telegramChatId,
    text
  });
}

export function notifySignalCheck(data: {
  symbol: string;
  regime: string;
  hasSignal: boolean;
  side?: 'long' | 'short';
  price?: number;
  reason?: string;
}) {
  const emoji = data.hasSignal 
    ? (data.side === 'long' ? '🟢' : '🔴') 
    : '⏳';
  
  const signalText = data.hasSignal 
    ? `${data.side?.toUpperCase()} @ ${data.price?.toFixed(4)}`
    : 'No signal';

  const text = `${emoji} ${data.symbol}

Regime: ${data.regime}
Signal: ${signalText}
Reason: ${data.reason ?? 'Conditions not met'}

${new Date().toISOString()}`;

  return sendMessage({
    chat_id: env.telegramChatId,
    text
  });
}
