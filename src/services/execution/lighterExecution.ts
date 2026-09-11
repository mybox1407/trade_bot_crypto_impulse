import WebSocket from 'ws';

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

const LIGHTER_WS_URL =
  process.env.LIGHTER_WS_URL ??
  'wss://mainnet.zklighter.elliot.ai/stream';

const ORDER_WAIT_TIMEOUT_MS = 15_000;

type LighterOrder = {
  order_index?: number | string;
  order_id?: string;
  client_order_index?: number | string;
  client_order_id?: string;
  market_index?: number;
  initial_base_amount?: string;
  remaining_base_amount?: string;
  filled_base_amount?: string;
  filled_quote_amount?: string;
  status?: string;
  type?: string;
  is_ask?: boolean;
  reduce_only?: boolean;
};

type LighterTrade = {
  trade_id?: number | string;
  tx_hash?: string;
  market_id?: number;
  size?: string;
  price?: string;
  usd_amount?: string;
  ask_id?: number | string;
  bid_id?: number | string;
  ask_client_id?: number | string;
  bid_client_id?: number | string;
  ask_account_id?: number;
  bid_account_id?: number;
  taker_fee?: number;
  maker_fee?: number;
  timestamp?: number;
};

type AccountMessage = {
  type?: string;
  channel?: string;
  account?: number;
  orders?: LighterOrder[];
  trades?: LighterTrade[] | Record<string, LighterTrade[]>;
};

type PendingOrder = {
  marketId: number;
  clientOrderIndex: number;
  clientOrderId?: string;
  requestedQuantity: number;
  priceDecimals: number;
  sizeDecimals: number;
  resolve: (
    result: ExecutionResult
  ) => void;
  timer: NodeJS.Timeout;
  fills: {
    quantity: number;
    price: number;
    fee: number;
  }[];
  lastStatus?: string;
  orderId?: string;
};

export class LighterExecutionService
  implements ExecutionService
{
  private readonly signerClient: SignerClient;

  private accountWs?: WebSocket;
  private accountWsReconnectTimer?: NodeJS.Timeout;
  private accountWsPingTimer?: NodeJS.Timeout;
  private accountWsStopped = false;
  private accountWsConnecting = false;
  private authToken?: string;

  private readonly pendingOrders =
    new Map<number, PendingOrder>();

  constructor(
    apiKeySecret: string,
    private readonly apiKeyIndex: number,
    private readonly accountIndex: number
  ) {
    if (!apiKeySecret) {
      throw new Error(
        'LighterExecutionService: ' +
          'LIGHTER_API_SECRET (private key) is required'
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
      apiKeySecret.startsWith('0x')
        ? apiKeySecret.slice(2)
        : apiKeySecret;

    this.signerClient = new SignerClient(
      LIGHTER_API_URL,
      normalizedKey,
      apiKeyIndex,
      accountIndex
    );

    this.startAccountWebSocket();
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
      const baseAmount =
        this.toBaseAmount(
          req.quantity,
          req.sizeDecimals ?? 8
        );

      if (baseAmount <= 0) {
        return this.rejectedResult(
          req,
          `Quantity is too small after conversion: ` +
            `${req.quantity}`
        );
      }

      const clientOrderIndex =
        this.createClientOrderIndex();

      const isAsk =
        req.side === 'long'
          ? false
          : true;

      const submitted =
        await this.submitMarketOrder(
          req.marketId,
          clientOrderIndex,
          baseAmount,
          req.expectedPrice,
          isAsk,
          false,
          req.priceDecimals ?? 2,
          req.sizeDecimals ?? 8
        );

      if (!submitted.ok) {
        return this.rejectedResult(
          req,
          submitted.message
        );
      }

      return await this.waitForOrderExecution(
        req,
        req.marketId,
        clientOrderIndex,
        submitted.orderId,
        req.quantity,
        req.priceDecimals ?? 2,
        req.sizeDecimals ?? 8
      );
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ` +
          `🔵 [LIGHTER] OPEN ERROR:`,
        error
      );

      return this.unknownResult(
        req,
        error instanceof Error
          ? error.message
          : 'Unknown error'
      );
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
      const baseAmount =
        this.toBaseAmount(
          req.quantity,
          req.sizeDecimals ?? 8
        );

      if (baseAmount <= 0) {
        return this.rejectedResult(
          req,
          `Quantity is too small after conversion: ` +
            `${req.quantity}`
        );
      }

      const clientOrderIndex =
        this.createClientOrderIndex();

      const isAsk =
        req.positionSide === 'long'
          ? true
          : false;

      const submitted =
        await this.submitMarketOrder(
          req.marketId,
          clientOrderIndex,
          baseAmount,
          req.expectedPrice,
          isAsk,
          true,
          req.priceDecimals ?? 2,
          req.sizeDecimals ?? 8
        );

      if (!submitted.ok) {
        return this.rejectedResult(
          req,
          submitted.message
        );
      }

      return await this.waitForOrderExecution(
        req,
        req.marketId,
        clientOrderIndex,
        submitted.orderId,
        req.quantity,
        req.priceDecimals ?? 2,
        req.sizeDecimals ?? 8
      );
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ` +
          `🔴 [LIGHTER] CLOSE ERROR:`,
        error
      );

      return this.unknownResult(
        req,
        error instanceof Error
          ? error.message
          : 'Unknown error'
      );
    }
  }

  private async submitMarketOrder(
    marketId: number,
    clientOrderIndex: number,
    baseAmount: number,
    expectedPrice: number,
    isAsk: boolean,
    reduceOnly: boolean,
    priceDecimals: number,
    sizeDecimals: number
  ): Promise<{
    ok: true;
    orderId?: string;
  } | {
    ok: false;
    message: string;
  }> {
    const [
      order,
      tx,
      sdkError
    ] =
      await this.signerClient.create_market_order(
        marketId,
        clientOrderIndex,
        baseAmount,
        this.toPriceUnits(expectedPrice, priceDecimals),
        isAsk,
        reduceOnly,
        -1,
        -1
      );

    if (sdkError) {
      return {
        ok: false,
        message: sdkError
      };
    }

    const orderId =
      this.readExchangeOrderId(
        order as Record<string, unknown> | null
      ) ??
      (tx as unknown as Record<string, unknown>)?.tx_hash as string | undefined ??
      (tx as unknown as Record<string, unknown>)?.txHash as string | undefined;

    console.log(
      `[${new Date().toISOString()}] ` +
        `[LIGHTER] ORDER ACCEPTED ` +
        `clientOrderIndex=${clientOrderIndex} ` +
        `orderId=${orderId ?? 'n/a'}`
    );

    return {
      ok: true,
      orderId
    };
  }

  private async waitForOrderExecution(
    req:
      | OpenExecutionRequest
      | CloseExecutionRequest,
    marketId: number,
    clientOrderIndex: number,
    orderId: string | undefined,
    requestedQuantity: number,
    priceDecimals: number,
    sizeDecimals: number
  ): Promise<ExecutionResult> {
    return new Promise<ExecutionResult>(resolve => {
      const timer =
        setTimeout(() => {
          const pending =
            this.pendingOrders.get(
              clientOrderIndex
            );

          this.pendingOrders.delete(
            clientOrderIndex
          );

          if (!pending) {
            resolve({
              ok: false,
              status: 'unknown',
              orderId: orderId ?? '',
              clientOrderId: req.clientOrderId ?? '',
              requestedQuantity,
              filledQuantity: 0,
              message:
                `Order accepted but execution ` +
                `was not confirmed within ` +
                `${ORDER_WAIT_TIMEOUT_MS}ms`
            });

            return;
          }

          const totalFilled =
            pending.fills.reduce(
              (sum, f) => sum + f.quantity,
              0
            );

          if (totalFilled > 0) {
            const totalQuote =
              pending.fills.reduce(
                (sum, f) =>
                  sum + f.quantity * f.price,
                0
              );

            const avgPrice =
              totalQuote / totalFilled;

            resolve({
              ok: true,
              status: 'filled',
              orderId: pending.orderId ?? orderId ?? '',
              clientOrderId: req.clientOrderId ?? '',
              requestedQuantity,
              filledQuantity: totalFilled,
              averageFillPrice: avgPrice,
              message:
                `Partial fill confirmed after timeout`
            });

            return;
          }

          resolve({
            ok: false,
            status: 'unknown',
            orderId: orderId ?? '',
            clientOrderId: req.clientOrderId ?? '',
            requestedQuantity,
            filledQuantity: 0,
            message:
              `Order accepted but execution ` +
              `was not confirmed within ` +
              `${ORDER_WAIT_TIMEOUT_MS}ms`
          });
        }, ORDER_WAIT_TIMEOUT_MS);

      this.pendingOrders.set(
        clientOrderIndex,
        {
          marketId,
          clientOrderIndex,
          clientOrderId: req.clientOrderId,
          requestedQuantity,
          priceDecimals,
          sizeDecimals,
          resolve,
          timer,
          fills: [],
          lastStatus: undefined,
          orderId
        }
      );

      this.ensureAccountWebSocket();
    });
  }

  private startAccountWebSocket(): void {
    this.accountWsStopped = false;
    this.ensureAccountWebSocket();
  }

  private ensureAccountWebSocket(): void {
    if (
      this.accountWsConnecting ||
      this.accountWs?.readyState === WebSocket.OPEN
    ) {
      return;
    }

    if (this.accountWsStopped) {
      return;
    }

    this.accountWsConnecting = true;

    const ws =
      new WebSocket(LIGHTER_WS_URL);

    this.accountWs = ws;

    ws.on('open', async () => {
      this.accountWsConnecting = false;

      console.log(
        `[${new Date().toISOString()}] ` +
          `[LIGHTER] Account WebSocket connected`
      );

      try {
        if (!this.authToken) {
          const [
            auth,
            authError
          ] =
            this.signerClient
              .create_auth_token_with_expiry(
                60 * 60,
                undefined,
                this.apiKeyIndex
              );

          if (authError || !auth) {
            throw new Error(
              authError ??
                'Failed to create auth token'
            );
          }

          this.authToken = auth;
        }

        ws.send(
          JSON.stringify({
            type: 'subscribe',
            channel: `account_all/${this.accountIndex}`,
            auth: this.authToken
          })
        );

        console.log(
          `[${new Date().toISOString()}] ` +
            `[LIGHTER] Account channel subscribed: account_all/${this.accountIndex}`
        );
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] ` +
            `[LIGHTER] Account WebSocket auth error`,
          error
        );

        ws.close();
      }

      this.accountWsPingTimer =
        setInterval(() => {
          if (
            ws.readyState === WebSocket.OPEN
          ) {
            ws.send(
              JSON.stringify({
                type: 'ping'
              })
            );
          }
        }, 30_000);
    });

    ws.on('message', raw => {
      try {
        const message =
          JSON.parse(
            raw.toString()
          ) as AccountMessage;

        this.handleAccountMessage(
          message
        );
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] ` +
            `[LIGHTER] Invalid account WS message`,
          error
        );
      }
    });

    ws.on('error', error => {
      console.error(
        `[${new Date().toISOString()}] ` +
          `[LIGHTER] Account WebSocket error`,
        error
      );
    });

    ws.on('close', (code, reason) => {
      this.accountWsConnecting = false;

      if (this.accountWsPingTimer) {
        clearInterval(
          this.accountWsPingTimer
        );

        this.accountWsPingTimer =
          undefined;
      }

      console.warn(
        `[${new Date().toISOString()}] ` +
          `[LIGHTER] Account WebSocket closed ` +
          `code=${code} ` +
          `reason=${reason.toString()}`
      );

      if (!this.accountWsStopped) {
        this.accountWsReconnectTimer =
          setTimeout(() => {
            this.ensureAccountWebSocket();
          }, 3_000);
      }
    });
  }

  private handleAccountMessage(
    message: AccountMessage
  ): void {
    const orders =
      Array.isArray(message.orders)
        ? message.orders
        : [];

    for (const order of orders) {
      this.handleOrderUpdate(order);
    }

    const trades =
      this.flattenTrades(message.trades);

    for (const trade of trades) {
      this.handleTradeUpdate(trade);
    }
  }

  private handleOrderUpdate(
    order: LighterOrder
  ): void {
    const clientOrderIndex =
      this.toNumber(
        order.client_order_index
      );

    if (clientOrderIndex == null) {
      return;
    }

    const pending =
      this.pendingOrders.get(
        clientOrderIndex
      );

    if (!pending) {
      return;
    }

    const filledBaseAmountRaw =
      this.toNumber(
        order.filled_base_amount
      ) ?? 0;

    const filledQuoteAmountRaw =
      this.toNumber(
        order.filled_quote_amount
      ) ?? 0;

    const filledQuantity =
      filledBaseAmountRaw /
      Math.pow(10, pending.sizeDecimals);

    const status =
      order.status ?? '';

    pending.lastStatus = status;

    if (
      filledQuantity <= 0
    ) {
      if (
        status.startsWith('canceled') ||
        status === 'filled'
      ) {
        this.resolvePendingOrder(
          clientOrderIndex,
          {
            ok: false,
            status:
              status === 'filled'
                ? 'unknown'
                : 'rejected',
            orderId:
              this.readExchangeOrderId(
                order as Record<
                  string,
                  unknown
                >
              ) ?? pending.orderId ?? '',
            clientOrderId: pending.clientOrderId ?? '',
            requestedQuantity:
              pending.requestedQuantity,
            filledQuantity: 0,
            message:
              `Order status: ${status}`
          }
        );
      }

      return;
    }

    const averageFillPrice =
      filledQuoteAmountRaw > 0 && filledBaseAmountRaw > 0
        ? (
            filledQuoteAmountRaw /
            filledBaseAmountRaw
          )
        : 0;

    if (
      !Number.isFinite(
        averageFillPrice
      ) ||
      averageFillPrice <= 0
    ) {
      return;
    }

    this.resolvePendingOrder(
      clientOrderIndex,
      {
        ok: true,
        status: 'filled',
        orderId:
          this.readExchangeOrderId(
            order as Record<
              string,
              unknown
            >
          ) ?? pending.orderId ?? '',
        clientOrderId: pending.clientOrderId ?? '',
        requestedQuantity:
          pending.requestedQuantity,
        filledQuantity,
        averageFillPrice,
        message:
          order.status ?? 'filled'
      }
    );
  }

  private handleTradeUpdate(
    trade: LighterTrade
  ): void {
    const clientOrderIndex =
      this.toNumber(
        trade.ask_client_id
      ) ??
      this.toNumber(
        trade.bid_client_id
      );

    if (
      clientOrderIndex == null
    ) {
      return;
    }

    const pending =
      this.pendingOrders.get(
        clientOrderIndex
      );

    if (!pending) {
      return;
    }

    if (pending.marketId !== trade.market_id) {
      console.warn(
        `[${new Date().toISOString()}] Trade market_id mismatch: ` +
          `pending=${pending.marketId}, trade=${trade.market_id}, ` +
          `clientOrderIndex=${clientOrderIndex}`
      );

      return;
    }

    const filledQuantityRaw =
      this.toNumber(trade.size);

    const priceRaw =
      this.toNumber(trade.price);

    if (
      filledQuantityRaw == null ||
      filledQuantityRaw <= 0 ||
      priceRaw == null ||
      priceRaw <= 0
    ) {
      return;
    }

    const filledQuantity =
      filledQuantityRaw /
      Math.pow(10, pending.sizeDecimals);

    const price =
      priceRaw /
      Math.pow(10, pending.priceDecimals);

    const fee =
      this.toNumber(
        trade.taker_fee
      ) ??
      this.toNumber(
        trade.maker_fee
      ) ??
      0;

    pending.fills.push({
      quantity: filledQuantity,
      price,
      fee
    });

    const totalFilled =
      pending.fills.reduce(
        (sum, f) => sum + f.quantity,
        0
      );

    if (totalFilled >= pending.requestedQuantity * 0.95) {
      const totalQuote =
        pending.fills.reduce(
          (sum, f) =>
            sum + f.quantity * f.price,
          0
        );

      const avgPrice =
        totalQuote / totalFilled;

      this.resolvePendingOrder(
        clientOrderIndex,
        {
          ok: true,
          status: 'filled',
          orderId: pending.orderId ?? '',
          clientOrderId: pending.clientOrderId ?? '',
          requestedQuantity:
            pending.requestedQuantity,
          filledQuantity: totalFilled,
          averageFillPrice: avgPrice,
          fee:
            pending.fills.reduce(
              (sum, f) => sum + f.fee,
              0
            ),
          message: 'Trade filled'
        }
      );
    }
  }

  private resolvePendingOrder(
    clientOrderIndex: number,
    result: ExecutionResult
  ): void {
    const pending =
      this.pendingOrders.get(
        clientOrderIndex
      );

    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);

    this.pendingOrders.delete(
      clientOrderIndex
    );

    pending.resolve(result);
  }

  private flattenTrades(
    trades:
      | LighterTrade[]
      | Record<string, LighterTrade[]>
      | undefined
  ): LighterTrade[] {
    if (!trades) {
      return [];
    }

    if (Array.isArray(trades)) {
      return trades;
    }

    return Object.values(trades)
      .flat()
      .filter(
        trade => trade != null
      );
  }

  private readExchangeOrderId(
    order: Record<string, unknown> | null
  ): string | undefined {
    if (!order) {
      return undefined;
    }

    for (const key of [
      'order_id',
      'order_index'
    ]) {
      const value =
        order[key];

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

  private readTradeId(
    trade: LighterTrade
  ): string | undefined {
    return (
      this.toString(
        trade.trade_id
      ) ??
      trade.tx_hash
    );
  }

  private toBaseAmount(
    quantity: number,
    sizeDecimals: number
  ): number {
    if (
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      return 0;
    }

    return Math.floor(
      quantity *
        Math.pow(
          10,
          sizeDecimals
        )
    );
  }

  private toPriceUnits(
    price: number,
    priceDecimals: number
  ): number {
    if (
      !Number.isFinite(price) ||
      price <= 0
    ) {
      throw new Error(
        `Invalid order price: ${price}`
      );
    }

    return Math.round(
      price *
        Math.pow(
          10,
          priceDecimals
        )
    );
  }

  private orderSequence = 0;

  private createClientOrderIndex(): number {
    const timestamp = Date.now() * 1000;
    this.orderSequence =
      (this.orderSequence + 1) % 1000;

    return timestamp + this.orderSequence;
  }

  private toNumber(
    value: unknown
  ): number | null {
    const number =
      Number(value);

    return Number.isFinite(number)
      ? number
      : null;
  }

  private toString(
    value: unknown
  ): string | undefined {
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

    return undefined;
  }

  private rejectedResult(
    req:
      | OpenExecutionRequest
      | CloseExecutionRequest,
    message: string
  ): ExecutionResult {
    return {
      ok: false,
      status: 'rejected',
      clientOrderId: req.clientOrderId ?? '',
      requestedQuantity: req.quantity,
      filledQuantity: 0,
      message
    };
  }

  private unknownResult(
    req:
      | OpenExecutionRequest
      | CloseExecutionRequest,
    message: string
  ): ExecutionResult {
    return {
      ok: false,
      status: 'unknown',
      clientOrderId: req.clientOrderId ?? '',
      requestedQuantity: req.quantity,
      filledQuantity: 0,
      message
    };
  }

  stop(): void {
    this.accountWsStopped = true;

    if (this.accountWsReconnectTimer) {
      clearTimeout(
        this.accountWsReconnectTimer
      );

      this.accountWsReconnectTimer =
        undefined;
    }

    if (this.accountWsPingTimer) {
      clearInterval(
        this.accountWsPingTimer
      );

      this.accountWsPingTimer =
        undefined;
    }

    this.accountWs?.close();
    this.accountWs = undefined;

    for (const pending of
      this.pendingOrders.values()) {
      clearTimeout(pending.timer);

      pending.resolve({
        ok: false,
        status: 'unknown',
        clientOrderId: pending.clientOrderId ?? '',
        requestedQuantity:
          pending.requestedQuantity,
        filledQuantity: 0,
        message:
          'Execution service stopped'
      });
    }

    this.pendingOrders.clear();
  }
}
