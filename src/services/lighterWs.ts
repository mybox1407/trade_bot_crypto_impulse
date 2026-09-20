// src/services/lighterWs.ts

const LIGHTER_REST_URL =
  process.env.LIGHTER_REST_URL ??
  'https://mainnet.zklighter.elliot.ai/api/v1';

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

interface CandleResponse {
  code: number;
  r: string;
  c: LighterCandle[];
}

interface OrderBookDetailsResponse {
  code: number;
  order_book_details?: Array<{
    last_trade_price?: number;
    mark_price?: number;
    index_price?: number;
  }>;
  spot_order_book_details?: Array<{
    last_trade_price?: number;
    mark_price?: number;
    index_price?: number;
  }>;
}

export class LighterWsClient {
  private pollTimer?: NodeJS.Timeout;
  private stopped = false;
  private lastCandleTime = 0;
  private readonly baseUrl: string;

  constructor(
    private readonly marketId: number,
    private readonly resolution: string,
    private readonly onCandle: (candle: Candle) => void,
    private readonly onPrice: (price: MarketPrice) => void
  ) {
    this.baseUrl = LIGHTER_REST_URL;
    console.log(
      `[Lighter REST] Endpoint: ${this.baseUrl}, ` +
      `market=${this.marketId}, resolution=${this.resolution}`
    );
  }

  connect(): void {
    this.stopped = false;
    this.fetchLoop();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async fetchLoop(): Promise<void> {
    if (this.stopped) return;

    try {
      const now = Math.floor(Date.now() / 1000);
      const start = this.lastCandleTime > 0 
        ? Math.floor(this.lastCandleTime / 1000)
        : now - 3600;

      const url = `${this.baseUrl}/candles?market_id=${this.marketId}` +
        `&resolution=${this.resolution}&start_timestamp=${start}` +
        `&end_timestamp=${now}&count_back=100`;

      const response = await fetch(url);
      const data: CandleResponse = await response.json();

      if (data.code === 200 && data.c) {
        for (const candle of data.c) {
          if (candle.t <= this.lastCandleTime) continue;

          this.onCandle({
            time: candle.t,
            open: candle.o,
            high: candle.h,
            low: candle.l,
            close: candle.c,
            volume: candle.v
          });

          this.lastCandleTime = candle.t;
        }
      } else {
        console.error(
          `[${new Date().toISOString()}] Lighter REST candles error code=${data.code}`
        );
      }

      await this.fetchPrice();
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Lighter REST fetch error:`,
        error
      );
    }

    this.pollTimer = setTimeout(() => this.fetchLoop(), 5000);
  }

  private async fetchPrice(): Promise<void> {
    try {
      const url = `${this.baseUrl}/orderBookDetails?market_id=${this.marketId}`;
      const response = await fetch(url);
      const data: OrderBookDetailsResponse = await response.json();

      if (data.code === 200) {
        const details = data.order_book_details?.[0] ?? 
                        data.spot_order_book_details?.[0];
        
        if (details) {
          this.onPrice({
            lastTradePrice: details.last_trade_price ?? null,
            markPrice: details.mark_price ?? null,
            indexPrice: details.index_price ?? null,
            midPrice: null,
            bestBid: null,
            bestAsk: null
          });
        }
      }
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Lighter REST price fetch error:`,
        error
      );
    }
  }
}
