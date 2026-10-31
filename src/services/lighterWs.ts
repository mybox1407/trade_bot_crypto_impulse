import WebSocket from 'ws';

const LIGHTER_WS_URL =
  process.env.LIGHTER_WS_URL ??
  'wss://mainnet.zklighter.elliot.ai/stream';

const RECONNECT_DELAY_MS = 3_000;
const PING_INTERVAL_MS = 30_000;
const STALE_CHECK_INTERVAL_MS = 30_000;
const CONNECTION_STALE_MS = 90_000;
const BOOK_SNAPSHOT_TIMEOUT_MS = 15_000;

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

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBookSnapshot {
  marketId: number;
  receivedAt: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];

  // Дополнительные поля не ломают существующих потребителей.
  nonce?: string;
  isSnapshot?: boolean;
}

export interface LighterTrade {
  tradeId: string;
  marketId: number;
  time: number;
  receivedAt: number;
  transactionTime: number | null;
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

interface CandleMessage {
  type: string;
  channel?: string;
  candles?: LighterCandle[];
}

interface MarketStatsMessage {
  type: string;
  channel?: string;
  market_stats?: {
    last_trade_price?: string | number;
    mark_price?: string | number;
    index_price?: string | number;
    mid_price?: string | number;
    best_bid_price?: string | number;
    best_ask_price?: string | number;
  };
}

interface LighterTradeMessageItem {
  trade_id?: number | string;
  trade_id_str?: string;
  market_id?: number | string;
  timestamp?: number | string;
  transaction_time?: number | string;
  price?: string | number;
  size?: string | number;
  usd_amount?: string | number;
  is_maker_ask?: boolean;
  type?: string;
}

interface TradeMessage {
  type: string;
  channel?: string;
  trades?: LighterTradeMessageItem[];
  liquidation_trades?: LighterTradeMessageItem[];
}

interface OrderBookLevelRaw {
  price?: string | number;
  size?: string | number;
}

interface OrderBookMessage {
  type: string;
  channel?: string;
  order_book?: {
    asks?: OrderBookLevelRaw[];
    bids?: OrderBookLevelRaw[];
    nonce?: string | number;
    begin_nonce?: string | number;
    offset?: string | number;
  };
}

interface ControlMessage {
  type: string;
  channel?: string;
  message?: string;
  code?: number;
}

type IncomingMessage =
  | CandleMessage
  | MarketStatsMessage
  | TradeMessage
  | OrderBookMessage
  | ControlMessage;

function toFiniteNumber(value: unknown): number | null {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

/**
 * Не допускаем неточные числовые nonce.
 * Строковые nonce нормализуем без преобразования в Number.
 */
function toNonce(value: unknown): string | null {
  if (typeof value === 'number') {
    return (
      Number.isSafeInteger(value) &&
      value >= 0
    )
      ? String(value)
      : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  return trimmed.replace(/^0+(?=\d)/, '');
}

/**
 * size = 0 сохраняется: в delta это удаление уровня.
 * Некорректные уровни нельзя молча пропускать,
 * иначе локальная книга может рассинхронизироваться.
 */
function parseLevels(
  raw: OrderBookLevelRaw[] | undefined
): OrderBookLevel[] {
  if (raw === undefined) {
    return [];
  }

  if (!Array.isArray(raw)) {
    throw new Error('Order book levels must be an array');
  }

  const levels: OrderBookLevel[] = [];

  for (const item of raw) {
    const price = toFiniteNumber(item?.price);
    const size = toFiniteNumber(item?.size);

    if (
      price === null ||
      size === null ||
      price <= 0 ||
      size < 0
    ) {
      throw new Error('Invalid order book price or size');
    }

    levels.push({ price, size });
  }

  return levels;
}

function applyLevels(
  target: Map<number, number>,
  levels: OrderBookLevel[]
): void {
  for (const level of levels) {
    if (level.size === 0) {
      target.delete(level.price);
    } else {
      target.set(level.price, level.size);
    }
  }
}

function sortedLevels(
  levels: Map<number, number>,
  descending: boolean
): OrderBookLevel[] {
  return Array.from(
    levels,
    ([price, size]) => ({ price, size })
  ).sort(
    descending
      ? (a, b) => b.price - a.price
      : (a, b) => a.price - b.price
  );
}

export class LighterWsClient {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private staleDataTimeout?: NodeJS.Timeout;
  private bookSnapshotTimeout?: NodeJS.Timeout;

  private stopped = false;
  private lastMessageTime = 0;

  private readonly bidLevels = new Map<number, number>();
  private readonly askLevels = new Map<number, number>();

  private bookInitialized = false;
  private bookNonce: string | null = null;

  constructor(
    private readonly marketId: number,
    private readonly resolution: string,
    private readonly onCandle: (candle: Candle) => void,
    private readonly onPrice: (price: MarketPrice) => void,
    private readonly onTrade: (trade: LighterTrade) => void,
    private readonly onOrderBook: (
      snapshot: OrderBookSnapshot
    ) => void,
    private readonly onOrderBookReset?: (
      reason: string
    ) => void
  ) {}

  connect(): void {
    if (
      this.ws &&
      (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      )
    ) {
      return;
    }

    this.stopped = false;
    this.clearReconnectTimer();
    this.open();
  }

  stop(): void {
    this.stopped = true;

    this.clearReconnectTimer();
    this.clearConnectionTimers();
    this.resetOrderBook('WebSocket client stopped');

    const ws = this.ws;
    this.ws = undefined;

    if (ws) {
      ws.close();
    }
  }

  private open(): void {
    if (this.stopped) {
      return;
    }

    this.clearConnectionTimers();
    this.resetOrderBook('Starting a new WebSocket session');
    this.lastMessageTime = Date.now();

    console.log(
      `[${new Date().toISOString()}] ` +
        `Connecting to Lighter WebSocket ` +
        `market=${this.marketId}, ` +
        `timeframe=${this.resolution}`
    );

    const ws = new WebSocket(LIGHTER_WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws || this.stopped) {
        ws.close();
        return;
      }

      console.log(
        `[${new Date().toISOString()}] ` +
          `Lighter WebSocket connected ` +
          `market=${this.marketId}`
      );

      this.lastMessageTime = Date.now();

      for (const channel of [
        `candle/${this.marketId}/${this.resolution}`,
        `market_stats/${this.marketId}`,
        `trade/${this.marketId}`,
        `order_book/${this.marketId}`
      ]) {
        this.send(ws, {
          type: 'subscribe',
          channel
        });
      }

      this.bookSnapshotTimeout = setTimeout(() => {
        if (
          this.ws === ws &&
          !this.stopped &&
          !this.bookInitialized
        ) {
          this.restartConnection(
            ws,
            'Initial order book snapshot timed out'
          );
        }
      }, BOOK_SNAPSHOT_TIMEOUT_MS);

      this.pingTimer = setInterval(() => {
        if (
          this.ws === ws &&
          ws.readyState === WebSocket.OPEN
        ) {
          this.send(ws, { type: 'ping' });
        }
      }, PING_INTERVAL_MS);

      this.scheduleStaleDataCheck(ws);
    });

    ws.on('message', raw => {
      if (
        this.ws !== ws ||
        this.stopped ||
        ws.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      this.lastMessageTime = Date.now();

      let message: IncomingMessage;

      try {
        const parsed: unknown = JSON.parse(raw.toString());

        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          !('type' in parsed) ||
          typeof parsed.type !== 'string'
        ) {
          throw new Error('WebSocket message has no valid type');
        }

        message = parsed as IncomingMessage;
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] ` +
            `Invalid Lighter WebSocket JSON`,
          error
        );

        // Повреждённое сообщение могло быть delta книги.
        this.restartConnection(
          ws,
          'Invalid WebSocket JSON'
        );
        return;
      }

      try {
        if (message.type === 'ping') {
          this.send(ws, { type: 'pong' });
          return;
        }

        if (message.type === 'pong') {
          return;
        }

        if (message.type === 'error') {
          console.error(
            `[${new Date().toISOString()}] ` +
              `Lighter WebSocket server error`,
            message
          );

          this.restartConnection(
            ws,
            'WebSocket server returned an error'
          );
          return;
        }

        if (
          message.type === 'subscribed/candle' ||
          message.type === 'update/candle'
        ) {
          this.handleCandles(message as CandleMessage);
          return;
        }

        if (
          message.type === 'subscribed/market_stats' ||
          message.type === 'update/market_stats'
        ) {
          this.handleMarketStats(
            message as MarketStatsMessage
          );
          return;
        }

        if (message.type === 'update/trade') {
          const tradeMessage = message as TradeMessage;

          for (const trade of tradeMessage.trades ?? []) {
            this.handleTrade(trade, false);
          }

          for (
            const trade of
            tradeMessage.liquidation_trades ?? []
          ) {
            this.handleTrade(trade, true);
          }

          return;
        }

        if (
          message.type === 'subscribed/order_book' ||
          message.type === 'update/order_book'
        ) {
          this.handleOrderBook(
            message as OrderBookMessage,
            ws
          );
        }
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] ` +
            `Failed to process Lighter message ` +
            `type=${message.type}`,
          error
        );

        if (
          message.type === 'subscribed/order_book' ||
          message.type === 'update/order_book'
        ) {
          this.restartConnection(
            ws,
            'Failed to process order book message'
          );
        }
      }
    });

    ws.on('error', error => {
      if (this.ws !== ws) {
        return;
      }

      console.error(
        `[${new Date().toISOString()}] ` +
          `Lighter WebSocket error`,
        error
      );

      this.restartConnection(
        ws,
        'WebSocket transport error'
      );
    });

    ws.on('close', (code, reason) => {
      // Закрытие старого соединения не должно очищать новое.
      if (this.ws !== ws) {
        return;
      }

      this.ws = undefined;
      this.clearConnectionTimers();
      this.resetOrderBook('WebSocket disconnected');

      console.warn(
        `[${new Date().toISOString()}] ` +
          `Lighter WebSocket closed ` +
          `code=${code} reason=${reason.toString()}`
      );

      this.scheduleReconnect();
    });
  }

  private handleCandles(
    message: CandleMessage
  ): void {
    for (const candle of message.candles ?? []) {
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
          `[${new Date().toISOString()}] ` +
            `Invalid Lighter candle`,
          candle
        );
        continue;
      }

      this.onCandle(normalized);
    }
  }

  private handleMarketStats(
    message: MarketStatsMessage
  ): void {
    const stats = message.market_stats;

    if (!stats) {
      return;
    }

    this.onPrice({
      lastTradePrice:
        toFiniteNumber(stats.last_trade_price),
      markPrice:
        toFiniteNumber(stats.mark_price),
      indexPrice:
        toFiniteNumber(stats.index_price),
      midPrice:
        toFiniteNumber(stats.mid_price),
      bestBid:
        toFiniteNumber(stats.best_bid_price),
      bestAsk:
        toFiniteNumber(stats.best_ask_price)
    });
  }

  private handleOrderBook(
    message: OrderBookMessage,
    ws: WebSocket
  ): void {
    const book = message.order_book;

    if (!book) {
      this.restartConnection(
        ws,
        'Order book payload is missing'
      );
      return;
    }

    const nonce = toNonce(book.nonce);

    if (nonce === null) {
      this.restartConnection(
        ws,
        'Order book nonce is missing or invalid'
      );
      return;
    }

    const isSnapshot =
      message.type === 'subscribed/order_book';

    if (!isSnapshot) {
      if (
        !this.bookInitialized ||
        this.bookNonce === null
      ) {
        this.restartConnection(
          ws,
          'Order book delta received before snapshot'
        );
        return;
      }

      const beginNonce = toNonce(book.begin_nonce);

      if (
        beginNonce === null ||
        beginNonce !== this.bookNonce
      ) {
        console.warn(
          `[${new Date().toISOString()}] ` +
            `Order book continuity lost ` +
            `market=${this.marketId}, ` +
            `expectedBeginNonce=${this.bookNonce}, ` +
            `receivedBeginNonce=${beginNonce}`
        );

        this.restartConnection(
          ws,
          'Order book nonce continuity lost'
        );
        return;
      }
    } else {
      if (
        !Array.isArray(book.bids) ||
        !Array.isArray(book.asks)
      ) {
        this.restartConnection(
          ws,
          'Initial order book snapshot is incomplete'
        );
        return;
      }
    }

    // Парсим обе стороны до изменения локального состояния.
    const bidChanges = parseLevels(book.bids);
    const askChanges = parseLevels(book.asks);

    if (isSnapshot) {
      this.resetOrderBook(
        'Received a new order book snapshot'
      );
    }

    applyLevels(this.bidLevels, bidChanges);
    applyLevels(this.askLevels, askChanges);

    const bids = sortedLevels(this.bidLevels, true);
    const asks = sortedLevels(this.askLevels, false);

    if (bids.length === 0 || asks.length === 0) {
      this.restartConnection(
        ws,
        'Reconstructed order book has an empty side'
      );
      return;
    }

    if (bids[0].price >= asks[0].price) {
      this.restartConnection(
        ws,
        'Reconstructed order book is crossed or locked'
      );
      return;
    }

    this.bookNonce = nonce;
    this.bookInitialized = true;

    if (this.bookSnapshotTimeout) {
      clearTimeout(this.bookSnapshotTimeout);
      this.bookSnapshotTimeout = undefined;
    }

    this.onOrderBook({
      marketId: this.marketId,
      receivedAt: Date.now(),
      bids,
      asks,
      nonce,
      isSnapshot
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
      price <= 0 ||
      size === null ||
      size <= 0 ||
      time === null ||
      marketId !== this.marketId ||
      typeof raw.is_maker_ask !== 'boolean'
    ) {
      console.error(
        `[${new Date().toISOString()}] ` +
          `Invalid Lighter trade`,
        raw
      );
      return;
    }

    const tradeId =
      raw.trade_id_str ??
      (
        raw.trade_id !== undefined
          ? String(raw.trade_id)
          : ''
      );

    if (!tradeId) {
      console.error(
        `[${new Date().toISOString()}] ` +
          `Lighter trade has no trade ID`,
        raw
      );
      return;
    }

    this.onTrade({
      tradeId,
      marketId,
      time,
      receivedAt: Date.now(),
      transactionTime:
        toFiniteNumber(raw.transaction_time),
      price,
      size,
      usdAmount: toFiniteNumber(raw.usd_amount),

      // Maker ask означает, что инициатор сделки купил.
      aggressorSide:
        raw.is_maker_ask ? 'buy' : 'sell',

      type:
        raw.type ??
        (isLiquidation ? 'liquidation' : 'trade'),

      isLiquidation
    });
  }

  private resetOrderBook(reason: string): void {
    this.bidLevels.clear();
    this.askLevels.clear();
    this.bookInitialized = false;
    this.bookNonce = null;

    try {
      this.onOrderBookReset?.(reason);
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ` +
          `Order book reset callback failed`,
        error
      );
    }
  }

  private restartConnection(
    ws: WebSocket,
    reason: string
  ): void {
    if (this.ws !== ws) {
      return;
    }

    console.warn(
      `[${new Date().toISOString()}] ` +
        `Restarting Lighter WebSocket ` +
        `market=${this.marketId}: ${reason}`
    );

    this.ws = undefined;
    this.clearConnectionTimers();
    this.resetOrderBook(reason);

    // Старые message/close callbacks будут проигнорированы.
    ws.terminate();

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;

      if (!this.stopped) {
        this.open();
      }
    }, RECONNECT_DELAY_MS);
  }

  private send(
    ws: WebSocket,
    message: Record<string, unknown>
  ): void {
    if (
      this.ws !== ws ||
      ws.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    ws.send(JSON.stringify(message), error => {
      if (error && this.ws === ws) {
        console.error(
          `[${new Date().toISOString()}] ` +
            `Lighter WebSocket send failed`,
          error
        );

        this.restartConnection(
          ws,
          'WebSocket send failed'
        );
      }
    });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private clearConnectionTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }

    if (this.staleDataTimeout) {
      clearTimeout(this.staleDataTimeout);
      this.staleDataTimeout = undefined;
    }

    if (this.bookSnapshotTimeout) {
      clearTimeout(this.bookSnapshotTimeout);
      this.bookSnapshotTimeout = undefined;
    }
  }

  private scheduleStaleDataCheck(
    ws: WebSocket
  ): void {
    if (this.stopped || this.ws !== ws) {
      return;
    }

    this.staleDataTimeout = setTimeout(() => {
      this.staleDataTimeout = undefined;

      if (this.stopped || this.ws !== ws) {
        return;
      }

      const timeSinceLastMessage =
        Date.now() - this.lastMessageTime;

      if (timeSinceLastMessage > CONNECTION_STALE_MS) {
        this.restartConnection(
          ws,
          `Connection is stale for ` +
            `${Math.floor(timeSinceLastMessage / 1_000)}s`
        );
        return;
      }

      this.scheduleStaleDataCheck(ws);
    }, STALE_CHECK_INTERVAL_MS);
  }
}
