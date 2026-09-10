// src/services/mexcClient.ts
import crypto from 'crypto';

type RequestValue = string | number | boolean;

export interface TradeFee {
  symbol: string;
  makerFeeRate: number;
  takerFeeRate: number;
}

export type FuturesOrderSide = 1 | 2 | 3 | 4;

export interface FuturesOrder {
  orderId: string;
  symbol: string;
  side: FuturesOrderSide;
  type: 5;
  quantity: number;
  price: number;
  executedQty: number;
  executedQuoteQty: number;
  avgPrice: number;
  createdAt: number;
}

export interface FuturesPosition {
  positionId?: string;
  symbol: string;
  positionType: 1 | 2;
  quantity: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  liquidationPrice: number;
  leverage: number;
  margin: number;
}

const FUTURES_SIDE = {
  OPEN_LONG: 1,
  CLOSE_SHORT: 2,
  OPEN_SHORT: 3,
  CLOSE_LONG: 4
} as const;

const FUTURES_MARKET_ORDER_TYPE = 5;
const ISOLATED_MARGIN = 1;
const CROSS_MARGIN = 2;

export class MexcAuthenticatedClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly spotUrl = 'https://api.mexc.com';
  private readonly futuresUrl = 'https://contract.mexc.com';

  constructor() {
    const apiKey = process.env.MEXC_API_KEY;
    const apiSecret = process.env.MEXC_API_SECRET;

    if (!apiKey || !apiSecret) {
      throw new Error('MEXC API credentials not configured');
    }

    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  private normalizeFuturesSymbol(symbol: string): string {
    const normalized = symbol
      .toUpperCase()
      .replace('/', '_')
      .replace('-', '_');

    if (!normalized.includes('_')) {
      if (normalized.endsWith('USDT')) {
        return `${normalized.slice(0, -4)}_USDT`;
      }

      throw new Error(
        `Invalid Futures symbol "${symbol}". Expected format BASE_USDT`
      );
    }

    return normalized;
  }

  private buildQueryString(
    params: Record<string, RequestValue>
  ): string {
    return Object.keys(params)
      .sort()
      .map(key => {
        const value = params[key];

        if (typeof value === 'boolean') {
          return `${key}=${value ? 'true' : 'false'}`;
        }

        return `${key}=${encodeURIComponent(String(value))}`;
      })
      .join('&');
  }

  private signQueryString(queryString: string): string {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
  }

  private futuresHeaders(requestTime: string): HeadersInit {
    return {
      ApiKey: this.apiKey,
      'Request-Time': requestTime,
      'Content-Type': 'application/json'
    };
  }

  private async readResponse(
    response: Response
  ): Promise<any> {
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        `Invalid JSON response from MEXC Futures: ${text}`
      );
    }
  }

  private async futuresRequest(
    method: 'GET' | 'POST',
    endpoint: string,
    params: Record<string, RequestValue>
  ): Promise<any> {
    const requestTime = Date.now().toString();
    const queryString = this.buildQueryString(params);
    const signature = this.signQueryString(queryString);

    const url =
      `${this.futuresUrl}${endpoint}` +
      `?${queryString}&signature=${signature}`;

    const response = await fetch(url, {
      method,
      headers: this.futuresHeaders(requestTime)
    });

    const data = await this.readResponse(response);

    if (data.success !== true) {
      throw new Error(
        `MEXC Futures API error ${data.code ?? 'unknown'}: ` +
          `${data.msg ?? 'Unknown error'}`
      );
    }

    return data;
  }

  async openFuturesPosition(
    symbol: string,
    positionSide: 'long' | 'short',
    quantity: number,
    leverage: number,
    marginMode: 'isolated' | 'cross' = 'isolated',
    positionMode: 1 | 2 = 1
  ): Promise<FuturesOrder> {
    const futuresSymbol = this.normalizeFuturesSymbol(symbol);

    if (!Number.isInteger(leverage) || leverage < 1) {
      throw new Error(`Invalid leverage: ${leverage}`);
    }

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`Invalid Futures quantity: ${quantity}`);
    }

    const side: FuturesOrderSide =
      positionSide === 'long'
        ? FUTURES_SIDE.OPEN_LONG
        : FUTURES_SIDE.OPEN_SHORT;

    const params: Record<string, RequestValue> = {
      symbol: futuresSymbol,
      price: 0,
      vol: quantity,
      leverage,
      side,
      type: FUTURES_MARKET_ORDER_TYPE,
      openType:
        marginMode === 'isolated'
          ? ISOLATED_MARGIN
          : CROSS_MARGIN,
      positionMode
    };

    console.log(
      `[MEXC Futures] OPEN ${positionSide.toUpperCase()} ` +
        `${futuresSymbol} side=${side} vol=${quantity} ` +
        `${leverage}x ${marginMode}`
    );

    const response = await this.futuresRequest(
      'POST',
      '/api/v1/private/order/create',
      params
    );

    const orderId = String(response.data?.orderId ?? '');

    if (!orderId) {
      throw new Error(
        'MEXC Futures returned no orderId for opening order'
      );
    }

    return {
      orderId,
      symbol: futuresSymbol,
      side,
      type: 5,
      quantity,
      price: 0,
      executedQty: 0,
      executedQuoteQty: 0,
      avgPrice: 0,
      createdAt: Number(
        response.data?.ts ?? Date.now()
      )
    };
  }

  async closeFuturesPosition(
    symbol: string,
    positionSide: 'long' | 'short',
    quantity: number,
    positionId?: number,
    positionMode: 1 | 2 = 1
  ): Promise<FuturesOrder> {
    const futuresSymbol = this.normalizeFuturesSymbol(symbol);

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`Invalid Futures close quantity: ${quantity}`);
    }

    const side: FuturesOrderSide =
      positionSide === 'long'
        ? FUTURES_SIDE.CLOSE_LONG
        : FUTURES_SIDE.CLOSE_SHORT;

    const params: Record<string, RequestValue> = {
      symbol: futuresSymbol,
      price: 0,
      vol: quantity,
      side,
      type: FUTURES_MARKET_ORDER_TYPE,
      openType: ISOLATED_MARGIN,
      positionMode
    };

    if (positionId != null) {
      params.positionId = positionId;
    }

    console.log(
      `[MEXC Futures] CLOSE ${positionSide.toUpperCase()} ` +
        `${futuresSymbol} side=${side} vol=${quantity}`
    );

    const response = await this.futuresRequest(
      'POST',
      '/api/v1/private/order/create',
      params
    );

    const orderId = String(response.data?.orderId ?? '');

    if (!orderId) {
      throw new Error(
        'MEXC Futures returned no orderId for closing order'
      );
    }

    return {
      orderId,
      symbol: futuresSymbol,
      side,
      type: 5,
      quantity,
      price: 0,
      executedQty: 0,
      executedQuoteQty: 0,
      avgPrice: 0,
      createdAt: Number(
        response.data?.ts ?? Date.now()
      )
    };
  }

  async setFuturesLeverage(
    symbol: string,
    leverage: number,
    marginMode: 'isolated' | 'cross' = 'isolated'
  ): Promise<void> {
    const futuresSymbol = this.normalizeFuturesSymbol(symbol);

    console.warn(
      `[MEXC Futures] Verify leverage endpoint and account mode ` +
        `before enabling automatic leverage changes: ` +
        `${futuresSymbol} ${leverage}x ${marginMode}`
    );

    // Не вызывайте здесь неподтверждённый endpoint автоматически.
    // Установите leverage заранее в аккаунте MEXC или добавьте
    // отдельный метод после проверки актуального endpoint документации.
  }

  async getFuturesPositions(): Promise<FuturesPosition[]> {
    const response = await this.futuresRequest(
      'GET',
      '/api/v1/private/position/open_positions',
      {}
    );

    const rows = Array.isArray(response.data)
      ? response.data
      : [];

    return rows.map((row: any) => ({
      positionId: row.positionId != null
        ? String(row.positionId)
        : undefined,
      symbol: String(row.symbol),
      positionType: Number(row.positionType) === 1
        ? 1
        : 2,
      quantity: Math.abs(
        Number(row.holdVol ?? row.holdQty ?? 0)
      ),
      entryPrice: Number(
        row.openAvgPrice ?? row.openPrice ?? 0
      ),
      markPrice: Number(
        row.fairPrice ?? row.markPrice ?? 0
      ),
      unrealizedPnl: Number(
        row.unrealisedPnl ?? row.unrealizedPnl ?? 0
      ),
      liquidationPrice: Number(
        row.liquidatePrice ?? row.liquidationPrice ?? 0
      ),
      leverage: Number(row.leverage ?? 1),
      margin: Number(row.im ?? row.margin ?? 0)
    }));
  }
}
