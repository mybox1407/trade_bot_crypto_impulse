// src/services/mexcClient.ts

import crypto from 'crypto';

type RequestValue = string | number | boolean;

export type FuturesOrderSide = 1 | 2 | 3 | 4;
export type FuturesMarginMode = 'isolated' | 'cross';
export type FuturesPositionMode = 1 | 2;

export interface TradeFee {
  symbol: string;
  makerFeeRate: number;
  takerFeeRate: number;
  source: 'account_real';
  originalMakerFee?: number;
  originalTakerFee?: number;
}

export interface MexcFeeDetails {
  symbol: string;
  originalMakerFee: number;
  originalTakerFee: number;
  realMakerFee: number;
  realTakerFee: number;
  minLeverage?: number;
  maxLeverage?: number;
  isMaxLeverage?: boolean;
}

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
  openType?: 1 | 2;
  positionMode?: FuturesPositionMode;
}

export interface FuturesPosition {
  positionId?: string;
  symbol: string;
  positionType: 1 | 2;
  openType: 1 | 2;
  positionMode?: FuturesPositionMode;
  quantity: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  liquidationPrice: number;
  leverage: number;
  margin: number;
  realizedPnl?: number;
  totalFee?: number;
}

export interface FuturesOrderDetails {
  orderId: string;
  positionId?: number;
  symbol: string;
  side: FuturesOrderSide;
  quantity: number;
  price: number;
  dealQty: number;
  dealAvgPrice: number;
  takerFee: number;
  makerFee: number;
  totalFee: number;
  profit: number;
  feeCurrency?: string;
  state: number;
  createTime: number;
  updateTime: number;
  openType?: 1 | 2;
  positionMode?: FuturesPositionMode;
  leverage?: number;
}

export interface FuturesDeal {
  id: string;
  orderId: string;
  symbol: string;
  side: FuturesOrderSide;
  quantity: number;
  price: number;
  fee: number;
  feeCurrency?: string;
  profit: number;
  timestamp: number;
}

interface FuturesRequestOptions {
  timeoutMs?: number;
  recvWindow?: number;
}

const FUTURES_SIDE = {
  OPEN_LONG: 1,
  CLOSE_SHORT: 2,
  OPEN_SHORT: 3,
  CLOSE_LONG: 4
} as const;

const FUTURES_POSITION_TYPE = {
  LONG: 1,
  SHORT: 2
} as const;

const FUTURES_MARKET_ORDER_TYPE = 5;

const ISOLATED_MARGIN = 1;
const CROSS_MARGIN = 2;

const ORDER_STATE_PENDING = 1;
const ORDER_STATE_UNFILLED = 2;
const ORDER_STATE_FILLED = 3;
const ORDER_STATE_CANCELED = 4;
const ORDER_STATE_INVALID = 5;

const DEFAULT_RECV_WINDOW = 10_000;
const DEFAULT_REQUEST_TIMEOUT = 15_000;
const DEFAULT_ORDER_TIMEOUT = 10_000;
const DEFAULT_POLL_INTERVAL = 250;

export class MexcAuthenticatedClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly futuresUrl =
    'https://contract.mexc.com';

  constructor() {
    const apiKey = process.env.MEXC_API_KEY;
    const apiSecret = process.env.MEXC_API_SECRET;

    if (!apiKey || !apiSecret) {
      throw new Error(
        'MEXC_API_KEY and MEXC_API_SECRET are required'
      );
    }

    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  private normalizeFuturesSymbol(
    symbol: string
  ): string {
    const normalized = symbol
      .trim()
      .toUpperCase()
      .replace('/', '_')
      .replace('-', '_');

    if (normalized.includes('_')) {
      return normalized;
    }

    if (normalized.endsWith('USDT')) {
      return `${normalized.slice(0, -4)}_USDT`;
    }

    if (normalized.endsWith('USDC')) {
      return `${normalized.slice(0, -4)}_USDC`;
    }

    throw new Error(
      `Invalid Futures symbol "${symbol}". ` +
      `Expected format BASE_USDT, BASE_USDC, ` +
      `BASEUSDT or BASEUSDC`
    );
  }

  private toFiniteNumber(
    value: unknown,
    fallback = 0
  ): number {
    const parsed = Number(value);

    return Number.isFinite(parsed)
      ? parsed
      : fallback;
  }

  private requirePositiveNumber(
    value: unknown,
    field: string
  ): number {
    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `Invalid positive number for ${field}: ${String(value)}`
      );
    }

    return parsed;
  }

  private validatePositionSide(
    positionSide: string
  ): asserts positionSide is 'long' | 'short' {
    if (
      positionSide !== 'long' &&
      positionSide !== 'short'
    ) {
      throw new Error(
        `Invalid position side: ${positionSide}`
      );
    }
  }

  private validateMarginMode(
    marginMode: string
  ): asserts marginMode is FuturesMarginMode {
    if (
      marginMode !== 'isolated' &&
      marginMode !== 'cross'
    ) {
      throw new Error(
        `Invalid margin mode: ${marginMode}`
      );
    }
  }

  private validatePositionMode(
    positionMode: number
  ): asserts positionMode is FuturesPositionMode {
    if (
      positionMode !== 1 &&
      positionMode !== 2
    ) {
      throw new Error(
        `Invalid position mode: ${positionMode}`
      );
    }
  }

  private validateLeverage(
    leverage: number
  ): void {
    if (
      !Number.isInteger(leverage) ||
      leverage < 1 ||
      leverage > 200
    ) {
      throw new Error(
        `Invalid leverage: ${leverage}. ` +
        `Expected integer from 1 to 200`
      );
    }
  }

  private buildGetQueryString(
    params: Record<string, RequestValue>
  ): string {
    return Object.keys(params)
      .sort()
      .map(key => {
        const value = params[key];

        if (typeof value === 'boolean') {
          return `${key}=${value ? 'true' : 'false'}`;
        }

        return `${key}=${encodeURIComponent(
          String(value)
        )}`;
      })
      .join('&');
  }

  private buildPostBody(
    params: Record<string, RequestValue>
  ): string {
    return JSON.stringify(params);
  }

  private signFuturesRequest(
    requestTime: string,
    parameterString: string
  ): string {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(
        this.apiKey +
        requestTime +
        parameterString
      )
      .digest('hex');
  }

  private futuresHeaders(
    requestTime: string,
    signature: string,
    recvWindow: number
  ): HeadersInit {
    return {
      ApiKey: this.apiKey,
      'Request-Time': requestTime,
      Signature: signature,
      'Recv-Window': String(recvWindow),
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
  }

  private async readResponse(
    response: Response
  ): Promise<any> {
    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `MEXC HTTP ${response.status}: ${text}`
      );
    }

    if (!text) {
      throw new Error(
        'MEXC returned an empty response'
      );
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        `Invalid JSON response from MEXC: ${text}`
      );
    }
  }

  private async futuresRequest(
    method: 'GET' | 'POST',
    endpoint: string,
    params: Record<string, RequestValue> = {},
    options: FuturesRequestOptions = {}
  ): Promise<any> {
    const requestTime = Date.now().toString();

    const recvWindow =
      options.recvWindow ?? DEFAULT_RECV_WINDOW;

    if (
      !Number.isInteger(recvWindow) ||
      recvWindow <= 0
    ) {
      throw new Error(
        `Invalid recvWindow: ${recvWindow}`
      );
    }

    let url =
      `${this.futuresUrl}${endpoint}`;

    let body: string | undefined;
    let parameterString: string;

    if (method === 'GET') {
      parameterString =
        this.buildGetQueryString(params);

      if (parameterString) {
        url += `?${parameterString}`;
      }
    } else {
      parameterString =
        this.buildPostBody(params);

      body = parameterString;
    }

    const signature =
      this.signFuturesRequest(
        requestTime,
        parameterString
      );

    const controller =
      new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT);

    let response: Response;

    try {
      response = await fetch(url, {
        method,
        headers: this.futuresHeaders(
          requestTime,
          signature,
          recvWindow
        ),
        body,
        signal: controller.signal
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      throw new Error(
        `MEXC request failed ${method} ${endpoint}: ` +
        `${message}`
      );
    } finally {
      clearTimeout(timeout);
    }

    const data =
      await this.readResponse(response);

    if (data.success !== true) {
      throw new Error(
        `MEXC Futures API error ` +
        `${data.code ?? 'unknown'}: ` +
        `${data.msg ?? data.message ?? 'Unknown error'}`
      );
    }

    return data;
  }

  private parseOrderDetails(
    response: any
  ): FuturesOrderDetails {
    const data =
      response?.data ?? response;

    if (!data || typeof data !== 'object') {
      throw new Error(
        'MEXC returned invalid order details'
      );
    }

    const side =
      Number(data.side);

    const state =
      Number(data.state);

    if (![1, 2, 3, 4].includes(side)) {
      throw new Error(
        `Invalid order side: ${data.side}`
      );
    }

    if (
      ![
        ORDER_STATE_PENDING,
        ORDER_STATE_UNFILLED,
        ORDER_STATE_FILLED,
        ORDER_STATE_CANCELED,
        ORDER_STATE_INVALID
      ].includes(state)
    ) {
      throw new Error(
        `Invalid order state: ${data.state}`
      );
    }

    const openType =
      data.openType != null
        ? Number(data.openType)
        : undefined;

    const positionMode =
      data.positionMode != null
        ? Number(data.positionMode)
        : undefined;

    return {
      orderId: String(data.orderId ?? ''),
      positionId:
        data.positionId != null
          ? Number(data.positionId)
          : undefined,
      symbol: String(data.symbol ?? ''),
      side: side as FuturesOrderSide,
      quantity: this.toFiniteNumber(
        data.vol ?? data.quantity
      ),
      price: this.toFiniteNumber(
        data.price
      ),
      dealQty: this.toFiniteNumber(
        data.dealVol ?? data.dealQty
      ),
      dealAvgPrice: this.toFiniteNumber(
        data.dealAvgPrice
      ),
      takerFee: this.toFiniteNumber(
        data.takerFee
      ),
      makerFee: this.toFiniteNumber(
        data.makerFee
      ),
      totalFee: this.toFiniteNumber(
        data.totalFee
      ),
      profit: this.toFiniteNumber(
        data.profit
      ),
      feeCurrency:
        data.feeCurrency != null
          ? String(data.feeCurrency)
          : undefined,
      state,
      createTime: this.toFiniteNumber(
        data.createTime,
        Date.now()
      ),
      updateTime: this.toFiniteNumber(
        data.updateTime,
        Date.now()
      ),
      openType:
        openType === 1 || openType === 2
          ? openType
          : undefined,
      positionMode:
        positionMode === 1 ||
        positionMode === 2
          ? positionMode
          : undefined,
      leverage:
        data.leverage != null
          ? this.toFiniteNumber(
              data.leverage
            )
          : undefined
    };
  }

  private parseDeals(
    response: any
  ): FuturesDeal[] {
    const rows =
      Array.isArray(response?.data)
        ? response.data
        : [];

    return rows.map((data: any) => ({
      id: String(data.id ?? ''),
      orderId: String(
        data.orderId ?? ''
      ),
      symbol: String(
        data.symbol ?? ''
      ),
      side: Number(
        data.side
      ) as FuturesOrderSide,
      quantity: this.toFiniteNumber(
        data.vol ?? data.quantity
      ),
      price: this.toFiniteNumber(
        data.price
      ),
      fee: this.toFiniteNumber(
        data.fee
      ),
      feeCurrency:
        data.feeCurrency != null
          ? String(data.feeCurrency)
          : undefined,
      profit: this.toFiniteNumber(
        data.profit
      ),
      timestamp: this.toFiniteNumber(
        data.timestamp,
        Date.now()
      )
    }));
  }

  async getFuturesOrderDetails(
    orderId: string
  ): Promise<FuturesOrderDetails> {
    if (!orderId.trim()) {
      throw new Error(
        'orderId is required'
      );
    }

    const response =
      await this.futuresRequest(
        'GET',
        `/api/v1/private/order/get/` +
        `${encodeURIComponent(orderId)}`
      );

    return this.parseOrderDetails(
      response
    );
  }

  async getFuturesDealDetails(
    orderId: string
  ): Promise<FuturesDeal[]> {
    if (!orderId.trim()) {
      throw new Error(
        'orderId is required'
      );
    }

    const response =
      await this.futuresRequest(
        'GET',
        `/api/v1/private/order/deal_details/` +
        `${encodeURIComponent(orderId)}`
      );

    return this.parseDeals(response);
  }

  private async waitForFilledOrder(
    orderId: string
  ): Promise<{
    details: FuturesOrderDetails;
    deals: FuturesDeal[];
  }> {
    const startedAt =
      Date.now();

    let lastState:
      number | undefined;

    while (
      Date.now() - startedAt <
      DEFAULT_ORDER_TIMEOUT
    ) {
      const details =
        await this.getFuturesOrderDetails(
          orderId
        );

      lastState =
        details.state;

      if (
        details.state ===
        ORDER_STATE_FILLED
      ) {
        return {
          details,
          deals:
            await this.getFuturesDealDetails(
              orderId
            )
        };
      }

      if (
        details.state ===
          ORDER_STATE_CANCELED ||
        details.state ===
          ORDER_STATE_INVALID
      ) {
        throw new Error(
          `Futures order ${orderId} ` +
          `was not filled. ` +
          `state=${details.state}`
        );
      }

      await new Promise(resolve => {
        setTimeout(
          resolve,
          DEFAULT_POLL_INTERVAL
        );
      });
    }

    throw new Error(
      `Futures order ${orderId} was not filled within ` +
      `${DEFAULT_ORDER_TIMEOUT}ms. ` +
      `Last state=${lastState ?? 'unknown'}`
    );
  }

  private makeFilledOrder(
    details: FuturesOrderDetails,
    deals: FuturesDeal[],
    requestedQuantity: number
  ): FuturesOrder {
    const dealsQuantity =
      deals.reduce(
        (sum, deal) =>
          sum + deal.quantity,
        0
      );

    const weightedQuote =
      deals.reduce(
        (sum, deal) =>
          sum +
          deal.quantity *
          deal.price,
        0
      );

    const executedQty =
      details.dealQty > 0
        ? details.dealQty
        : dealsQuantity;

    if (
      !Number.isFinite(executedQty) ||
      executedQty <= 0
    ) {
      throw new Error(
        `Filled order ${details.orderId} ` +
        `has invalid executed quantity ` +
        `${executedQty}. ` +
        `Requested ${requestedQuantity}`
      );
    }

    const avgPrice =
      details.dealAvgPrice > 0
        ? details.dealAvgPrice
        : weightedQuote > 0
          ? weightedQuote / executedQty
          : 0;

    if (
      !Number.isFinite(avgPrice) ||
      avgPrice <= 0
    ) {
      throw new Error(
        `Filled order ${details.orderId} ` +
        `has invalid average price ` +
        `${avgPrice}`
      );
    }

    const executedQuoteQty =
      executedQty * avgPrice;

    const dealsFee =
      deals.reduce(
        (sum, deal) =>
          sum + deal.fee,
        0
      );

    const orderFee =
      details.totalFee !== 0
        ? details.totalFee
        : details.takerFee +
          details.makerFee;

    const totalFee =
      deals.length > 0
        ? dealsFee
        : orderFee;

    const realizedPnL =
      details.profit !== 0
        ? details.profit
        : deals.reduce(
            (sum, deal) =>
              sum + deal.profit,
            0
          );

    const isEntry =
      details.side ===
        FUTURES_SIDE.OPEN_LONG ||
      details.side ===
        FUTURES_SIDE.OPEN_SHORT;

    const isExit =
      details.side ===
        FUTURES_SIDE.CLOSE_LONG ||
      details.side ===
        FUTURES_SIDE.CLOSE_SHORT;

    return {
      orderId: details.orderId,
      positionId: details.positionId,
      symbol: details.symbol,
      side: details.side,
      type: FUTURES_MARKET_ORDER_TYPE,
      quantity:
        details.quantity > 0
          ? details.quantity
          : requestedQuantity,
      price: avgPrice,
      executedQty,
      executedQuoteQty,
      avgPrice,
      entryFee:
        isEntry
          ? totalFee
          : 0,
      exitFee:
        isExit
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
      createdAt: details.createTime,
      openType: details.openType,
      positionMode:
        details.positionMode
    };
  }

  async openFuturesPosition(
    symbol: string,
    positionSide: 'long' | 'short',
    quantity: number,
    leverage: number,
    marginMode: FuturesMarginMode = 'isolated',
    positionMode: FuturesPositionMode = 1
  ): Promise<FuturesOrder> {
    const futuresSymbol =
      this.normalizeFuturesSymbol(
        symbol
      );

    this.validatePositionSide(
      positionSide
    );

    this.validateMarginMode(
      marginMode
    );

    this.validatePositionMode(
      positionMode
    );

    this.validateLeverage(
      leverage
    );

    const validQuantity =
      this.requirePositiveNumber(
        quantity,
        'quantity'
      );

    const side =
      positionSide === 'long'
        ? FUTURES_SIDE.OPEN_LONG
        : FUTURES_SIDE.OPEN_SHORT;

    const params: Record<
      string,
      RequestValue
    > = {
      symbol: futuresSymbol,
      price: 0,
      vol: validQuantity,
      leverage,
      side,
      type: FUTURES_MARKET_ORDER_TYPE,
      openType:
        marginMode === 'isolated'
          ? ISOLATED_MARGIN
          : CROSS_MARGIN,
      positionMode
    };

    const response =
      await this.futuresRequest(
        'POST',
        '/api/v1/private/order/create',
        params
      );

    const orderId =
      String(
        response.data?.orderId ?? ''
      );

    if (!orderId) {
      throw new Error(
        'MEXC returned no orderId for ' +
        'opening order'
      );
    }

    const filled =
      await this.waitForFilledOrder(
        orderId
      );

    return this.makeFilledOrder(
      filled.details,
      filled.deals,
      validQuantity
    );
  }

  async closeFuturesPosition(
    symbol: string,
    positionSide: 'long' | 'short',
    quantity: number,
    positionId?: number,
    marginMode: FuturesMarginMode = 'isolated',
    positionMode: FuturesPositionMode = 1
  ): Promise<FuturesOrder> {
    const futuresSymbol =
      this.normalizeFuturesSymbol(
        symbol
      );

    this.validatePositionSide(
      positionSide
    );

    this.validateMarginMode(
      marginMode
    );

    this.validatePositionMode(
      positionMode
    );

    const validQuantity =
      this.requirePositiveNumber(
        quantity,
        'close quantity'
      );

    if (
      positionId != null &&
      (
        !Number.isInteger(positionId) ||
        positionId <= 0
      )
    ) {
      throw new Error(
        `Invalid positionId: ${positionId}`
      );
    }

    const side =
      positionSide === 'long'
        ? FUTURES_SIDE.CLOSE_LONG
        : FUTURES_SIDE.CLOSE_SHORT;

    const params: Record<
      string,
      RequestValue
    > = {
      symbol: futuresSymbol,
      price: 0,
      vol: validQuantity,
      side,
      type: FUTURES_MARKET_ORDER_TYPE,
      openType:
        marginMode === 'isolated'
          ? ISOLATED_MARGIN
          : CROSS_MARGIN,
      positionMode
    };

    if (positionId != null) {
      params.positionId =
        positionId;
    }

    const response =
      await this.futuresRequest(
        'POST',
        '/api/v1/private/order/create',
        params
      );

    const orderId =
      String(
        response.data?.orderId ?? ''
      );

    if (!orderId) {
      throw new Error(
        'MEXC returned no orderId for ' +
        'closing order'
      );
    }

    const filled =
      await this.waitForFilledOrder(
        orderId
      );

    return this.makeFilledOrder(
      filled.details,
      filled.deals,
      validQuantity
    );
  }

  async setFuturesLeverage(
    symbol: string,
    leverage: number,
    marginMode: FuturesMarginMode = 'isolated',
    positionSide: 'long' | 'short' = 'long',
    positionId?: number
  ): Promise<void> {
    const futuresSymbol =
      this.normalizeFuturesSymbol(
        symbol
      );

    this.validateMarginMode(
      marginMode
    );

    this.validateLeverage(
      leverage
    );

    const params: Record<
      string,
      RequestValue
    > = {
      leverage
    };

    if (positionId != null) {
      if (
        !Number.isInteger(positionId) ||
        positionId <= 0
      ) {
        throw new Error(
          `Invalid positionId: ${positionId}`
        );
      }

      params.positionId =
        positionId;
    } else {
      params.symbol =
        futuresSymbol;

      params.openType =
        marginMode === 'isolated'
          ? ISOLATED_MARGIN
          : CROSS_MARGIN;

      params.positionType =
        positionSide === 'long'
          ? FUTURES_POSITION_TYPE.LONG
          : FUTURES_POSITION_TYPE.SHORT;
    }

    await this.futuresRequest(
      'POST',
      '/api/v1/private/position/change_leverage',
      params
    );
  }

  async getTradeFee(
    symbol: string
  ): Promise<TradeFee> {
    const futuresSymbol =
      this.normalizeFuturesSymbol(symbol);

    const response =
      await this.futuresRequest(
        'GET',
        '/api/v1/private/account/' +
        'tiered_fee_rate/v2',
        {
          symbol: futuresSymbol
        }
      );

    const rawData =
      response?.data;

    const row =
      Array.isArray(rawData)
        ? rawData[0]
        : rawData;

    if (!row || typeof row !== 'object') {
      throw new Error(
        `MEXC personal fee data not found for ` +
        `${futuresSymbol}`
      );
    }

    const realMakerFee =
      this.toFiniteNumber(
        row.realMakerFee,
        NaN
      );

    const realTakerFee =
      this.toFiniteNumber(
        row.realTakerFee,
        NaN
      );

    const originalMakerFee =
      this.toFiniteNumber(
        row.originalMakerFee,
        NaN
      );

    const originalTakerFee =
      this.toFiniteNumber(
        row.originalTakerFee,
        NaN
      );

    if (
      !Number.isFinite(realMakerFee) ||
      !Number.isFinite(realTakerFee) ||
      realMakerFee < 0 ||
      realTakerFee < 0
    ) {
      throw new Error(
        `Invalid personal fee values for ` +
        `${futuresSymbol}: ` +
        `${JSON.stringify(row)}`
      );
    }

    console.log(
      `[${new Date().toISOString()}] 💰 ` +
      `${futuresSymbol}: ` +
      `original maker=` +
      `${
        Number.isFinite(originalMakerFee)
          ? (originalMakerFee * 100).toFixed(4)
          : 'n/a'
      }%, ` +
      `original taker=` +
      `${
        Number.isFinite(originalTakerFee)
          ? (originalTakerFee * 100).toFixed(4)
          : 'n/a'
      }%, ` +
      `real maker=` +
      `${(realMakerFee * 100).toFixed(4)}%, ` +
      `real taker=` +
      `${(realTakerFee * 100).toFixed(4)}%`
    );

    return {
      symbol: futuresSymbol,
      makerFeeRate: realMakerFee,
      takerFeeRate: realTakerFee,
      source: 'account_real',
      originalMakerFee:
        Number.isFinite(originalMakerFee)
          ? originalMakerFee
          : undefined,
      originalTakerFee:
        Number.isFinite(originalTakerFee)
          ? originalTakerFee
          : undefined
    };
  }

  async getFuturesAccount(): Promise<{
    available: number;
    total: number;
    unrealizedPnl: number;
  }> {
    const response =
      await this.futuresRequest(
        'GET',
        '/api/v1/private/account/assets'
      );

    const rows =
      Array.isArray(response?.data)
        ? response.data
        : [];

    console.log(
      `[${new Date().toISOString()}] ` +
      `MEXC Futures account assets: ` +
      `${JSON.stringify(rows)}`
    );

    const usdt =
      rows.find(
        (row: any) =>
          String(
            row.currency ?? ''
          ).toUpperCase() === 'USDT'
      );

    if (!usdt) {
      throw new Error(
        `USDT Futures account asset was not returned. ` +
        `Assets: ${JSON.stringify(rows)}`
      );
    }

    const available =
      this.toFiniteNumber(
        usdt.availableBalance ??
        usdt.availableCash ??
        usdt.availableOpen
      );

    const total =
      this.toFiniteNumber(
        usdt.equity ??
        usdt.cashBalance
      );

    const unrealizedPnl =
      this.toFiniteNumber(
        usdt.unrealized
      );

    console.log(
      `[${new Date().toISOString()}] 💼 ` +
      `MEXC Futures Balance: ` +
      `Total $${total.toFixed(2)}, ` +
      `Available $${available.toFixed(2)}, ` +
      `Unrealized PnL $${unrealizedPnl.toFixed(2)}`
    );

    return {
      available,
      total,
      unrealizedPnl
    };
  }
  
  async getFuturesMarkPrice(
    symbol: string
  ): Promise<{
    symbol: string;
    markPrice: number;
    indexPrice: number;
    fundingRate: number | null;
  }> {
    const futuresSymbol =
      this.normalizeFuturesSymbol(
        symbol
      );

    const response =
      await fetch(
        `${this.futuresUrl}` +
        `/api/v1/contract/ticker?symbol=` +
        `${encodeURIComponent(futuresSymbol)}`
      );

    const data =
      await this.readResponse(response);

    if (data.success === false) {
      throw new Error(
        `MEXC ticker error ` +
        `${data.code ?? 'unknown'}: ` +
        `${data.msg ?? data.message ?? 'Unknown error'}`
      );
    }

    const rows =
      Array.isArray(data.data)
        ? data.data
        : [data.data ?? data];

    const ticker =
      rows.find(
        (row: any) =>
          String(row.symbol ?? '')
            .toUpperCase() ===
          futuresSymbol
      ) ?? rows[0];

    if (!ticker) {
      throw new Error(
        `No Futures ticker returned for ` +
        `${futuresSymbol}`
      );
    }

    const markPrice =
      this.toFiniteNumber(
        ticker.fairPrice ??
        ticker.markPrice ??
        ticker.lastPrice
      );

    if (
      !Number.isFinite(markPrice) ||
      markPrice <= 0
    ) {
      throw new Error(
        `Invalid mark price for ` +
        `${futuresSymbol}`
      );
    }

    return {
      symbol: futuresSymbol,
      markPrice,
      indexPrice: this.toFiniteNumber(
        ticker.indexPrice
      ),
      fundingRate:
        ticker.fundingRate != null
          ? this.toFiniteNumber(
              ticker.fundingRate
            )
          : null
    };
  }

  async getFuturesPositions(): Promise<
    FuturesPosition[]
  > {
    const response =
      await this.futuresRequest(
        'GET',
        '/api/v1/private/position/open_positions'
      );

    const rows =
      Array.isArray(response.data)
        ? response.data
        : [];

    return rows.map((row: any) => {
      const positionType =
        Number(row.positionType);

      const openType =
        Number(row.openType);

      if (
        positionType !== 1 &&
        positionType !== 2
      ) {
        throw new Error(
          `Invalid positionType: ` +
          `${row.positionType}`
        );
      }

      if (
        openType !== 1 &&
        openType !== 2
      ) {
        throw new Error(
          `Invalid openType: ${row.openType}`
        );
      }

      const positionMode =
        row.positionMode != null
          ? Number(row.positionMode)
          : undefined;

      if (
        positionMode != null &&
        positionMode !== 1 &&
        positionMode !== 2
      ) {
        throw new Error(
          `Invalid positionMode: ` +
          `${row.positionMode}`
        );
      }

      return {
        positionId:
          row.positionId != null
            ? String(row.positionId)
            : undefined,
        symbol: String(
          row.symbol ?? ''
        ),
        positionType:
          positionType as 1 | 2,
        openType:
          openType as 1 | 2,
        positionMode:
          positionMode as
            | FuturesPositionMode
            | undefined,
        quantity: Math.abs(
          this.toFiniteNumber(
            row.holdVol ??
            row.holdQty
          )
        ),
        entryPrice: this.toFiniteNumber(
          row.holdAvgPrice ??
          row.openAvgPrice ??
          row.openPrice
        ),
        markPrice: this.toFiniteNumber(
          row.fairPrice ??
          row.markPrice
        ),
        unrealizedPnl: this.toFiniteNumber(
          row.unRealizedPnl ??
          row.unrealisedPnl ??
          row.unrealizedPnl
        ),
        liquidationPrice:
          this.toFiniteNumber(
            row.liquidatePrice ??
            row.liquidationPrice
          ),
        leverage: this.toFiniteNumber(
          row.leverage,
          1
        ),
        margin: this.toFiniteNumber(
          row.im ?? row.margin
        ),
        realizedPnl:
          row.realised != null
            ? this.toFiniteNumber(
                row.realised
              )
            : undefined,
        totalFee:
          row.totalFee != null
            ? this.toFiniteNumber(
                row.totalFee
              )
            : undefined
      };
    });
  }
}
