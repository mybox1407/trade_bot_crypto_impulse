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

export interface MarketPrice {
  lastTradePrice: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  midPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
}

interface LighterCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  V?: number;
  i?: number;
}

interface CandleMessage {
  type: string;
  channel?: string;
  candles?: LighterCandle[];
}

interface MarketStatsMessage {
  type: string;
  channel?: string;
  market_stats?: {
    last_trade_price?: string;
    mark_price?: string;
    index_price?: string;
    mid_price?: string;
    best_bid_price?: string;
    best_ask_price?: string;
  };
}

function toFiniteNumber(value: unknown): number | null {
  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

export class LighterWsClient {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly marketId: number,
    private readonly resolution: string,
    private readonly onCandle: (candle: Candle) => void,
    private readonly onPrice: (price: MarketPrice) => void
  ) {}

  connect(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }

    this.ws?.close();
    this.ws = undefined;
  }

  private open(): void {
    if (this.stopped) {
      return;
    }

    console.log(
      `[${new Date().toISOString()}] Connecting to Lighter WebSocket ` +
        `market=${this.marketId}, timeframe=${this.resolution}`
    );

    const ws = new WebSocket(LIGHTER_WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      console.log(
        `[${new Date().toISOString()}] Lighter WebSocket connected ` +
          `market=${this.marketId}`
      );

      ws.send(
        JSON.stringify({
          type: 'subscribe',
          channel: `candle/${this.marketId}/${this.resolution}`
        })
      );

      ws.send(
        JSON.stringify({
          type: 'subscribe',
          channel: `market_stats/${this.marketId}`
        })
      );

      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30_000);
    });

    ws.on('message', raw => {
      try {
        const message = JSON.parse(
          raw.toString()
        ) as CandleMessage | MarketStatsMessage;

        if (
          message.type === 'subscribed/candle' ||
          message.type === 'update/candle'
        ) {
          const candleMessage = message as CandleMessage;

          for (const candle of candleMessage.candles ?? []) {
            const normalized: Candle = {
              time: candle.t,
              open: candle.o,
              high: candle.h,
              low: candle.l,
              close: candle.c,
              volume: candle.v
            };

            if (
              !Number.isFinite(normalized.time) ||
              !Number.isFinite(normalized.open) ||
              !Number.isFinite(normalized.high) ||
              !Number.isFinite(normalized.low) ||
              !Number.isFinite(normalized.close) ||
              !Number.isFinite(normalized.volume)
            ) {
              console.error(
                `[${new Date().toISOString()}] Invalid Lighter candle`,
                candle
              );

              continue;
            }

            this.onCandle(normalized);
          }

          return;
        }

        if (
          message.type === 'subscribed/market_stats' ||
          message.type === 'update/market_stats'
        ) {
          const statsMessage = message as MarketStatsMessage;
          const stats = statsMessage.market_stats;

          this.onPrice({
            lastTradePrice: toFiniteNumber(
              stats?.last_trade_price
            ),
            markPrice: toFiniteNumber(stats?.mark_price),
            indexPrice: toFiniteNumber(stats?.index_price),
            midPrice: toFiniteNumber(stats?.mid_price),
            bestBid: toFiniteNumber(stats?.best_bid_price),
            bestAsk: toFiniteNumber(stats?.best_ask_price)
          });
        }
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] Invalid Lighter WebSocket message`,
          error
        );
      }
    });

    ws.on('error', error => {
      console.error(
        `[${new Date().toISOString()}] Lighter WebSocket error`,
        error
      );
    });

    ws.on('close', (code, reason) => {
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = undefined;
      }

      console.warn(
        `[${new Date().toISOString()}] Lighter WebSocket closed ` +
          `code=${code} reason=${reason.toString()}`
      );

      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => {
          this.open();
        }, 3_000);
      }
    });
  }
}
