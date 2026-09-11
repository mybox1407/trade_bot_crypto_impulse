import WebSocket from 'ws';

const WS_URL =
  process.env.LIGHTER_WS_URL ??
  'wss://mainnet.zklighter.elliot.ai/stream';

const MARKET_ID = 0;
const RESOLUTION = '15m';

const ws = new WebSocket(WS_URL);

const closeTimer = setTimeout(() => {
  console.log('Test finished');

  ws.close();
  process.exit(0);
}, 60_000);

ws.on('open', () => {
  console.log(`Connected: ${WS_URL}`);

  const candleSubscription = {
    type: 'subscribe',
    channel: `candle/${MARKET_ID}/${RESOLUTION}`
  };

  const statsSubscription = {
    type: 'subscribe',
    channel: `market_stats/${MARKET_ID}`
  };

  console.log(
    'Subscribe:',
    JSON.stringify(candleSubscription)
  );

  ws.send(JSON.stringify(candleSubscription));
  ws.send(JSON.stringify(statsSubscription));

  const pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 30_000);

  ws.once('close', () => {
    clearInterval(pingTimer);
  });
});

ws.on('message', raw => {
  console.log(
    `[${new Date().toISOString()}]`,
    raw.toString()
  );
});

ws.on('error', error => {
  console.error('WebSocket error:', error);
});

ws.on('close', (code, reason) => {
  clearTimeout(closeTimer);

  console.log(
    'WebSocket closed:',
    code,
    reason.toString()
  );
});
