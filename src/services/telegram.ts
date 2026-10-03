import axios from 'axios';
import { env } from '../config/env';

type EntryPattern =
  | 'pullback_reclaim'
  | 'impulse_breakout'
  | 'impulse_continuation'
  | 'breakout'
  | null;

interface TelegramMessage {
  chat_id: string;
  text: string;
  parse_mode?: 'HTML' | 'Markdown';
  disable_web_page_preview?: boolean;
}

async function sendMessage(
  message: TelegramMessage
): Promise<boolean> {
  if (!env.telegramBotToken || !env.telegramChatId) {
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

    await axios.post(url, message, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });

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

function formatEntryPattern(
  entryPattern?: EntryPattern
): string {
  switch (entryPattern) {
    case 'pullback_reclaim':
      return 'Pullback + reclaim';

    case 'impulse_breakout':
      return '⚡ Impulse breakout';

    case 'impulse_continuation':
      return '⚡ Impulse continuation';

    case 'breakout':
      return 'Bollinger breakout';

    default:
      return 'N/A';
  }
}

function formatImpulseRejectReason(
  reason?: string | null
): string {
  switch (reason) {
    case 'not_enough_impulse_breakout_data':
      return 'Недостаточно свечей для impulse breakout';

    case 'invalid_impulse_breakout_atr':
      return 'Некорректный ATR для impulse breakout';

    case 'empty_impulse_breakout_lookback':
      return 'Пустой lookback для impulse breakout';

    case 'impulse_breakout_body_too_small':
      return 'Тело импульса меньше минимального ATR-порога';

    case 'impulse_breakout_body_too_large':
      return 'Тело импульса больше максимального ATR-порога';

    case 'long_impulse_close_not_near_high':
      return 'Long: закрытие импульса не у верхней границы свечи';

    case 'short_impulse_close_not_near_low':
      return 'Short: закрытие импульса не у нижней границы свечи';

    case 'long_impulse_no_high_breakout':
      return 'Long: нет пробоя максимума lookback';

    case 'short_impulse_no_low_breakout':
      return 'Short: нет пробоя минимума lookback';

    case 'long_impulse_trend_context_failed':
      return 'Long: не пройден контекст тренда';

    case 'short_impulse_trend_context_failed':
      return 'Short: не пройден контекст тренда';

    case 'impulse_breakout_conditions_not_met':
      return 'Условия impulse breakout не выполнены';

    case null:
    case undefined:
      return 'N/A';

    default:
      return reason;
  }
}

function formatImpulseDiagnostics(data: {
  entryPattern?: EntryPattern;
  impulseDetected?: boolean;
  consolidationDetected?: boolean;
  impulseBreakoutDetected?: boolean;
  impulseBreakoutRejectReason?: string | null;
}): string {
  return (
    `Entry branch: ${formatEntryPattern(data.entryPattern)}\n` +
    `Impulse detected: ${data.impulseDetected ?? false}\n` +
    `Consolidation detected: ${data.consolidationDetected ?? false}\n` +
    `Impulse breakout: ${data.impulseBreakoutDetected ?? false}\n` +
    `Impulse reject: ${
      formatImpulseRejectReason(
        data.impulseBreakoutRejectReason
      )
    }`
  );
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
  entryPattern?: EntryPattern;
  impulseDetected?: boolean;
  consolidationDetected?: boolean;
  impulseBreakoutDetected?: boolean;
  impulseBreakoutRejectReason?: string | null;
  balance: number;
  tceScore?: number | null;
  tceRegime?: string | null;
  tceReason?: string | null;
}) {
  const emoji =
    data.side === 'long'
      ? '🟢'
      : '🔴';

  const sideText =
    data.side === 'long'
      ? 'LONG'
      : 'SHORT';

  const tceScore =
    data.tceScore != null &&
    Number.isFinite(data.tceScore)
      ? String(data.tceScore)
      : 'N/A';

  const entryDiagnostics =
    formatImpulseDiagnostics(data);

  const text =
    `${emoji} POSITION OPENED ${emoji}\n\n` +
    `Symbol: ${data.symbol}\n` +
    `Side: ${sideText}\n` +
    `Entry Price: ${data.entryPrice.toFixed(6)}\n` +
    `Quantity: ${data.quantity.toFixed(6)}\n` +
    `Notional: $${data.notional.toFixed(2)}\n\n` +
    `Take Profit: ${data.takeProfitPrice.toFixed(6)}\n` +
    `Stop Loss: ${data.stopLossPrice.toFixed(6)}\n\n` +
    `Regime: ${data.regime}\n` +
    `${entryDiagnostics}\n` +
    `TCE Score: ${tceScore}\n` +
    `TCE Regime: ${data.tceRegime ?? 'N/A'}\n` +
    `TCE Reason: ${data.tceReason ?? 'N/A'}\n` +
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
    | 'reconciliation_severe_mismatch'
    | 'partial_close_reconciliation';
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
          : data.reason === 'breakeven_stop'
            ? '🛡'
            : data.reason === 'dead_trade_mfe'
              ? '✂️'
              : data.reason === 'reconciliation_missing_remote'
                ? '🔄'
                : data.reason === 'reconciliation_severe_mismatch'
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
    Math.floor(data.positionAgeSeconds / 3600);

  const minutes =
    Math.floor(
      (data.positionAgeSeconds % 3600) / 60
    );

  const seconds =
    data.positionAgeSeconds % 60;

  const duration =
    `${hours}h ${minutes}m ${seconds}s`;

  const text =
    `${emoji} POSITION CLOSED ${emoji}\n\n` +
    `Symbol: ${data.symbol}\n` +
    `Side: ${sideText}\n` +
    `Entry: ${data.entryPrice.toFixed(6)}\n` +
    `Exit: ${data.exitPrice.toFixed(6)}\n` +
    `Quantity: ${data.quantity.toFixed(6)}\n` +
    `Notional: $${data.notional.toFixed(2)}\n\n` +
    `${pnlEmoji} PnL: ${pnlSign}$${data.netPnL.toFixed(2)} ` +
    `(${pnlSign}${data.netPnLPercent.toFixed(2)}%)\n` +
    `Realized PnL: ${pnlSign}$${data.realizedPnL.toFixed(2)}\n\n` +
    `Reason: ${reasonEmoji} ` +
    `${data.reason.replace(/_/g, ' ').toUpperCase()}\n` +
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
  balance: number;
}) {
  const text =
    `🤖 TRADING BOT STARTED 🤖\n\n` +
    `Port: ${data.port}\n` +
    `Trading Pairs: ${data.tradingPairs.join(', ')}\n` +
    `Signal Check: every ${data.signalInterval}s\n` +
    `Position Check: every ${data.positionInterval}s\n\n` +
    `Balance: $${data.balance.toFixed(2)}\n` +
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
  pullbackDetected?: boolean;
  reclaimDetected?: boolean;
  signalReason?: string | null;
  entryPattern?: EntryPattern;
  impulseDetected?: boolean;
  consolidationDetected?: boolean;
  impulseBreakoutDetected?: boolean;
  impulseBreakoutRejectReason?: string | null;
  tceScore?: number | null;
  tceRegime?: string | null;
  tceReason?: string | null;
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
        `${data.price?.toFixed(6)}`
      : 'No signal';

  const entryDiagnostics =
    formatImpulseDiagnostics(data);

  const tceText =
    `TCE Score: ${
      data.tceScore != null &&
      Number.isFinite(data.tceScore)
        ? data.tceScore
        : 'N/A'
    }\n` +
    `TCE Regime: ${data.tceRegime ?? 'N/A'}\n` +
    `TCE Reason: ${data.tceReason ?? 'N/A'}`;

  const text =
    `${emoji} ${data.symbol}\n\n` +
    `Regime: ${data.regime}\n` +
    `Signal: ${signalText}\n` +
    `Reason: ${data.reason ?? 'Conditions not met'}\n` +
    `${entryDiagnostics}\n` +
    `Pullback: ${data.pullbackDetected ?? false}\n` +
    `Reclaim: ${data.reclaimDetected ?? false}\n` +
    `Signal reason: ${data.signalReason ?? 'N/A'}\n` +
    `${tceText}\n\n` +
    `${new Date().toISOString()}`;

  return sendMessage({
    chat_id: env.telegramChatId,
    text
  });
}

export async function sendAggregatedSignalSummary(data: {
  results: Array<{
    symbol: string;
    status: string;
    regime: string;
    hasSignal: boolean;
    side?: string;
    price?: number;
    reason?: string;
    entryPattern?: EntryPattern;
    impulseDetected?: boolean;
    consolidationDetected?: boolean;
    impulseBreakoutDetected?: boolean;
    impulseBreakoutRejectReason?: string | null;
  }>;
  openPositionsCount?: number;
  errorsBySymbol?: Record<string, string>;
  equity?: number;
}): Promise<void> {
  const {
    results,
    openPositionsCount,
    errorsBySymbol,
    equity
  } = data;

  const active =
    results.filter(result =>
      [
        'signal',
        'no-signal',
        'not-ready',
        'error'
      ].includes(result.status)
    );

  const signals =
    results.filter(
      result => result.status === 'signal'
    ).length;

  const noSignals =
    results.filter(
      result =>
        result.status === 'no-signal' ||
        result.status === 'not-ready'
    ).length;

  const errors =
    results.filter(
      result => result.status === 'error'
    ).length;

  if (
    !active.length &&
    !signals &&
    !errors &&
    !errorsBySymbol
  ) {
    return;
  }

  const text = active
    .map(result => {
      if (result.status === 'error') {
        return `❌ ${result.symbol}: ERROR - ${result.reason}`;
      }

      if (result.status === 'not-ready') {
        return `⏳ ${result.symbol}: NOT READY - ${result.reason}`;
      }

      if (result.status === 'signal') {
        return (
          `${result.side === 'long' ? '🟢' : '🔴'} ` +
          `${result.symbol} [${result.regime}]: ` +
          `${result.side?.toUpperCase()} @ ` +
          `${result.price?.toFixed(6) ?? 'n/a'}\n` +
          `Branch: ${formatEntryPattern(result.entryPattern)}`
        );
      }

      if (result.status === 'no-signal') {
        let reasonText =
          result.reason ?? 'Conditions not met';

        if (reasonText === 'No signal') {
          reasonText =
            result.regime === 'trend_up'
              ? 'Нет сигнала Long: условия не сформированы'
              : result.regime === 'trend_down'
                ? 'Нет сигнала Short: условия не сформированы'
                : 'Нет торгового сигнала';
        } else if (
          reasonText === 'Outside trading window'
        ) {
          reasonText = 'Вне торговых часов';
        } else if (
          reasonText.includes('Price moved')
        ) {
          reasonText = 'Цена ушла далеко от точки входа';
        }

        const impulseReject =
          result.impulseBreakoutRejectReason != null
            ? `\nImpulse: ${
                formatImpulseRejectReason(
                  result.impulseBreakoutRejectReason
                )
              }`
            : '';

        return (
          `${result.symbol} [${result.regime}]: ` +
          `No signal - ${reasonText}` +
          `${impulseReject}`
        );
      }

      return null;
    })
    .filter(
      (value): value is string =>
        value !== null
    )
    .join('\n\n');

  let errorSummary = '';

  if (
    errorsBySymbol &&
    Object.keys(errorsBySymbol).length > 0
  ) {
    const errorLines =
      Object.entries(errorsBySymbol)
        .slice(0, 5)
        .map(
          ([symbol, error]) =>
            `• ${symbol}: ${error}`
        )
        .join('\n');

    const moreCount =
      Object.keys(errorsBySymbol).length - 5;

    errorSummary =
      `\n\n⚠️ Errors summary:\n` +
      `${errorLines}` +
      `${
        moreCount > 0
          ? `\n• ...and ${moreCount} more`
          : ''
      }`;
  }

  const equityText =
    equity != null &&
    Number.isFinite(equity)
      ? `$${equity.toFixed(2)}`
      : 'N/A';

  const openPositionsDisplay =
    openPositionsCount !== undefined
      ? openPositionsCount
      : results.filter(
          result =>
            result.status === 'position-open'
        ).length;

  const message =
    `📊 Signal Check Summary\n\n` +
    `📈 Open positions: ${openPositionsDisplay}\n\n` +
    `💰 Equity: ${equityText}\n\n` +
    `🔍 Signal scan:\n${text}` +
    `${errorSummary}\n\n` +
    `📊 Signals: ${signals} | ` +
    `No signals: ${noSignals}\n` +
    `⚠️ Errors: ${errors}\n\n` +
    `${new Date().toISOString()}`;

  await sendMessage({
    chat_id: env.telegramChatId,
    text: message
  });
}
