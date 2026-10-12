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

export interface LighterTrade {
  tradeId: string;
  marketId: number;
  time: number;
  price: number;
  size: number;
  usdAmount: number | null;
  aggressorSide: 'buy' | 'sell';
  type: string;
  isLiquidation: boolean;
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

interface LighterTradeMessageItem {
  trade_id?: number;
  trade_id_str?: string;
  market_id?: number;
  timestamp?: number;
  price?: string | number;
  size?: string | number;
  usd_amount?: string | number;
  is_maker_ask?: boolean;
  type?: string;
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

interface TradeMessage {
  type: string;
  channel?: string;
  trades?: LighterTradeMessageItem[];
  liquidation_trades?: LighterTradeMessageItem[];
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export class LighterWsClient {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private stopped = false;
  private lastMessageTime = 0;
  private staleDataTimeout?: NodeJS.Timeout;

  constructor(
    private readonly marketId: number,
    private readonly resolution: string,
    private readonly onCandle: (candle: Candle) => void,
    private readonly onPrice: (price: MarketPrice) => void,
    private readonly onTrade: (trade: LighterTrade) => void
  ) {}

  connect(): void {
    this.stopped = false;
    this.lastMessageTime = Date.now();
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

    if (this.staleDataTimeout) {
      clearTimeout(this.staleDataTimeout);
      this.staleDataTimeout = undefined;
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

      this.lastMessageTime = Date.now();

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

      ws.send(
        JSON.stringify({
          type: 'subscribe',
          channel: `trade/${this.marketId}`
        })
      );

      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30_000);

      this.scheduleStaleDataCheck();
    });

    ws.on('message', raw => {
      try {
        this.lastMessageTime = Date.now();

        const message = JSON.parse(raw.toString()) as
          | CandleMessage
          | MarketStatsMessage
          | TradeMessage;

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
            lastTradePrice: toFiniteNumber(stats?.last_trade_price),
            markPrice: toFiniteNumber(stats?.mark_price),
            indexPrice: toFiniteNumber(stats?.index_price),
            midPrice: toFiniteNumber(stats?.mid_price),
            bestBid: toFiniteNumber(stats?.best_bid_price),
            bestAsk: toFiniteNumber(stats?.best_ask_price)
          });

          return;
        }

        if (
          message.type === 'subscribed/trade' ||
          message.type === 'update/trade'
        ) {
          const tradeMessage = message as TradeMessage;

          for (const trade of tradeMessage.trades ?? []) {
            this.handleTrade(trade, false);
          }

          for (const trade of tradeMessage.liquidation_trades ?? []) {
            this.handleTrade(trade, true);
          }
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

      if (this.staleDataTimeout) {
        clearTimeout(this.staleDataTimeout);
        this.staleDataTimeout = undefined;
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

  private handleTrade(
    raw: LighterTradeMessageItem,
    isLiquidation: boolean
  ): void {
    const price = toFiniteNumber(raw.price);
    const size = toFiniteNumber(raw.size);
    const time = toFiniteNumber(raw.timestamp);
    const marketId = toFiniteNumber(raw.market_id);

    if (
      price === null ||
      size === null ||
      time === null ||
      marketId !== this.marketId ||
      typeof raw.is_maker_ask !== 'boolean'
    ) {
      console.error(
        `[${new Date().toISOString()}] Invalid Lighter trade`,
        raw
      );
      return;
    }

    this.onTrade({
      tradeId: raw.trade_id_str ?? String(raw.trade_id ?? ''),
      marketId,
      time,
      price,
      size,
      usdAmount: toFiniteNumber(raw.usd_amount),
      aggressorSide: raw.is_maker_ask ? 'sell' : 'buy',
      type: raw.type ?? (isLiquidation ? 'liquidation' : 'trade'),
      isLiquidation
    });
  }

  private scheduleStaleDataCheck(): void {
    if (this.stopped) {
      return;
    }

    this.staleDataTimeout = setTimeout(() => {
      const timeSinceLastMessage = Date.now() - this.lastMessageTime;
      const staleThreshold = 90_000;

      if (timeSinceLastMessage > staleThreshold) {
        console.warn(
          `[${new Date().toISOString()}] Lighter WebSocket stale data detected ` +
            `market=${this.marketId}, last message ${Math.floor(timeSinceLastMessage / 1000)}s ago`
        );

        this.ws?.close();
      } else {
        this.scheduleStaleDataCheck();
      }
    }, 60_000);
  }
}
