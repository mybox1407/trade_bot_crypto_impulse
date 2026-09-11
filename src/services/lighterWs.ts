// src/services/lighterWs.ts
import WebSocket from 'ws';

const LIGHTER_WS_URL =
  process.env.LIGHTER_WS_URL ??
  'wss://mainnet.zklighter.elliot.ai/stream';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface LighterCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface CandleMessage {
  type: string;
  channel?: string;
  candles?: LighterCandle[];
}

export class LighterWsClient {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly marketIndex: number,
    private readonly resolution: string,
    private readonly onCandle: (candle: Candle) => void,
  ) {}

  connect() {
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
    }

    this.ws?.close();
  }

  private open() {
    if (this.stopped) return;

    this.ws = new WebSocket(LIGHTER_WS_URL);

    this.ws.on('open', () => {
      this.ws?.send(JSON.stringify({
        type: 'subscribe',
        channel: `candle/${this.marketIndex}/${this.resolution}`,
      }));

      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 60_000);
    });

    this.ws.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString()) as CandleMessage;

        if (
          message.type !== 'subscribed/candle' &&
          message.type !== 'update/candle'
        ) {
          return;
        }

        for (const candle of message.candles ?? []) {
          this.onCandle({
            time: candle.t,
            open: candle.o,
            high: candle.h,
            low: candle.l,
            close: candle.c,
            volume: candle.v,
          });
        }
      } catch (error) {
        console.error('Invalid Lighter WebSocket message:', error);
      }
    });

    this.ws.on('error', error => {
      console.error('Lighter WebSocket error:', error);
    });

    this.ws.on('close', () => {
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
      }

      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.open(), 3_000);
      }
    });
  }
}
