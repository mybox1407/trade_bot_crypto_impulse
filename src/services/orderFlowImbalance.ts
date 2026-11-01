export interface OfiBestQuote {
  bidPrice: number;
  bidSize: number;
  askPrice: number;
  askSize: number;
}

export interface OfiConfig {
  windowMs: number;
  minUpdates: number;
  maxBookAgeMs: number;
}

export interface OfiResult {
  ready: boolean;
  value: number | null;
  normalizedValue: number | null;
  updateCount: number;
  bookAgeMs: number | null;
  reason: string | null;
}

interface OfiEvent {
  receivedAt: number;
  contribution: number;
  depth: number;
}

export const DEFAULT_OFI_CONFIG: Readonly<OfiConfig> = {
  windowMs: 1_000,
  minUpdates: 5,
  maxBookAgeMs: 500
};

function isValidQuote(
  quote: OfiBestQuote
): boolean {
  return (
    Number.isFinite(quote.bidPrice) &&
    Number.isFinite(quote.askPrice) &&
    Number.isFinite(quote.bidSize) &&
    Number.isFinite(quote.askSize) &&
    quote.bidPrice > 0 &&
    quote.askPrice > quote.bidPrice &&
    quote.bidSize > 0 &&
    quote.askSize > 0
  );
}

function quoteChanged(
  previous: OfiBestQuote,
  current: OfiBestQuote
): boolean {
  return (
    previous.bidPrice !== current.bidPrice ||
    previous.bidSize !== current.bidSize ||
    previous.askPrice !== current.askPrice ||
    previous.askSize !== current.askSize
  );
}

function calculateContribution(
  previous: OfiBestQuote,
  current: OfiBestQuote
): number {
  const bidContribution =
    (
      current.bidPrice >= previous.bidPrice
        ? current.bidSize
        : 0
    ) -
    (
      current.bidPrice <= previous.bidPrice
        ? previous.bidSize
        : 0
    );

  const askContribution =
    -(
      current.askPrice <= previous.askPrice
        ? current.askSize
        : 0
    ) +
    (
      current.askPrice >= previous.askPrice
        ? previous.askSize
        : 0
    );

  return bidContribution + askContribution;
}

export class OrderFlowImbalanceTracker {
  private readonly config: OfiConfig;

  private previousQuote:
    | OfiBestQuote
    | null = null;

  private historyStartedAt:
    | number
    | null = null;

  private lastBookReceivedAt:
    | number
    | null = null;

  private events: OfiEvent[] = [];

  constructor(
    config: Partial<OfiConfig> = {}
  ) {
    this.config = {
      ...DEFAULT_OFI_CONFIG,
      ...config
    };

    if (
      !Number.isFinite(this.config.windowMs) ||
      this.config.windowMs <= 0 ||
      !Number.isInteger(this.config.minUpdates) ||
      this.config.minUpdates < 1 ||
      !Number.isFinite(this.config.maxBookAgeMs) ||
      this.config.maxBookAgeMs <= 0
    ) {
      throw new Error(
        'Invalid OFI configuration'
      );
    }
  }

  /**
   * Передавать только best bid/ask корректно
   * восстановленной книги.
   * receivedAt — локальное время получения
   * обновления, в миллисекундах.
   */
  update(
    quote: OfiBestQuote,
    receivedAt = Date.now()
  ): void {
    if (
      !Number.isFinite(receivedAt) ||
      !isValidQuote(quote)
    ) {
      this.reset();
      return;
    }

    if (
      this.lastBookReceivedAt !== null &&
      receivedAt < this.lastBookReceivedAt
    ) {
      this.reset();
      return;
    }

    if (
      this.lastBookReceivedAt !== null &&
      receivedAt - this.lastBookReceivedAt >
        this.config.maxBookAgeMs
    ) {
      this.reset();
    }

    const current: OfiBestQuote = {
      ...quote
    };

    this.lastBookReceivedAt = receivedAt;

    if (this.previousQuote === null) {
      this.previousQuote = current;
      this.historyStartedAt = receivedAt;
      return;
    }

    if (
      quoteChanged(this.previousQuote, current)
    ) {
      const depth =
        (current.bidSize + current.askSize) / 2;

      this.events.push({
        receivedAt,
        contribution: calculateContribution(
          this.previousQuote,
          current
        ),
        depth
      });
    }

    this.previousQuote = current;
    this.prune(receivedAt);
  }

  getResult(
    now = Date.now()
  ): OfiResult {
    if (!Number.isFinite(now)) {
      return {
        ready: false,
        value: null,
        normalizedValue: null,
        updateCount: 0,
        bookAgeMs: null,
        reason: 'Invalid OFI query time'
      };
    }

    const lastReceivedAt =
      this.lastBookReceivedAt;

    const historyStartedAt =
      this.historyStartedAt;

    if (
      lastReceivedAt === null ||
      historyStartedAt === null ||
      this.previousQuote === null
    ) {
      return {
        ready: false,
        value: null,
        normalizedValue: null,
        updateCount: 0,
        bookAgeMs: null,
        reason:
          'OFI order book is unavailable'
      };
    }

    const bookAgeMs =
      now - lastReceivedAt;

    if (bookAgeMs < 0) {
      this.reset();

      return {
        ready: false,
        value: null,
        normalizedValue: null,
        updateCount: 0,
        bookAgeMs: null,
        reason: 'OFI clock moved backwards'
      };
    }

    this.prune(now);

    if (
      bookAgeMs > this.config.maxBookAgeMs
    ) {
      this.reset();

      return {
        ready: false,
        value: null,
        normalizedValue: null,
        updateCount: 0,
        bookAgeMs,
        reason: 'OFI order book is stale'
      };
    }

    const updateCount =
      this.events.length;

    if (
      now - historyStartedAt <
      this.config.windowMs
    ) {
      return {
        ready: false,
        value: null,
        normalizedValue: null,
        updateCount,
        bookAgeMs,
        reason: 'OFI history is warming up'
      };
    }

    if (
      updateCount < this.config.minUpdates
    ) {
      return {
        ready: false,
        value: null,
        normalizedValue: null,
        updateCount,
        bookAgeMs,
        reason:
          'Not enough OFI quote changes: ' +
          `${updateCount}/` +
          `${this.config.minUpdates}`
      };
    }

    const value = this.events.reduce(
      (sum, event) =>
        sum + event.contribution,
      0
    );

    if (!Number.isFinite(value)) {
      this.reset();

      return {
        ready: false,
        value: null,
        normalizedValue: null,
        updateCount: 0,
        bookAgeMs,
        reason: 'Invalid OFI value'
      };
    }

    const depthTotal = this.events.reduce(
      (sum, event) => sum + event.depth,
      0
    );

    const averageDepth =
      this.events.length > 0
        ? depthTotal / this.events.length
        : 0;

    const normalizedValue =
      averageDepth > 0
        ? value / averageDepth
        : null;

    if (
      normalizedValue === null ||
      !Number.isFinite(normalizedValue)
    ) {
      return {
        ready: false,
        value,
        normalizedValue: null,
        updateCount,
        bookAgeMs,
        reason: 'OFI depth is unavailable'
      };
    }

    return {
      ready: true,
      value,
      normalizedValue,
      updateCount,
      bookAgeMs,
      reason: null
    };
  }

  reset(): void {
    this.previousQuote = null;
    this.historyStartedAt = null;
    this.lastBookReceivedAt = null;
    this.events = [];
  }

  private prune(now: number): void {
    const windowStart =
      now - this.config.windowMs;

    let removeCount = 0;

    while (
      removeCount < this.events.length &&
      this.events[removeCount].receivedAt <=
        windowStart
    ) {
      removeCount += 1;
    }

    if (removeCount > 0) {
      this.events.splice(0, removeCount);
    }
  }
}
