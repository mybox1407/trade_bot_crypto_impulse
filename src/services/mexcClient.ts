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
  positionId?: number;
  symbol: string;
  side: FuturesOrderSide;
  type: 5;
  quantity: number;
  price: number;
  executedQty: number;
  executedQuoteQty: number;
  avgPrice: number;
  entryFee: number;
  exitFee: number;
  totalFee: number;
  realizedPnL: number;
  feeCurrency?: string;
  state: number;
  createdAt: number;
}

interface FuturesOrderDetails {
  orderId: string;
  positionId?: number;
  symbol: string;
  price: number;
  quantity: number;
  leverage: number;
  side: FuturesOrderSide;
  dealAvgPrice: number;
  dealQty: number;
  orderMargin: number;
  takerFee: number;
  makerFee: number;
  profit: number;
  feeCurrency?: string;
  openType: 1 | 2;
  state: number;
  createTime: number;
  updateTime: number;
  positionMode?: 1 | 2;
}

interface FuturesDeal {
  id: string;
  symbol: string;
  side: FuturesOrderSide;
  quantity: number;
  price: number;
  fee: number;
  feeCurrency?: string;
  profit: number;
  orderId: string;
  timestamp: number;
  isTaker?: boolean;
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

const FILLED_STATE = 3;

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

    if (normalized.includes('_')) {
      return normalized;
    }

    if (normalized.endsWith('USDT')) {
      return `${normalized.slice(0, -4)}_USDT`;
    }

    throw new Error(
      `Invalid Futures symbol "${symbol}". Expected BASE_USDT`
    );
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
    params: Record<string, RequestValue> = {}
  ): Promise<any> {
    const requestTime = Date.now().toString();
    const queryString = this.buildQueryString(params);
    const signature = this.signQueryString(queryString);

    const query = queryString
      ? `${queryString}&signature=${signature}`
      : `signature=${signature}`;

    const url =
      `${this.futuresUrl}${endpoint}?${query}`;

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

  private parseOrderDetails(
    raw: any
  ): FuturesOrderDetails {
    const data = raw?.data ?? raw;

    return {
      orderId: String(data.orderId),
      positionId:
        data.positionId != null
          ? Number(data.positionId)
          : undefined,
      symbol: String(data.symbol),
      price: Number(data.price ?? 0),
      quantity: Number(data.vol ?? 0),
      leverage: Number(data.leverage ?? 1),
      side: Number(data.side) as FuturesOrderSide,
      dealAvgPrice: Number(data.dealAvgPrice ?? 0),
      dealQty: Number(
        data.dealVol ?? data.dealQty ?? 0
      ),
      orderMargin: Number(
        data.orderMargin ?? data.usedMargin ?? 0
      ),
      takerFee: Number(data.takerFee ?? 0),
      makerFee: Number(data.makerFee ?? 0),
      profit: Number(data.profit ?? 0),
      feeCurrency: data.feeCurrency
        ? String(data.feeCurrency)
        : undefined,
      openType: Number(data.openType) === 2
        ? CROSS_MARGIN
        : ISOLATED_MARGIN,
      state: Number(data.state ?? 0),
      createTime: Number(
        data.createTime ?? Date.now()
      ),
      updateTime: Number(
        data.updateTime ?? Date.now()
      ),
      positionMode:
        Number(data.positionMode) === 2
          ? 2
          : 1
    };
  }

  private parseDeals(
    raw: any
  ): FuturesDeal[] {
    const rows = Array.isArray(raw?.data)
      ? raw.data
      : [];

    return rows.map((data: any) => ({
      id: String(data.id),
      symbol: String(data.symbol),
      side: Number(data.side) as FuturesOrderSide,
      quantity: Number(data.vol ?? 0),
      price: Number(data.price ?? 0),
      fee: Number(data.fee ?? 0),
      feeCurrency: data.feeCurrency
        ? String(data.feeCurrency)
        : undefined,
      profit: Number(data.profit ?? 0),
      orderId: String(data.orderId),
      timestamp: Number(
        data.timestamp ?? Date.now()
      ),
      isTaker:
        data.isTaker === true ||
        data.taker === true
    }));
  }

  async getFuturesOrderDetails(
    orderId: string
  ): Promise<FuturesOrderDetails> {
    const response = await this.futuresRequest(
      'GET',
      `/api/v1/private/order/get/${encodeURIComponent(orderId)}`
    );

    return this.parseOrderDetails(response);
  }

  async getFuturesDealDetails(
    orderId: string
  ): Promise<FuturesDeal[]> {
    const response = await this.futuresRequest(
      'GET',
      `/api/v1/private/order/deal_details/${encodeURIComponent(orderId)}`
    );

    return this.parseDeals(response);
  }

  private async waitForFilledOrder(
    orderId: string,
    timeoutMs = 10_000,
    pollIntervalMs = 250
  ): Promise<{
    details: FuturesOrderDetails;
    deals: FuturesDeal[];
  }> {
    const startedAt = Date.now();
    let lastDetails: FuturesOrderDetails | null = null;

    while (Date.now() - startedAt < timeoutMs) {
      const details =
        await this.getFuturesOrderDetails(orderId);

      lastDetails = details;

      if (details.state === FILLED_STATE) {
        const deals =
          await this.getFuturesDealDetails(orderId);

        return {
          details,
          deals
        };
      }

      if (
        details.state === 4 ||
        details.state === 5
      ) {
        throw new Error(
          `Futures order ${orderId} was not filled. ` +
            `state=${details.state}`
        );
      }

      await new Promise(resolve => {
        setTimeout(resolve, pollIntervalMs);
      });
    }

    throw new Error(
      `Futures order ${orderId} was not filled within ` +
        `${timeoutMs}ms. Last state=${lastDetails?.state ?? 'unknown'}`
    );
  }

  private makeFilledOrder(
    details: FuturesOrderDetails,
    deals: FuturesDeal[],
    requestedQuantity: number
  ): FuturesOrder {
    const dealQuantity =
      details.dealQty > 0
        ? details.dealQty
        : deals.reduce(
            (sum, deal) => sum + deal.quantity,
            0
          );

    const weightedQuote =
      deals.reduce(
        (sum, deal) =>
          sum + deal.quantity * deal.price,
        0
      );

    const dealAvgPrice =
      details.dealAvgPrice > 0
        ? details.dealAvgPrice
        : dealQuantity > 0 && weightedQuote > 0
          ? weightedQuote / dealQuantity
          : 0;

    const dealFees =
      deals.reduce(
        (sum, deal) => sum + Math.max(0, deal.fee),
        0
      );

    const fallbackFee =
      Math.max(0, details.takerFee) +
      Math.max(0, details.makerFee);

    const totalFee =
      dealFees > 0
        ? dealFees
        : fallbackFee;

    const realizedPnL =
      details.profit ||
      deals.reduce(
        (sum, deal) => sum + deal.profit,
        0
      );

    const executedQty =
      dealQuantity > 0
        ? dealQuantity
        : requestedQuantity;

    const executedQuoteQty =
      executedQty > 0 && dealAvgPrice > 0
        ? executedQty * dealAvgPrice
        : 0;

    return {
      orderId: details.orderId,
      positionId: details.positionId,
      symbol: details.symbol,
      side: details.side,
      type: FUTURES_MARKET_ORDER_TYPE,
      quantity: details.quantity || requestedQuantity,
      price: details.price,
      executedQty,
      executedQuoteQty,
      avgPrice: dealAvgPrice,
      entryFee: details.side === 1 ||
        details.side === 3
        ? totalFee
        : 0,
      exitFee: details.side === 2 ||
        details.side === 4
        ? totalFee
        : 0,
      totalFee,
      realizedPnL,
      feeCurrency:
        details.feeCurrency ??
        deals.find(
          deal => deal.feeCurrency
        )?.feeCurrency,
      state: details.state,
      createdAt: details.createTime
    };
  }

  async openFuturesPosition(
    symbol: string,
    positionSide: 'long' | 'short',
    quantity: number,
    leverage: number,
    marginMode: 'isolated' | 'cross' = 'isolated',
    positionMode: 1 | 2 = 1
  ): Promise<FuturesOrder> {
    const futuresSymbol =
      this.normalizeFuturesSymbol(symbol);

    if (
      !Number.isInteger(leverage) ||
      leverage < 1 ||
      leverage > 200
    ) {
      throw new Error(
        `Invalid leverage: ${leverage}`
      );
    }

    if (
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      throw new Error(
        `Invalid Futures quantity: ${quantity}`
      );
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
      `[MEXC Futures] OPEN ` +
        `${positionSide.toUpperCase()} ` +
        `${futuresSymbol} side=${side} ` +
        `vol=${quantity} ${leverage}x`
    );

    const response = await this.futuresRequest(
      'POST',
      '/api/v1/private/order/create',
      params
    );

    const orderId =
      String(response.data?.orderId ?? '');

    if (!orderId) {
      throw new Error(
        'MEXC Futures returned no orderId ' +
          'for opening order'
      );
    }

    const filled =
      await this.waitForFilledOrder(orderId);

    return this.makeFilledOrder(
      filled.details,
      filled.deals,
      quantity
    );
  }

  async closeFuturesPosition(
    symbol: string,
    positionSide: 'long' | 'short',
    quantity: number,
    positionId?: number,
    positionMode: 1 | 2 = 1
  ): Promise<FuturesOrder> {
    const futuresSymbol =
      this.normalizeFuturesSymbol(symbol);

    if (
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      throw new Error(
        `Invalid Futures close quantity: ${quantity}`
      );
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
      `[MEXC Futures] CLOSE ` +
        `${positionSide.toUpperCase()} ` +
        `${futuresSymbol} side=${side} ` +
        `vol=${quantity}`
    );

    const response = await this.futuresRequest(
      'POST',
      '/api/v1/private/order/create',
      params
    );

    const orderId =
      String(response.data?.orderId ?? '');

    if (!orderId) {
      throw new Error(
        'MEXC Futures returned no orderId ' +
          'for closing order'
      );
    }

    const filled =
      await this.waitForFilledOrder(orderId);

    return this.makeFilledOrder(
      filled.details,
      filled.deals,
      quantity
    );
  }

  async setFuturesLeverage(
    symbol: string,
    leverage: number,
    marginMode: 'isolated' | 'cross' = 'isolated'
  ): Promise<void> {
    const futuresSymbol =
      this.normalizeFuturesSymbol(symbol);

    console.warn(
      `[MEXC Futures] Leverage must be configured ` +
        `according to the current account endpoint schema: ` +
        `${futuresSymbol} ${leverage}x ${marginMode}`
    );

    // Здесь намеренно нет неподтверждённого POST.
    // Настройте плечо заранее в MEXC либо добавьте
    // актуальный endpoint после проверки документации
    // именно для вашего API-доступа.
  }

  async getFuturesAccount(): Promise<{
    available: number;
    total: number;
    unrealizedPnl: number;
  }> {
    const response = await this.futuresRequest(
      'GET',
      '/api/v1/private/account/assets',
      {}
    );

    const rows = Array.isArray(response.data)
      ? response.data
      : [];

    const usdt = rows.find(
      (row: any) =>
        String(row.currency ?? row.asset)
          .toUpperCase() === 'USDT'
    );

    return {
      available: Number(
        usdt?.availableBalance ??
        usdt?.available ??
        0
      ),
      total: Number(
        usdt?.equity ??
        usdt?.totalBalance ??
        usdt?.balance ??
        0
      ),
      unrealizedPnl: Number(
        usdt?.unrealisedPnl ??
        usdt?.unrealizedPnl ??
        0
      )
    };
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
      positionId:
        row.positionId != null
          ? String(row.positionId)
          : undefined,
      symbol: String(row.symbol),
      positionType:
        Number(row.positionType) === 1
          ? 1
          : 2,
      quantity: Math.abs(
        Number(
          row.holdVol ??
          row.holdQty ??
          0
        )
      ),
      entryPrice: Number(
        row.openAvgPrice ??
        row.openPrice ??
        0
      ),
      markPrice: Number(
        row.fairPrice ??
        row.markPrice ??
        0
      ),
      unrealizedPnl: Number(
        row.unrealisedPnl ??
        row.unrealizedPnl ??
        0
      ),
      liquidationPrice: Number(
        row.liquidatePrice ??
        row.liquidationPrice ??
        0
      ),
      leverage: Number(
        row.leverage ?? 1
      ),
      margin: Number(
        row.im ??
        row.margin ??
        0
      )
    }));
  }

  async getFuturesMarkPrice(
    symbol: string
  ): Promise<{
    symbol: string;
    markPrice: number;
    indexPrice: number;
    fundingRate: number;
  }> {
    const futuresSymbol =
      this.normalizeFuturesSymbol(symbol);

    const response =
      await this.futuresRequest(
        'GET',
        `/api/v1/contract/index_price/${encodeURIComponent(futuresSymbol)}`,
        {}
      );

    const data = response.data ?? {};

    return {
      symbol: futuresSymbol,
      markPrice: Number(
        data.fairPrice ??
        data.markPrice ??
        data.indexPrice ??
        0
      ),
      indexPrice: Number(
        data.indexPrice ?? 0
      ),
      fundingRate: Number(
        data.fundingRate ?? 0
      )
    };
  }
}
