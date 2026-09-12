import axios from 'axios';
import { env } from '../config/env';

interface TelegramMessage {
  chat_id: string;
  text: string;
  parse_mode?: 'HTML' | 'Markdown';
  disable_web_page_preview?: boolean;
}

async function sendMessage(
  message: TelegramMessage
): Promise<boolean> {
  if (
    !env.telegramBotToken ||
    !env.telegramChatId
  ) {
    console.log(
      `[${new Date().toISOString()}] ` +
        `Telegram not configured, skipping message`
    );

    return false;
  }

  try {
    const url =
      `https://api.telegram.org/bot` +
      `${env.telegramBotToken}/sendMessage`;

    await axios.post(
      url,
      message,
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );

    console.log(
      `[${new Date().toISOString()}] ` +
        `Telegram message sent successfully`
    );

    return true;
  } catch (error) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : 'Unknown error';

    console.error(
      `[${new Date().toISOString()}] ` +
        `Failed to send Telegram message: ` +
        `${errorMsg}`
    );

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
  const emoji =
    data.side === 'long'
      ? '🟢'
      : '🔴';

  const sideText =
    data.side === 'long'
      ? 'LONG'
      : 'SHORT';

  const text =
    `${emoji} POSITION OPENED ${emoji}\n\n` +
    `Symbol: ${data.symbol}\n` +
    `Side: ${sideText}\n` +
    `Entry Price: ${data.entryPrice.toFixed(4)}\n` +
    `Quantity: ${data.quantity.toFixed(4)}\n` +
    `Notional: $${data.notional.toFixed(2)}\n\n` +
    `Take Profit: ${data.takeProfitPrice.toFixed(4)}\n` +
    `Stop Loss: ${data.stopLossPrice.toFixed(4)}\n\n` +
    `Regime: ${data.regime}\n` +
    `Balance: $${data.balance.toFixed(2)}\n` +
    `Position ID: ${data.positionId}\n\n` +
    `${new Date().toISOString()}`;

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
  reason:
    | 'take_profit'
    | 'stop_loss'
    | 'manual'
    | 'time_stop'
    | 'breakeven_stop'
    | 'dead_trade_mfe'
    | 'reconciliation_missing_remote'
    | 'reconciliation_severe_mismatch';
  positionAgeSeconds: number;
  balance: number;
  positionId: string;
}) {
  const emoji =
    data.netPnL >= 0
      ? '✅'
      : '❌';

  const pnlEmoji =
    data.netPnL >= 0
      ? '📈'
      : '📉';

  const reasonEmoji =
    data.reason === 'take_profit'
      ? '🎯'
      : data.reason === 'stop_loss'
        ? '🛑'
        : data.reason === 'time_stop'
          ? '⏱'
          : data.reason ===
            'breakeven_stop'
            ? '🛡'
            : data.reason ===
              'dead_trade_mfe'
              ? '✂️'
              : data.reason ===
                'reconciliation_missing_remote'
                ? '🔄'
                : data.reason ===
                  'reconciliation_severe_mismatch'
                  ? '⚠️'
                  : '✋';

  const sideText =
    data.side === 'long'
      ? 'LONG'
      : 'SHORT';

  const pnlSign =
    data.netPnL >= 0
      ? '+'
      : '';

  const hours =
    Math.floor(
      data.positionAgeSeconds / 3600
    );

  const minutes =
    Math.floor(
      (
        data.positionAgeSeconds % 3600
      ) / 60
    );

  const seconds =
    data.positionAgeSeconds % 60;

  const duration =
    `${hours}h ${minutes}m ${seconds}s`;

  const text =
    `${emoji} POSITION CLOSED ${emoji}\n\n` +
    `Symbol: ${data.symbol}\n` +
    `Side: ${sideText}\n` +
    `Entry: ${data.entryPrice.toFixed(4)}\n` +
    `Exit: ${data.exitPrice.toFixed(4)}\n` +
    `Quantity: ${data.quantity.toFixed(4)}\n` +
    `Notional: $${data.notional.toFixed(2)}\n\n` +
    `${pnlEmoji} PnL: ${pnlSign}$${data.netPnL.toFixed(2)} ` +
    `(${pnlSign}${data.netPnLPercent.toFixed(2)}%)\n` +
    `Realized PnL: ${pnlSign}$${data.realizedPnL.toFixed(2)}\n\n` +
    `Reason: ${reasonEmoji} ` +
    `${data.reason.replace('_', ' ').toUpperCase()}\n` +
    `Duration: ${duration}\n` +
    `Balance: $${data.balance.toFixed(2)}\n` +
    `Position ID: ${data.positionId}\n\n` +
    `${new Date().toISOString()}`;

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
  const text =
    `🚨 ERROR 🚨\n\n` +
    `Context: ${data.context}\n` +
    `Symbol: ${data.symbol ?? 'N/A'}\n` +
    `Error: ${data.error}\n\n` +
    `${new Date().toISOString()}`;

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
  const text =
    `🤖 TRADING BOT STARTED 🤖\n\n` +
    `Port: ${data.port}\n` +
    `Trading Pairs: ${data.tradingPairs.join(', ')}\n` +
    `Signal Check: every ${data.signalInterval}s\n` +
    `Position Check: every ${data.positionInterval}s\n\n` +
    `Bot is running...\n\n` +
    `${new Date().toISOString()}`;

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
  const emoji =
    data.hasSignal
      ? data.side === 'long'
        ? '🟢'
        : '🔴'
      : '⏳';

  const signalText =
    data.hasSignal
      ? `${data.side?.toUpperCase()} @ ` +
        `${data.price?.toFixed(4)}`
      : 'No signal';

  const text =
    `${emoji} ${data.symbol}\n\n` +
    `Regime: ${data.regime}\n` +
    `Signal: ${signalText}\n` +
    `Reason: ${data.reason ?? 'Conditions not met'}\n\n` +
    `${new Date().toISOString()}`;

  return sendMessage({
    chat_id: env.telegramChatId,
    text
  });
}
