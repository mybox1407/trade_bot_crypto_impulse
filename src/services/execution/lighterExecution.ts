import {
  ExecutionService,
  OpenExecutionRequest,
  CloseExecutionRequest,
  ExecutionResult
} from './types';

import {
  SignerClient
} from 'zklighter-sdk';

const LIGHTER_API_URL =
  process.env.LIGHTER_API_URL ??
  'https://mainnet.zklighter.elliot.ai';

const DEFAULT_SIZE_DECIMALS = 8;
const PRICE_DECIMALS = 2;

interface LighterFill {
  fill_id?: string;
  order_index?: number;
  price?: string | number;
  quantity?: string | number;
  fee?: string | number;
  timestamp?: number;
  is_ask?: number;
}

interface FillsResponse {
  code: number;
  message?: string;
  fills?: LighterFill[];
}

type FillStats = {
  totalQuantity: number;
  averageFillPrice: number;
  totalFee: number;
};

type CreateMarketOrderResult = [
  unknown,
  {
    code?: number;
    message?: string;
    tx_hash?: string;
    txHash?: string;
  } | null,
  string | null
];

export class LighterExecutionService
  implements ExecutionService
{
  private readonly signerClient: SignerClient;

  constructor(
    apiKeyPrivateKey: string,
    private readonly apiKeyIndex: number,
    private readonly accountIndex: number
  ) {
    if (!apiKeyPrivateKey) {
      throw new Error(
        'LighterExecutionService: ' +
          'LIGHTER_API_KEY is required'
      );
    }

    if (
      !Number.isInteger(apiKeyIndex) ||
      apiKeyIndex < 0
    ) {
      throw new Error(
        'LighterExecutionService: ' +
          'apiKeyIndex must be a non-negative integer'
      );
    }

    if (
      !Number.isInteger(accountIndex) ||
      accountIndex < 0
    ) {
      throw new Error(
        'LighterExecutionService: ' +
          'accountIndex must be a non-negative integer'
      );
    }

    const normalizedKey =
      apiKeyPrivateKey.startsWith('0x')
        ? apiKeyPrivateKey.slice(2)
        : apiKeyPrivateKey;

    this.signerClient = new SignerClient(
      LIGHTER_API_URL,
      normalizedKey,
      apiKeyIndex,
      accountIndex
    );
  }

  async openPosition(
    req: OpenExecutionRequest
  ): Promise<ExecutionResult> {
    console.log(
      `[${new Date().toISOString()}] ` +
        `🔵 [LIGHTER] OPEN ` +
        `${req.symbol} ` +
        `(marketId=${req.marketId}) ` +
        `${req.side.toUpperCase()} ` +
        `qty=${req.quantity.toFixed(8)} ` +
        `@ ~${req.expectedPrice.toFixed(6)}`
    );

    try {
      const roundedQuantity =
        this.roundQuantity(req.quantity);

      if (roundedQuantity <= 0) {
        return {
          ok: false,
          status: 'rejected',
          clientOrderId: req.clientOrderId,
          requestedQuantity: req.quantity,
          filledQuantity: 0,
          message:
            `Quantity is too small after rounding: ` +
            `${req.quantity}`
        };
      }

      const clientOrderIndex =
        this.createClientOrderIndex();

      const isAsk =
        req.side === 'long'
          ? false
          : true;

      const result =
        await this.signerClient.create_market_order(
          req.marketId,
          clientOrderIndex,
          roundedQuantity,
          this.encodePrice(req.expectedPrice),
          isAsk,
          false
        ) as CreateMarketOrderResult;

      return this.parseExecutionResult(
        result,
        req,
        roundedQuantity
      );
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ` +
          `🔵 [LIGHTER] OPEN ERROR:`,
        error
      );

      return {
        ok: false,
        status: 'unknown',
        clientOrderId: req.clientOrderId,
        requestedQuantity: req.quantity,
        filledQuantity: 0,
        message:
          error instanceof Error
            ? error.message
            : 'Unknown error'
      };
    }
  }

  async closePosition(
    req: CloseExecutionRequest
  ): Promise<ExecutionResult> {
    console.log(
      `[${new Date().toISOString()}] ` +
        `🔴 [LIGHTER] CLOSE ` +
        `${req.symbol} ` +
        `(marketId=${req.marketId}) ` +
        `${req.positionSide.toUpperCase()} ` +
        `qty=${req.quantity.toFixed(8)} ` +
        `@ ~${req.expectedPrice.toFixed(6)} ` +
        `reason=${req.reason}`
    );

    try {
      const roundedQuantity =
        this.roundQuantity(req.quantity);

      if (roundedQuantity <= 0) {
        return {
          ok: false,
          status: 'rejected',
          clientOrderId: req.clientOrderId,
          requestedQuantity: req.quantity,
          filledQuantity: 0,
          message:
            `Quantity is too small after rounding: ` +
            `${req.quantity}`
        };
      }

      const clientOrderIndex =
        this.createClientOrderIndex();

      const isAsk =
        req.positionSide === 'long'
          ? true
          : false;

      const result =
        await this.signerClient.create_market_order(
          req.marketId,
          clientOrderIndex,
          roundedQuantity,
          this.encodePrice(req.expectedPrice),
          isAsk,
          true
        ) as CreateMarketOrderResult;

      return this.parseExecutionResult(
        result,
        req,
        roundedQuantity
      );
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ` +
          `🔴 [LIGHTER] CLOSE ERROR:`,
        error
      );

      return {
        ok: false,
        status: 'unknown',
        clientOrderId: req.clientOrderId,
        requestedQuantity: req.quantity,
        filledQuantity: 0,
        message:
          error instanceof Error
            ? error.message
            : 'Unknown error'
      };
    }
  }

  private parseExecutionResult(
    result: CreateMarketOrderResult,
    req:
      | OpenExecutionRequest
      | CloseExecutionRequest,
    roundedQuantity: number
  ): ExecutionResult {
    const [
      order,
      apiResponse,
      sdkError
    ] = result;

    if (sdkError) {
      return {
        ok: false,
        status: 'rejected',
        clientOrderId: req.clientOrderId,
        requestedQuantity: req.quantity,
        filledQuantity: 0,
        message: sdkError
      };
    }

    const response =
      apiResponse ?? {};

    const responseCode =
      response.code;

    if (
      responseCode != null &&
      responseCode !== 200
    ) {
      return {
        ok: false,
        status: 'rejected',
        clientOrderId: req.clientOrderId,
        requestedQuantity: req.quantity,
        filledQuantity: 0,
        message:
          response.message ??
          `Lighter API error: ${responseCode}`
      };
    }

    const txHash =
      response.tx_hash ??
      response.txHash;

    const orderRecord =
      order as Record<string, unknown> | null;

    const orderId =
      this.readString(
        orderRecord,
        'order_index',
        'orderIndex',
        'id'
      ) ??
      txHash ??
      `order-${Date.now()}`;

    return {
      ok: true,
      status: 'submitted',
      orderId,
      clientOrderId: req.clientOrderId,
      requestedQuantity: req.quantity,
      filledQuantity: 0,
      message:
        'Order submitted; fill confirmation pending'
    };
  }

  private roundQuantity(
    quantity: number
  ): number {
    if (
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      return 0;
    }

    const multiplier =
      Math.pow(10, DEFAULT_SIZE_DECIMALS);

    return Math.floor(
      quantity * multiplier
    );
  }

  private encodePrice(price: number): number {
    if (
      !Number.isFinite(price) ||
      price <= 0
    ) {
      throw new Error(
        `Invalid order price: ${price}`
      );
    }

    return Math.round(
      price * Math.pow(10, PRICE_DECIMALS)
    );
  }

  private createClientOrderIndex(): number {
    return Date.now();
  }

  private readString(
    object: Record<string, unknown> | null,
    ...keys: string[]
  ): string | undefined {
    if (!object) {
      return undefined;
    }

    for (const key of keys) {
      const value = object[key];

      if (
        typeof value === 'string' &&
        value.length > 0
      ) {
        return value;
      }

      if (
        typeof value === 'number' &&
        Number.isFinite(value)
      ) {
        return String(value);
      }
    }

    return undefined;
  }

  private async fetchFills(
    marketId: number,
    accountIndex: number
  ): Promise<LighterFill[]> {
    const params =
      new URLSearchParams({
        market_id: String(marketId),
        account_index: String(accountIndex)
      });

    const response =
      await fetch(
        `${LIGHTER_API_URL}/api/v1/fills?` +
          params.toString()
      );

    if (!response.ok) {
      const body =
        await response.text();

      throw new Error(
        `Lighter fills request failed: ` +
          `HTTP ${response.status}: ${body}`
      );
    }

    const data =
      await response.json() as FillsResponse;

    if (data.code !== 200) {
      throw new Error(
        `Lighter fills API error: ` +
          `${data.code}: ` +
          `${data.message ?? 'unknown error'}`
      );
    }

    return data.fills ?? [];
  }

  private async waitForFills(
    marketId: number,
    accountIndex: number,
    startedAt: number,
    maxAttempts: number,
    intervalMs: number
  ): Promise<LighterFill[]> {
    for (
      let attempt = 0;
      attempt < maxAttempts;
      attempt++
    ) {
      await this.sleep(intervalMs);

      const fills =
        await this.fetchFills(
          marketId,
          accountIndex
        );

      const newFills =
        fills.filter(fill => {
          const rawTimestamp =
            Number(fill.timestamp);

          if (
            !Number.isFinite(rawTimestamp)
          ) {
            return false;
          }

          const timestampMs =
            rawTimestamp < 10_000_000_000
              ? rawTimestamp * 1000
              : rawTimestamp;

          return timestampMs >= startedAt;
        });

      if (newFills.length > 0) {
        return newFills;
      }
    }

    return [];
  }

  private calculateFillStats(
    fills: LighterFill[]
  ): FillStats {
    let totalQuantity = 0;
    let totalValue = 0;
    let totalFee = 0;

    for (const fill of fills) {
      const quantity =
        Number(fill.quantity);

      const price =
        Number(fill.price);

      const fee =
        Number(fill.fee);

      if (
        !Number.isFinite(quantity) ||
        quantity <= 0 ||
        !Number.isFinite(price) ||
        price <= 0
      ) {
        continue;
      }

      totalQuantity += quantity;
      totalValue += quantity * price;

      if (Number.isFinite(fee)) {
        totalFee += fee;
      }
    }

    return {
      totalQuantity,
      averageFillPrice:
        totalQuantity > 0
          ? totalValue / totalQuantity
          : 0,
      totalFee
    };
  }

  private sleep(
    ms: number
  ): Promise<void> {
    return new Promise(resolve => {
      setTimeout(resolve, ms);
    });
  }
}
