// src/config/env.ts
import { config } from '@dotenvx/dotenvx';

// Явно указать путь к .env
config({ path: '.env' });

export const env = {
  port: Number(process.env.PORT) || 3002,
  // MEXC API credentials
  apiKey: process.env.MEXC_API_KEY || '',
  apiSecret: process.env.MEXC_SECRET_KEY || '',
  nodeEnv: process.env.NODE_ENV || 'development',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || ''
};
