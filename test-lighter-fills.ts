// src/scripts/test-lighter-fills.ts

import WebSocket from 'ws';
import { SignerClient } from 'zklighter-sdk';

const LIGHTER_API_URL =
  process.env.LIGHTER_API_URL ??
  'https://mainnet.zklighter.elliot.ai';

const LIGHTER_WS_URL =
  process.env.LIGHTER_WS_URL ??
  'wss://mainnet.zklighter.elliot.ai/stream';

const API_SECRET = process.env.LIGHTER_API_SECRET;
const API_KEY_INDEX = parseInt(process.env.LIGHTER_API_KEY_INDEX ?? '0', 10);
const ACCOUNT_INDEX = parseInt(process.env.LIGHTER_ACCOUNT_INDEX ?? '0', 10);

if (!API_SECRET) {
  console.error('❌ LIGHTER_API_SECRET is not set');
  process.exit(1);
}

console.log('🔍 Lighter Fill Test');
console.log(`   API URL: ${LIGHTER_API_URL}`);
console.log(`   WS URL: ${LIGHTER_WS_URL}`);
console.log(`   Account: ${ACCOUNT_INDEX}`);
console.log(`   Key Index: ${API_KEY_INDEX}`);
console.log('');

const normalizedKey =
  API_SECRET.startsWith('0x')
    ? API_SECRET.slice(2)
    : API_SECRET;

const signerClient = new SignerClient(
  LIGHTER_API_URL,
  normalizedKey,
  API_KEY_INDEX,
  ACCOUNT_INDEX
);

let ws: WebSocket | undefined;
let authToken: string | undefined;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

function connect() {
  console.log(`[${new Date().toISOString()}] Connecting to WebSocket...`);
  
  ws = new WebSocket(LIGHTER_WS_URL);

  ws.on('open', async () => {
    console.log(`[${new Date().toISOString()}] ✅ WebSocket connected`);
    reconnectAttempts = 0;

    try {
      const [auth, authError] =
        signerClient.create_auth_token_with_expiry(
          60 * 60,
          undefined,
          API_KEY_INDEX
        );

      if (authError || !auth) {
        throw new Error(authError ?? 'Failed to create auth token');
      }

      authToken = auth;

      ws!.send(
        JSON.stringify({
          type: 'subscribe',
          channel: `account_all/${ACCOUNT_INDEX}`,
          auth: authToken
        })
      );

      console.log(`[${new Date().toISOString()}] ✅ Subscribed to account_all/${ACCOUNT_INDEX}`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ❌ Auth error:`, error);
      ws?.close();
    }

    // Ping каждые 30 секунд
    setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30_000);
  });

  ws.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString());
      handleWsMessage(message);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ❌ Parse error:`, error);
    }
  });

  ws.on('error', error => {
    console.error(`[${new Date().toISOString()}] ❌ WebSocket error:`, error.message);
  });

  ws.on('close', (code, reason) => {
    console.log(`[${new Date().toISOString()}] ⚠️  WebSocket closed: code=${code}, reason=${reason}`);
    
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      console.log(`[${new Date().toISOString()}] 🔄 Reconnecting... (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
      setTimeout(connect, 3_000);
    } else {
      console.log(`[${new Date().toISOString()}] ❌ Max reconnect attempts reached`);
      process.exit(1);
    }
  });
}

function handleWsMessage(message: any) {
  const type = message.type;
  const channel = message.channel;
  const account = message.account;

  if (type === 'error') {
    console.error(`[${new Date().toISOString()}] ❌ WS Error:`, message);
    return;
  }

  console.log(`\n[${new Date().toISOString()}] 📨 Message:`);
  console.log(`   Type: ${type}`);
  console.log(`   Channel: ${channel}`);
  console.log(`   Account: ${account}`);

  // Orders
  if (Array.isArray(message.orders)) {
    console.log(`   Orders: ${message.orders.length}`);
    
    for (const order of message.orders) {
      console.log(`\n   ━━ Order ━━`);
      console.log(`      Index: ${order.order_index ?? 'n/a'}`);
      console.log(`      Client Index: ${order.client_order_index ?? 'n/a'}`);
      console.log(`      Market: ${order.market_index ?? 'n/a'}`);
      console.log(`      Status: ${order.status ?? 'n/a'}`);
      console.log(`      Type: ${order.type ?? 'n/a'}`);
      console.log(`      Side: ${order.is_ask ? 'SELL' : 'BUY'}`);
      console.log(`      Initial: ${order.initial_base_amount ?? '0'}`);
      console.log(`      Remaining: ${order.remaining_base_amount ?? '0'}`);
      console.log(`      Filled Base: ${order.filled_base_amount ?? '0'}`);
      console.log(`      Filled Quote: ${order.filled_quote_amount ?? '0'}`);
      
      // Вычисляем процент заполнения
      const initial = parseFloat(order.initial_base_amount ?? '0');
      const filled = parseFloat(order.filled_base_amount ?? '0');
      const fillPercent = initial > 0 ? (filled / initial * 100) : 0;
      console.log(`      Fill %: ${fillPercent.toFixed(2)}%`);
      
      // Вычисляем среднюю цену
      const filledBase = parseFloat(order.filled_base_amount ?? '0');
      const filledQuote = parseFloat(order.filled_quote_amount ?? '0');
      const avgPrice = filledBase > 0 && filledQuote > 0 ? (filledQuote / filledBase) : 0;
      console.log(`      Avg Price: ${avgPrice.toFixed(6)}`);
    }
  }

  // Trades
  if (message.trades) {
    const trades = Array.isArray(message.trades)
      ? message.trades
      : Object.values(message.trades).flat();
    
    console.log(`   Trades: ${trades.length}`);
    
    for (const trade of trades) {
      console.log(`\n   ━━ Trade ━━`);
      console.log(`      Trade ID: ${trade.trade_id ?? 'n/a'}`);
      console.log(`      TX Hash: ${trade.tx_hash ?? 'n/a'}`);
      console.log(`      Market: ${trade.market_id ?? 'n/a'}`);
      console.log(`      Size: ${trade.size ?? '0'}`);
      console.log(`      Price: ${trade.price ?? '0'}`);
      console.log(`      USD Amount: ${trade.usd_amount ?? '0'}`);
      console.log(`      Ask Client ID: ${trade.ask_client_id ?? 'n/a'}`);
      console.log(`      Bid Client ID: ${trade.bid_client_id ?? 'n/a'}`);
      console.log(`      Taker Fee: ${trade.taker_fee ?? '0'}`);
      console.log(`      Maker Fee: ${trade.maker_fee ?? '0'}`);
      console.log(`      Timestamp: ${trade.timestamp ?? 'n/a'}`);
    }
  }

  console.log('');
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down...');
  ws?.close();
  process.exit(0);
});

// Start
connect();

console.log('\n📡 Listening for orders and trades...\n');
console.log('Press Ctrl+C to stop\n');
