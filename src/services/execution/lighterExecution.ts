import WebSocket from 'ws';

import {
  ExecutionService,
  OpenExecutionRequest,
  CloseExecutionRequest,
  ExecutionResult,
  ProtectiveOrders
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
  initial_base_amount?: string | number;
  remaining_base_amount?: string | number;
  filled_base_amount?: string | number;
  filled_quote_amount?: string | number;
  status?: string;
  type?: string;
  is_ask?: boolean;
  reduce_only?: boolean;
};

type LighterTrade = {
  trade_id?: number | string;
  tx_hash?: string;
  market_id?: number;
  size?: string | number;
  price?: string | number;
  usd_amount?: string | number;
  ask_id?: number | string;
  bid_id?: number | string;
  ask_client_id?: number | string;
  bid_client_id?: number | string;
  ask_account_id?: number;
  bid_account_id?: number;
  taker_fee?: number | string;
  maker_fee?: number | string;
  timestamp?: number;
};

type AccountMessage = {
  type?: string;
  channel?: string;
  account?: number;

  orders?:
    | LighterOrder[]
    | Record<string, LighterOrder[]>;

  trades?:
    | LighterTrade[]
    | Record<string, LighterTrade[]>;
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
  fills: Array<{
    quantity: number;
    price: number;
    fee: number;
  }>;
  seenTradeIds: Set<string>;
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

  private orderSequence = 0;

  constructor(
    apiKeySecret: string,
    private readonly apiKeyIndex: number,
    private readonly accountIndex: number
  ) {
    if (!apiKeySecret) {
      throw new Error(
        'LighterExecutionService: ' +
          'LIGHTER_API_SECRET is required'
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
      this.validateProtectiveLevels(req);

      const priceDecimals =
        req.priceDecimals ?? 2;

      const sizeDecimals =
        req.sizeDecimals ?? 8;

      const baseAmount =
        this.toBaseAmount(
          req.quantity,
          sizeDecimals
        );

      if (baseAmount <= 0) {
        return this.rejectedResult(
          req,
          `Quantity is too small after conversion: ` +
            `${req.quantity}`
        );
      }

      const executableQuantity =
        baseAmount /
        Math.pow(10, sizeDecimals);

      const marketClientOrderIndex =
        this.createClientOrderIndex();

      const isAsk =
        req.side === 'short';

      const submitted =
        await this.submitMarketOrder(
          req.marketId,
          marketClientOrderIndex,
          baseAmount,
          req.expectedPrice,
          isAsk,
          false,
          priceDecimals
        );

      if (!submitted.ok) {
        return this.rejectedResult(
          req,
          submitted.message
        );
      }

      const execution =
        await this.waitForOrderExecution(
          req,
          req.marketId,
          marketClientOrderIndex,
          submitted.orderId,
          executableQuantity,
          priceDecimals,
          sizeDecimals
        );

      if (!execution.ok) {
        return execution;
      }

      const actualBaseAmount =
        this.toBaseAmount(
          execution.filledQuantity,
          sizeDecimals
        );

      if (actualBaseAmount <= 0) {
        return {
          ...execution,
          ok: false,
          status: 'unknown',
          message:
            'Execution returned invalid filled quantity'
        };
      }

      const protectiveOrders =
        await this.createProtectiveOrders(
          req,
          actualBaseAmount
        );

      return {
        ...execution,
        protectiveOrders
      };
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
      const priceDecimals =
        req.priceDecimals ?? 2;

      const sizeDecimals =
        req.sizeDecimals ?? 8;

      const baseAmount =
        this.toBaseAmount(
          req.quantity,
          sizeDecimals
        );

      if (baseAmount <= 0) {
        return this.rejectedResult(
          req,
          `Quantity is too small after conversion: ` +
            `${req.quantity}`
        );
      }

      const executableQuantity =
        baseAmount /
        Math.pow(10, sizeDecimals);

      const clientOrderIndex =
        this.createClientOrderIndex();

      const isAsk =
        req.positionSide === 'long';

      const submitted =
        await this.submitMarketOrder(
          req.marketId,
          clientOrderIndex,
          baseAmount,
          req.expectedPrice,
          isAsk,
          true,
          priceDecimals
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
        executableQuantity,
        priceDecimals,
        sizeDecimals
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

  async cancelProtectiveOrders(
    orders: ProtectiveOrders
  ): Promise<void> {
    const orderIds = [
      orders.stopLossOrderId,
      orders.takeProfitOrderId
    ];

    for (const orderId of orderIds) {
      if (!orderId) {
        continue;
      }

      const parsedOrderIndex =
        Number(orderId);

      if (
        !Number.isSafeInteger(
          parsedOrderIndex
        ) ||
        parsedOrderIndex < 0
      ) {
        throw new Error(
          `Invalid exchange order index: ${orderId}`
        );
      }

      const [
        ,
        ,
        sdkError
      ] =
        await this.signerClient.cancel_order(
          orders.marketId,
          BigInt(parsedOrderIndex),
          -1,
          this.apiKeyIndex
        );

      if (sdkError) {
        throw new Error(
          `Failed to cancel protective order ` +
            `${orderId}: ${sdkError}`
        );
      }

      console.log(
        `[${new Date().toISOString()}] ` +
          `[LIGHTER] Protective order canceled ` +
          `marketId=${orders.marketId} ` +
          `orderIndex=${parsedOrderIndex}`
      );
    }
  }

  private validateProtectiveLevels(
    req: OpenExecutionRequest
  ): void {
    if (
      !Number.isFinite(req.stopLossPrice) ||
      !Number.isFinite(req.takeProfitPrice) ||
      req.stopLossPrice <= 0 ||
      req.takeProfitPrice <= 0
    ) {
      throw new Error(
        'Invalid protective order prices'
      );
    }

    if (req.side === 'long') {
      if (
        req.stopLossPrice >= req.expectedPrice ||
        req.takeProfitPrice <= req.expectedPrice
      ) {
        throw new Error(
          'Invalid LONG SL/TP levels'
        );
      }

      return;
    }

    if (
      req.stopLossPrice <= req.expectedPrice ||
      req.takeProfitPrice >= req.expectedPrice
    ) {
      throw new Error(
        'Invalid SHORT SL/TP levels'
      );
    }
  }

  private async createProtectiveOrders(
    req: OpenExecutionRequest,
    baseAmount: number
  ): Promise<ProtectiveOrders> {
    const priceDecimals =
      req.priceDecimals ?? 2;

    const slClientOrderIndex =
      this.createClientOrderIndex();

    const tpClientOrderIndex =
      this.createClientOrderIndex();

    const isAsk =
      req.side === 'long';

    const slTriggerPrice =
      this.toPriceUnits(
        req.stopLossPrice,
        priceDecimals
      );

    const tpTriggerPrice =
      this.toPriceUnits(
        req.takeProfitPrice,
        priceDecimals
      );

    const slExecutionPrice =
      this.toPriceUnits(
        this.getProtectiveExecutionPrice(
          req,
          req.stopLossPrice
        ),
        priceDecimals
      );

    const tpExecutionPrice =
      this.toPriceUnits(
        this.getProtectiveExecutionPrice(
          req,
          req.takeProfitPrice
        ),
        priceDecimals
      );

    const [
      slOrder,
      slTx,
      slError
    ] =
      await this.signerClient.create_sl_order(
        req.marketId,
        slClientOrderIndex,
        baseAmount,
        slTriggerPrice,
        slExecutionPrice,
        isAsk,
        true,
        -1,
        this.apiKeyIndex
      );

    if (slError) {
      throw new Error(
        `SL creation failed: ${slError}`
      );
    }

    try {
      const [
        tpOrder,
        tpTx,
        tpError
      ] =
        await this.signerClient.create_tp_order(
          req.marketId,
          tpClientOrderIndex,
          baseAmount,
          tpTriggerPrice,
          tpExecutionPrice,
          isAsk,
          true,
          -1,
          this.apiKeyIndex
        );

      if (tpError) {
        throw new Error(
          `TP creation failed: ${tpError}`
        );
      }

      return {
        marketId: req.marketId,
        stopLossOrderId:
          this.readExchangeOrderId(
            slOrder as Record<
              string,
              unknown
            > | null
          ) ??
          this.readTransactionId(slTx),
        takeProfitOrderId:
          this.readExchangeOrderId(
            tpOrder as Record<
              string,
              unknown
            > | null
          ) ??
          this.readTransactionId(tpTx),
        stopLossClientOrderIndex:
          slClientOrderIndex,
        takeProfitClientOrderIndex:
          tpClientOrderIndex
      };
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ` +
          `[LIGHTER] TP creation failed; ` +
          `SL remains active`,
        error
      );

      throw error;
    }
  }

  private getProtectiveExecutionPrice(
    req: OpenExecutionRequest,
    triggerPrice: number
  ): number {
    const slippagePercent =
      Number(
        process.env.LIGHTER_PROTECTIVE_SLIPPAGE_PCT ??
          0.5
      ) / 100;

    if (
      !Number.isFinite(slippagePercent) ||
      slippagePercent < 0
    ) {
      throw new Error(
        'Invalid LIGHTER_PROTECTIVE_SLIPPAGE_PCT'
      );
    }

    if (req.side === 'long') {
      return triggerPrice *
        (1 - slippagePercent);
    }

    return triggerPrice *
      (1 + slippagePercent);
  }

  private async submitMarketOrder(
    marketId: number,
    clientOrderIndex: number,
    baseAmount: number,
    expectedPrice: number,
    isAsk: boolean,
    reduceOnly: boolean,
    priceDecimals: number
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
        this.toPriceUnits(
          expectedPrice,
          priceDecimals
        ),
        isAsk,
        reduceOnly,
        -1,
        this.apiKeyIndex
      );

    if (sdkError) {
      return {
        ok: false,
        message: sdkError
      };
    }

    const orderId =
      this.readExchangeOrderId(
        order as Record<
          string,
          unknown
        > | null
      ) ??
      this.readTransactionId(tx);

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

  private waitForOrderExecution(
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
    return new Promise<ExecutionResult>(
      resolve => {
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
                clientOrderId:
                  req.clientOrderId,
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
                (sum, fill) =>
                  sum + fill.quantity,
                0
              );

            if (totalFilled > 0) {
              const totalQuote =
                pending.fills.reduce(
                  (sum, fill) =>
                    sum +
                    fill.quantity *
                      fill.price,
                  0
                );

              resolve({
                ok: true,
                status:
                  totalFilled >=
                  requestedQuantity
                    ? 'filled'
                    : 'partially_filled',
                orderId:
                  pending.orderId ??
                  orderId ??
                  '',
                clientOrderId:
                  req.clientOrderId,
                requestedQuantity,
                filledQuantity: totalFilled,
                averageFillPrice:
                  totalQuote / totalFilled,
                fee:
                  pending.fills.reduce(
                    (sum, fill) =>
                      sum + fill.fee,
                    0
                  ),
                message:
                  'Execution confirmed after timeout'
              });

              return;
            }

            resolve({
              ok: false,
              status: 'unknown',
              orderId: orderId ?? '',
              clientOrderId:
                req.clientOrderId,
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
            clientOrderId:
              req.clientOrderId,
            requestedQuantity,
            priceDecimals,
            sizeDecimals,
            resolve,
            timer,
            fills: [],
            seenTradeIds: new Set<string>(),
            orderId
          }
        );

        this.ensureAccountWebSocket();
      }
    );
  }

  private startAccountWebSocket(): void {
    this.accountWsStopped = false;
    this.ensureAccountWebSocket();
  }

  private ensureAccountWebSocket(): void {
    if (
      this.accountWsConnecting ||
      this.accountWs?.readyState ===
        WebSocket.OPEN
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
      if (this.accountWs !== ws) {
        return;
      }

      this.accountWsConnecting = false;

      if (this.accountWsPingTimer) {
        clearInterval(
          this.accountWsPingTimer
        );

        this.accountWsPingTimer =
          undefined;
      }

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
            channel:
              `account_all/${this.accountIndex}`,
            auth: this.authToken
          })
        );

        console.log(
          `[${new Date().toISOString()}] ` +
            `[LIGHTER] Account channel subscribed: ` +
            `account_all/${this.accountIndex}`
        );
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] ` +
            `[LIGHTER] Account WebSocket auth error`,
          error
        );

        ws.close();
        return;
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
      if (this.accountWs !== ws) {
        return;
      }

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
      if (this.accountWs !== ws) {
        return;
      }

      console.error(
        `[${new Date().toISOString()}] ` +
          `[LIGHTER] Account WebSocket error`,
        error
      );
    });

    ws.on('close', (code, reason) => {
      if (this.accountWs !== ws) {
        return;
      }

      this.accountWsConnecting = false;
      this.accountWs = undefined;

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
        if (this.accountWsReconnectTimer) {
          clearTimeout(
            this.accountWsReconnectTimer
          );
        }

        this.accountWsReconnectTimer =
          setTimeout(() => {
            this.accountWsReconnectTimer =
              undefined;

            this.ensureAccountWebSocket();
          }, 3_000);
      }
    });
  }

  private handleAccountMessage(
    message: AccountMessage
  ): void {
    for (const order of
      this.flattenOrders(message.orders)) {
      this.handleOrderUpdate(order);
    }

    for (const trade of
      this.flattenTrades(message.trades)) {
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

    const filledQuantity =
      this.readQuantity(
        order.filled_base_amount
      );

    const filledQuote =
      this.readQuantity(
        order.filled_quote_amount
      );

    const status =
      (order.status ?? '')
        .toLowerCase();

    pending.lastStatus = status;

    const isTerminal =
      status === 'filled' ||
      status.startsWith('canceled') ||
      status.startsWith('cancelled') ||
      status === 'rejected' ||
      status === 'failed';

    if (!isTerminal) {
      return;
    }

    if (filledQuantity <= 0) {
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
          clientOrderId:
            pending.clientOrderId ?? '',
          requestedQuantity:
            pending.requestedQuantity,
          filledQuantity: 0,
          message:
            `Order status: ${status}`
        }
      );

      return;
    }

    const averageFillPrice =
      filledQuote > 0
        ? filledQuote / filledQuantity
        : this.averagePendingFillPrice(
            pending
          );

    if (
      !Number.isFinite(averageFillPrice) ||
      averageFillPrice <= 0
    ) {
      return;
    }

    this.resolvePendingOrder(
      clientOrderIndex,
      {
        ok: true,
        status:
          status === 'filled'
            ? 'filled'
            : 'partially_filled',
        orderId:
          this.readExchangeOrderId(
            order as Record<
              string,
              unknown
            >
          ) ?? pending.orderId ?? '',
        clientOrderId:
          pending.clientOrderId ?? '',
        requestedQuantity:
          pending.requestedQuantity,
        filledQuantity,
        averageFillPrice,
        fee:
          this.sumPendingFees(pending),
        message:
          `Order status: ${status}`
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

    if (
      trade.market_id != null &&
      pending.marketId !== trade.market_id
    ) {
      console.warn(
        `[${new Date().toISOString()}] ` +
          `Trade market_id mismatch: ` +
          `pending=${pending.marketId}, ` +
          `trade=${trade.market_id}, ` +
          `clientOrderIndex=${clientOrderIndex}`
      );

      return;
    }

    const tradeId =
      this.readTradeId(trade);

    if (
      tradeId &&
      pending.seenTradeIds.has(tradeId)
    ) {
      return;
    }

    if (tradeId) {
      pending.seenTradeIds.add(tradeId);
    }

    const filledQuantity =
      this.toNumber(trade.size);

    const price =
      this.toNumber(trade.price);

    if (
      filledQuantity == null ||
      filledQuantity <= 0 ||
      price == null ||
      price <= 0
    ) {
      return;
    }

    const fee =
      this.toNumber(trade.taker_fee) ??
      this.toNumber(trade.maker_fee) ??
      0;

    pending.fills.push({
      quantity: filledQuantity,
      price,
      fee
    });
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

  private flattenOrders(
    orders:
      | LighterOrder[]
      | Record<string, LighterOrder[]>
      | undefined
  ): LighterOrder[] {
    if (!orders) {
      return [];
    }

    if (Array.isArray(orders)) {
      return orders;
    }

    return Object.values(orders)
      .flat()
      .filter(
        (
          order
        ): order is LighterOrder =>
          order != null
      );
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
        (
          trade
        ): trade is LighterTrade =>
          trade != null
      );
  }

  private averagePendingFillPrice(
    pending: PendingOrder
  ): number {
    const totalQuantity =
      pending.fills.reduce(
        (sum, fill) =>
          sum + fill.quantity,
        0
      );

    if (totalQuantity <= 0) {
      return 0;
    }

    const totalQuote =
      pending.fills.reduce(
        (sum, fill) =>
          sum +
          fill.quantity * fill.price,
        0
      );

    return totalQuote / totalQuantity;
  }

  private sumPendingFees(
    pending: PendingOrder
  ): number {
    return pending.fills.reduce(
      (sum, fill) =>
        sum + fill.fee,
      0
    );
  }

  private readQuantity(
    value: string | number | undefined
  ): number {
    const parsed =
      this.toNumber(value);

    return parsed != null && parsed > 0
      ? parsed
      : 0;
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
      const value = order[key];

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

  private readTransactionId(
    tx: unknown
  ): string | undefined {
    const record =
      tx as Record<string, unknown> | null;

    if (!record) {
      return undefined;
    }

    for (const key of [
      'tx_hash',
      'txHash'
    ]) {
      const value = record[key];

      if (
        typeof value === 'string' &&
        value.length > 0
      ) {
        return value;
      }
    }

    return undefined;
  }

  private readTradeId(
    trade: LighterTrade
  ): string | undefined {
    return (
      this.toString(trade.trade_id) ??
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
        Math.pow(10, sizeDecimals)
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
        Math.pow(10, priceDecimals)
    );
  }

private orderSequence = 0;

private createClientOrderIndex(): number {
  const timestamp = Math.floor(Date.now() / 1000);
  
  this.orderSequence = (this.orderSequence + 1) % 1000;
  
  const value = timestamp + this.orderSequence;
  
  const maxUint48 = Number((2n ** 48n) - 1n);
  
  if (value > maxUint48) {
    throw new Error('client_order_index exceeds uint48');
  }
  
  return value;  // ✅ Всегда > 0
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
      clientOrderId: req.clientOrderId,
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
      clientOrderId: req.clientOrderId,
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
        clientOrderId:
          pending.clientOrderId ?? '',
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
