import WebSocket from 'ws';
import {
  ExecutionService,
  OpenExecutionRequest,
  CloseExecutionRequest,
  ExecutionResult,
  ProtectiveOrders
} from './types';
import { SignerClient } from 'zklighter-sdk';

const LIGHTER_API_URL = process.env.LIGHTER_API_URL ?? 'https://mainnet.zklighter.elliot.ai';
const LIGHTER_WS_URL = process.env.LIGHTER_WS_URL ?? 'wss://mainnet.zklighter.elliot.ai/stream';
const ORDER_WAIT_TIMEOUT_MS = 15_000;
const REST_RECONCILIATION_TIMEOUT_MS = 45_000;
const REST_POLL_INTERVAL_MS = 1_500;

type LighterOrder = {
  order_index?: number | string;
  order_id?: string;
  client_order_index?: number | string;
  client_order_id?: string;
  market_index?: number | string;
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
  market_id?: number | string;
  size?: string | number;
  price?: string | number;
  usd_amount?: string | number;
  ask_id?: number | string;
  bid_id?: number | string;
  ask_client_id?: number | string;
  bid_client_id?: number | string;
  taker_fee?: number | string;
  maker_fee?: number | string;
};

type AccountMessage = {
  type?: string;
  channel?: string;
  account?: number;
  orders?: LighterOrder[] | Record<string, LighterOrder[]>;
  trades?: LighterTrade[] | Record<string, LighterTrade[]>;
};

type PendingOrder = {
  marketId: number;
  clientOrderIndex: number;
  clientOrderId?: string;
  requestedQuantity: number;
  resolve: (result: ExecutionResult) => void;
  timer: NodeJS.Timeout;
  fills: Array<{ quantity: number; price: number; fee: number }>;
  seenTradeIds: Set<string>;
  orderId?: string;
};

type RestOrderResult = {
  status: 'FILLED' | 'CANCELED' | 'UNKNOWN';
  filledQuantity: number;
  averageFillPrice?: number;
  fee: number;
};

export class LighterExecutionService implements ExecutionService {
  private readonly signerClient: SignerClient;
  private accountWs?: WebSocket;
  private accountWsReconnectTimer?: NodeJS.Timeout;
  private accountWsPingTimer?: NodeJS.Timeout;
  private accountWsStopped = false;
  private accountWsConnecting = false;
  private authToken?: string;
  private readonly pendingOrders = new Map<number, PendingOrder>();
  private readonly openingMarkets = new Set<number>();
  private orderSequence = 0;

  constructor(
    apiKeySecret: string,
    private readonly apiKeyIndex: number,
    private readonly accountIndex: number
  ) {
    if (!apiKeySecret) throw new Error('LighterExecutionService: LIGHTER_API_SECRET is required');
    if (!Number.isInteger(apiKeyIndex) || apiKeyIndex < 0) throw new Error('LighterExecutionService: invalid apiKeyIndex');
    if (!Number.isInteger(accountIndex) || accountIndex < 0) throw new Error('LighterExecutionService: invalid accountIndex');

    const normalizedKey = apiKeySecret.startsWith('0x') ? apiKeySecret.slice(2) : apiKeySecret;
    this.signerClient = new SignerClient(LIGHTER_API_URL, normalizedKey, apiKeyIndex, accountIndex);
    this.startAccountWebSocket();
  }

  async openPosition(req: OpenExecutionRequest): Promise<ExecutionResult> {
    if (this.openingMarkets.has(req.marketId)) {
      return this.rejectedResult(req, `Opening order already in progress for market ${req.marketId}`);
    }

    const hasPending = await this.checkPendingRemoteOrders(req.marketId);
    if (hasPending) {
      console.log(`[${new Date().toISOString()}] [LIGHTER] openPosition REJECTED marketId=${req.marketId} reason=pending_remote_order`);
      return this.rejectedResult(req, `Pending remote order exists for market ${req.marketId}`);
    }

    this.openingMarkets.add(req.marketId);

    try {
      this.validateProtectiveLevels(req);
      const priceDecimals = req.priceDecimals ?? 2;
      const sizeDecimals = req.sizeDecimals ?? 8;
      const baseAmount = this.toBaseAmount(req.quantity, sizeDecimals);
      if (baseAmount <= 0) return this.rejectedResult(req, `Quantity is too small after conversion: ${req.quantity}`);

      const clientOrderIndex = this.createClientOrderIndex();
      const submitted = await this.submitMarketOrder(
        req.marketId,
        clientOrderIndex,
        baseAmount,
        req.expectedPrice,
        req.side === 'short',
        false,
        priceDecimals
      );

      if (!submitted.ok) return this.rejectedResult(req, submitted.message);

      const execution = await this.waitForOrderExecution(
        req,
        req.marketId,
        clientOrderIndex,
        submitted.orderId,
        baseAmount / 10 ** sizeDecimals,
        priceDecimals,
        sizeDecimals
      );

      if (!execution.ok) return execution;

      const actualBaseAmount = this.toBaseAmount(execution.filledQuantity, sizeDecimals);
      if (actualBaseAmount <= 0) return this.unknownResult(req, 'Execution returned invalid filled quantity');

      try {
        const protectiveOrders = await this.createProtectiveOrders(req, actualBaseAmount);
        return { ...execution, protectiveOrders };
      } catch (error) {
        return {
          ...execution,
          ok: false,
          status: 'unknown',
          message: `Entry filled but protective orders were not created: ${error instanceof Error ? error.message : 'unknown error'}`
        };
      }
    } catch (error) {
      return this.unknownResult(req, error instanceof Error ? error.message : 'Unknown error');
    } finally {
      this.openingMarkets.delete(req.marketId);
    }
  }

  async closePosition(req: CloseExecutionRequest): Promise<ExecutionResult> {
    try {
      const priceDecimals = req.priceDecimals ?? 2;
      const sizeDecimals = req.sizeDecimals ?? 8;
      const baseAmount = this.toBaseAmount(req.quantity, sizeDecimals);
      if (baseAmount <= 0) return this.rejectedResult(req, `Quantity is too small after conversion: ${req.quantity}`);

      const clientOrderIndex = this.createClientOrderIndex();
      const submitted = await this.submitMarketOrder(
        req.marketId,
        clientOrderIndex,
        baseAmount,
        req.expectedPrice,
        req.positionSide === 'long',
        true,
        priceDecimals
      );
      if (!submitted.ok) return this.rejectedResult(req, submitted.message);

      return await this.waitForOrderExecution(
        req,
        req.marketId,
        clientOrderIndex,
        submitted.orderId,
        baseAmount / 10 ** sizeDecimals,
        priceDecimals,
        sizeDecimals
      );
    } catch (error) {
      return this.unknownResult(req, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  async cancelProtectiveOrders(orders: ProtectiveOrders): Promise<void> {
    for (const orderId of [orders.stopLossOrderId, orders.takeProfitOrderId]) {
      if (!orderId) continue;
      const orderIndex = Number(orderId);
      if (!Number.isSafeInteger(orderIndex) || orderIndex < 0) throw new Error(`Invalid exchange order index: ${orderId}`);

      console.log(`[${new Date().toISOString()}] [LIGHTER REST] cancel_order START marketId=${orders.marketId} orderIndex=${orderIndex}`);
      const [, , sdkError] = await this.signerClient.cancel_order(orders.marketId, BigInt(orderIndex), -1, this.apiKeyIndex);
      if (sdkError) {
        console.error(`[${new Date().toISOString()}] [LIGHTER REST] cancel_order ERROR marketId=${orders.marketId} orderIndex=${orderIndex} error=${sdkError}`);
        throw new Error(`Failed to cancel protective order ${orderId}: ${sdkError}`);
      }
      console.log(`[${new Date().toISOString()}] [LIGHTER REST] cancel_order OK marketId=${orders.marketId} orderIndex=${orderIndex}`);
    }
  }

  private async checkPendingRemoteOrders(marketId: number): Promise<boolean> {
    try {
      console.log(`[${new Date().toISOString()}] [LIGHTER] checkPendingRemoteOrders START marketId=${marketId}`);

      const [activeData, inactiveData] = await Promise.all([
        fetch(`${LIGHTER_API_URL}/api/v1/accountActiveOrders?account_index=${this.accountIndex}&limit=100`, {
          headers: { Accept: 'application/json', Authorization: this.authToken ?? '' }
        }).then(r => r.json()),
        fetch(`${LIGHTER_API_URL}/api/v1/accountInactiveOrders?account_index=${this.accountIndex}&limit=100`, {
          headers: { Accept: 'application/json', Authorization: this.authToken ?? '' }
        }).then(r => r.json())
      ]);

      const activeOrders = Array.isArray((activeData as any).orders) ? (activeData as any).orders : [];
      const inactiveOrders = Array.isArray((inactiveData as any).orders) ? (inactiveData as any).orders : [];

      const pendingOrder = [...activeOrders, ...inactiveOrders].find(
        (order: any) => Number(order.market_index) === marketId &&
          (order.status === 'submitted' || order.status === 'partially_filled' || order.status === 'open')
      );

      if (pendingOrder) {
        console.log(`[${new Date().toISOString()}] [LIGHTER] checkPendingRemoteOrders FOUND marketId=${marketId} orderId=${pendingOrder.order_id} status=${pendingOrder.status}`);
        return true;
      }

      console.log(`[${new Date().toISOString()}] [LIGHTER] checkPendingRemoteOrders NONE marketId=${marketId}`);
      return false;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] [LIGHTER] checkPendingRemoteOrders ERROR marketId=${marketId}:`, error);
      return false;
    }
  }

  private validateProtectiveLevels(req: OpenExecutionRequest): void {
    if (!Number.isFinite(req.stopLossPrice) || !Number.isFinite(req.takeProfitPrice) || req.stopLossPrice <= 0 || req.takeProfitPrice <= 0) throw new Error('Invalid protective order prices');
    if (req.side === 'long') {
      if (req.stopLossPrice >= req.expectedPrice || req.takeProfitPrice <= req.expectedPrice) throw new Error('Invalid LONG SL/TP levels');
    } else if (req.stopLossPrice <= req.expectedPrice || req.takeProfitPrice >= req.expectedPrice) {
      throw new Error('Invalid SHORT SL/TP levels');
    }
  }

  private async createProtectiveOrders(req: OpenExecutionRequest, baseAmount: number): Promise<ProtectiveOrders> {
    const priceDecimals = req.priceDecimals ?? 2;
    const slClientOrderIndex = this.createClientOrderIndex();
    const tpClientOrderIndex = this.createClientOrderIndex();
    const isAsk = req.side === 'long';
    const slippage = Number(process.env.LIGHTER_PROTECTIVE_SLIPPAGE_PCT ?? 0.5) / 100;
    if (!Number.isFinite(slippage) || slippage < 0) throw new Error('Invalid LIGHTER_PROTECTIVE_SLIPPAGE_PCT');

    const slTrigger = this.toPriceUnits(req.stopLossPrice, priceDecimals);
    const tpTrigger = this.toPriceUnits(req.takeProfitPrice, priceDecimals);
    const slExecution = this.toPriceUnits(req.side === 'long' ? req.stopLossPrice * (1 - slippage) : req.stopLossPrice * (1 + slippage), priceDecimals);
    const tpExecution = this.toPriceUnits(req.side === 'long' ? req.takeProfitPrice * (1 - slippage) : req.takeProfitPrice * (1 + slippage), priceDecimals);

    console.log(`[${new Date().toISOString()}] [LIGHTER REST] create_sl_order START marketId=${req.marketId} clientOrderIndex=${slClientOrderIndex} baseAmount=${baseAmount} trigger=${slTrigger} execution=${slExecution}`);
    const [slOrder, slTx, slError] = await this.signerClient.create_sl_order(req.marketId, slClientOrderIndex, baseAmount, slTrigger, slExecution, isAsk, true, -1, this.apiKeyIndex);
    if (slError) {
      console.error(`[${new Date().toISOString()}] [LIGHTER REST] create_sl_order ERROR marketId=${req.marketId} clientOrderIndex=${slClientOrderIndex} error=${slError}`);
      throw new Error(`SL creation failed: ${slError}`);
    }
    const slOrderId = this.readExchangeOrderId(slOrder as Record<string, unknown> | null) ?? this.readTransactionId(slTx);
    console.log(`[${new Date().toISOString()}] [LIGHTER REST] create_sl_order OK marketId=${req.marketId} clientOrderIndex=${slClientOrderIndex} orderId=${slOrderId ?? 'n/a'}`);

    try {
      console.log(`[${new Date().toISOString()}] [LIGHTER REST] create_tp_order START marketId=${req.marketId} clientOrderIndex=${tpClientOrderIndex} baseAmount=${baseAmount} trigger=${tpTrigger} execution=${tpExecution}`);
      const [tpOrder, tpTx, tpError] = await this.signerClient.create_tp_order(req.marketId, tpClientOrderIndex, baseAmount, tpTrigger, tpExecution, isAsk, true, -1, this.apiKeyIndex);
      if (tpError) {
        console.error(`[${new Date().toISOString()}] [LIGHTER REST] create_tp_order ERROR marketId=${req.marketId} clientOrderIndex=${tpClientOrderIndex} error=${tpError}`);
        throw new Error(`TP creation failed: ${tpError}`);
      }
      const tpOrderId = this.readExchangeOrderId(tpOrder as Record<string, unknown> | null) ?? this.readTransactionId(tpTx);
      console.log(`[${new Date().toISOString()}] [LIGHTER REST] create_tp_order OK marketId=${req.marketId} clientOrderIndex=${tpClientOrderIndex} orderId=${tpOrderId ?? 'n/a'}`);

      return {
        marketId: req.marketId,
        stopLossOrderId: slOrderId,
        takeProfitOrderId: tpOrderId,
        stopLossClientOrderIndex: slClientOrderIndex,
        takeProfitClientOrderIndex: tpClientOrderIndex
      };
    } catch (error) {
      try {
        const slId = this.readExchangeOrderId(slOrder as Record<string, unknown> | null);
        if (slId) {
          console.log(`[${new Date().toISOString()}] [LIGHTER REST] cancel_sl_after_tp_failure START marketId=${req.marketId} slOrderId=${slId}`);
          await this.cancelProtectiveOrders({ marketId: req.marketId, stopLossOrderId: slId, takeProfitOrderId: undefined, stopLossClientOrderIndex: slClientOrderIndex, takeProfitClientOrderIndex: tpClientOrderIndex });
          console.log(`[${new Date().toISOString()}] [LIGHTER REST] cancel_sl_after_tp_failure OK marketId=${req.marketId} slOrderId=${slId}`);
        }
      } catch { /* best effort */ }
      throw error;
    }
  }

  private async submitMarketOrder(
    marketId: number,
    clientOrderIndex: number,
    baseAmount: number,
    expectedPrice: number,
    isAsk: boolean,
    reduceOnly: boolean,
    priceDecimals: number
  ): Promise<{ ok: true; orderId?: string } | { ok: false; message: string }> {
    const maxSlippageBps = Number(
      process.env.LIGHTER_MARKET_SLIPPAGE_BPS ?? 50
    );
  
    if (!Number.isFinite(maxSlippageBps) || maxSlippageBps <= 0) {
      throw new Error(
        `Invalid LIGHTER_MARKET_SLIPPAGE_BPS: ${maxSlippageBps}`
      );
    }
  
    if (!Number.isFinite(expectedPrice) || expectedPrice <= 0) {
      throw new Error(`Invalid expectedPrice: ${expectedPrice}`);
    }
  
    if (!Number.isInteger(priceDecimals) || priceDecimals < 0 || priceDecimals > 18) {
      throw new Error(`Invalid priceDecimals: ${priceDecimals}`);
    }
  
    // SDK expects max_slippage as a decimal fraction:
    // 0.005 = 50 bps = 0.5%.
    const maxSlippage = maxSlippageBps / 10_000;
  
    if (maxSlippage >= 1) {
      throw new Error(
        `LIGHTER_MARKET_SLIPPAGE_BPS is too large: ${maxSlippageBps}`
      );
    }
  
    // SDK uses protocol price units, not display price.
    // Examples:
    // TSLA 359.02 with 2 decimals -> 35902
    // XMR 511.46 with 3 decimals -> 511460
    // LIT 4.5656 with 4 decimals -> 45656
    const idealPrice = Math.round(
      expectedPrice * 10 ** priceDecimals
    );
  
    if (!Number.isSafeInteger(idealPrice) || idealPrice <= 0) {
      throw new Error(
        `Invalid idealPrice: ${idealPrice} from expectedPrice=${expectedPrice}, priceDecimals=${priceDecimals}`
      );
    }
  
    console.log(
      `[${new Date().toISOString()}] [LIGHTER REST] ` +
      `create_market_order_if_slippage START ` +
      `marketId=${marketId} ` +
      `clientOrderIndex=${clientOrderIndex} ` +
      `baseAmount=${baseAmount} ` +
      `maxSlippageBps=${maxSlippageBps} ` +
      `maxSlippage=${maxSlippage} ` +
      `expectedPrice=${expectedPrice} ` +
      `idealPrice=${idealPrice} ` +
      `priceDecimals=${priceDecimals} ` +
      `isAsk=${isAsk} ` +
      `reduceOnly=${reduceOnly}`
    );
  
    const [order, tx, sdkError] =
      await this.signerClient.create_market_order_if_slippage(
        marketId,
        clientOrderIndex,
        baseAmount,
        maxSlippage,
        isAsk,
        reduceOnly,
        -1,
        this.apiKeyIndex,
        idealPrice
      );
  
    if (sdkError) {
      console.error(
        `[${new Date().toISOString()}] [LIGHTER REST] ` +
        `create_market_order_if_slippage ERROR ` +
        `marketId=${marketId} ` +
        `clientOrderIndex=${clientOrderIndex} ` +
        `error=${sdkError}`
      );
  
      return {
        ok: false,
        message: sdkError
      };
    }
  
    const orderId =
      this.readExchangeOrderId(
        order as Record<string, unknown> | null
      ) ?? this.readTransactionId(tx);
  
    console.log(
      `[${new Date().toISOString()}] [LIGHTER REST] ` +
      `create_market_order_if_slippage OK ` +
      `marketId=${marketId} ` +
      `clientOrderIndex=${clientOrderIndex} ` +
      `orderId=${orderId ?? 'n/a'}`
    );
  
    console.log(
      `[${new Date().toISOString()}] [LIGHTER REST] ` +
      `create_market_order_if_slippage RESPONSE order=`,
      JSON.stringify(order, null, 2)
    );
  
    console.log(
      `[${new Date().toISOString()}] [LIGHTER REST] ` +
      `create_market_order_if_slippage RESPONSE tx=`,
      JSON.stringify(tx, null, 2)
    );
  
    return {
      ok: true,
      orderId
    };
  }
  
  private waitForOrderExecution(req: OpenExecutionRequest | CloseExecutionRequest, marketId: number, clientOrderIndex: number, orderId: string | undefined, requestedQuantity: number, _priceDecimals: number, _sizeDecimals: number): Promise<ExecutionResult> {
    return new Promise(resolve => {
      const timer = setTimeout(async () => {
        const pending = this.pendingOrders.get(clientOrderIndex);
        if (!pending) {
          resolve(this.unknownResult(req, 'Pending order state disappeared before execution confirmation'));
          return;
        }

        const totalFilled = pending.fills.reduce((sum, fill) => sum + fill.quantity, 0);
        if (totalFilled > 0) {
          this.resolvePendingOrder(clientOrderIndex, this.fillResult(req, pending, totalFilled, pending.orderId ?? orderId));
          return;
        }

        const reconciled = await this.reconcileOrderViaRest(marketId, clientOrderIndex, orderId);
        if (reconciled.status === 'FILLED' && reconciled.filledQuantity > 0) {
          this.resolvePendingOrder(clientOrderIndex, {
            ok: true,
            status: reconciled.filledQuantity >= requestedQuantity ? 'filled' : 'partially_filled',
            orderId: pending.orderId ?? orderId ?? '',
            clientOrderId: req.clientOrderId,
            requestedQuantity,
            filledQuantity: reconciled.filledQuantity,
            averageFillPrice: reconciled.averageFillPrice,
            fee: reconciled.fee,
            message: 'Execution confirmed via REST reconciliation'
          });
          return;
        }
        if (reconciled.status === 'CANCELED') {
          this.resolvePendingOrder(clientOrderIndex, {
            ok: false,
            status: 'rejected',
            orderId: pending.orderId ?? orderId ?? '',
            clientOrderId: req.clientOrderId,
            requestedQuantity,
            filledQuantity: 0,
            message: 'Order canceled (confirmed via REST)'
          });
          return;
        }

        this.resolvePendingOrder(clientOrderIndex, this.unknownResult(req, 'Order accepted but execution remains unconfirmed after REST reconciliation'));
      }, ORDER_WAIT_TIMEOUT_MS);

      this.pendingOrders.set(clientOrderIndex, {
        marketId,
        clientOrderIndex,
        clientOrderId: req.clientOrderId,
        requestedQuantity,
        resolve,
        timer,
        fills: [],
        seenTradeIds: new Set(),
        orderId
      });
      this.ensureAccountWebSocket();
    });
  }

  private async reconcileOrderViaRest(marketId: number, clientOrderIndex: number, orderId?: string): Promise<RestOrderResult> {
    const start = Date.now();
    while (Date.now() - start < REST_RECONCILIATION_TIMEOUT_MS) {
      try {
        const active = await this.fetchOrders('accountActiveOrders');
        const inactive = await this.fetchOrders('accountInactiveOrders');
        const order = [...active, ...inactive].find(item =>
          (orderId && String(item.order_index) === orderId) || Number(item.client_order_index) === clientOrderIndex
        );

        if (order) {
          const status = String(order.status ?? '').toLowerCase();
          const filledQuantity = this.toNumber(order.filled_base_amount) ?? 0;
          const filledQuote = this.toNumber(order.filled_quote_amount) ?? 0;

          if (filledQuantity > 0) {
            console.log(`[${new Date().toISOString()}] [LIGHTER REST] reconcileOrderViaRest FILLED (by volume) marketId=${marketId} clientOrderIndex=${clientOrderIndex} filledQuantity=${filledQuantity} filledQuote=${filledQuote} status=${status}`);
            return { status: 'FILLED', filledQuantity, averageFillPrice: filledQuote / filledQuantity, fee: 0 };
          }

          if (status === 'filled' || status.startsWith('filled')) {
            console.log(`[${new Date().toISOString()}] [LIGHTER REST] reconcileOrderViaRest FILLED marketId=${marketId} clientOrderIndex=${clientOrderIndex} filledQuantity=${filledQuantity} filledQuote=${filledQuote}`);
            return { status: 'FILLED', filledQuantity, averageFillPrice: filledQuantity > 0 ? filledQuote / filledQuantity : undefined, fee: 0 };
          }
          if (status.startsWith('cancel') || status === 'rejected' || status === 'failed') {
            console.log(`[${new Date().toISOString()}] [LIGHTER REST] reconcileOrderViaRest CANCELED marketId=${marketId} clientOrderIndex=${clientOrderIndex} status=${order.status}`);
            return { status: 'CANCELED', filledQuantity: 0, fee: 0 };
          }
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] [LIGHTER REST] reconcileOrderViaRest ERROR marketId=${marketId} clientOrderIndex=${clientOrderIndex}:`, error);
      }
      await this.sleep(REST_POLL_INTERVAL_MS);
    }
    console.log(`[${new Date().toISOString()}] [LIGHTER REST] reconcileOrderViaRest TIMEOUT marketId=${marketId} clientOrderIndex=${clientOrderIndex}`);
    return { status: 'UNKNOWN', filledQuantity: 0, fee: 0 };
  }

  private async fetchOrders(endpoint: 'accountActiveOrders' | 'accountInactiveOrders'): Promise<LighterOrder[]> {
    const url = new URL(`${LIGHTER_API_URL}/api/v1/${endpoint}`);
    url.searchParams.set('account_index', String(this.accountIndex));
    url.searchParams.set('limit', '100');

    console.log(`[${new Date().toISOString()}] [LIGHTER REST] fetchOrders START endpoint=${endpoint} url=${url.toString()}`);
    const response = await fetch(url, { headers: { Accept: 'application/json', Authorization: this.authToken ?? '' } });
    const responseText = await response.text();

    console.log(`[${new Date().toISOString()}] [LIGHTER REST] fetchOrders RESPONSE status=${response.status} endpoint=${endpoint}`);
    console.log(`[${new Date().toISOString()}] [LIGHTER REST] fetchOrders RESPONSE body=${responseText.slice(0, 2000)}`);

    let data: unknown;
    try {
      data = JSON.parse(responseText);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] [LIGHTER REST] fetchOrders JSON_PARSE_ERROR endpoint=${endpoint} error=${error instanceof Error ? error.message : 'unknown'}`);
      return [];
    }

    const orders = (data as Record<string, unknown>).orders;
    const result = Array.isArray(orders) ? orders.filter((order): order is LighterOrder => !!order && typeof order === 'object') : [];
    console.log(`[${new Date().toISOString()}] [LIGHTER REST] fetchOrders END endpoint=${endpoint} ordersCount=${result.length}`);
    return result;
  }

  private handleAccountMessage(message: AccountMessage): void {
    for (const order of this.flattenOrders(message.orders)) this.handleOrderUpdate(order);
    for (const trade of this.flattenTrades(message.trades)) this.handleTradeUpdate(trade);
  }

  private handleOrderUpdate(order: LighterOrder): void {
    const clientOrderIndex = this.toNumber(order.client_order_index);
    if (clientOrderIndex == null) return;
    const pending = this.pendingOrders.get(clientOrderIndex);
    if (!pending) return;
    const filledQuantity = this.toNumber(order.filled_base_amount) ?? 0;
    const filledQuote = this.toNumber(order.filled_quote_amount) ?? 0;
    const status = String(order.status ?? '').toLowerCase();

    if (filledQuantity > 0) {
      const averageFillPrice = filledQuote > 0 ? filledQuote / filledQuantity : this.averagePendingFillPrice(pending);
      this.resolvePendingOrder(clientOrderIndex, {
        ok: true,
        status: filledQuantity >= pending.requestedQuantity ? 'filled' : 'partially_filled',
        orderId: this.readExchangeOrderId(order as Record<string, unknown>) ?? pending.orderId ?? '',
        clientOrderId: pending.clientOrderId ?? '',
        requestedQuantity: pending.requestedQuantity,
        filledQuantity,
        averageFillPrice,
        fee: this.sumPendingFees(pending),
        message: `Order status: ${status}`
      });
    } else if (status.startsWith('cancel') || status === 'rejected' || status === 'failed') {
      this.resolvePendingOrder(clientOrderIndex, {
        ok: false,
        status: 'rejected',
        orderId: this.readExchangeOrderId(order as Record<string, unknown>) ?? pending.orderId ?? '',
        clientOrderId: pending.clientOrderId ?? '',
        requestedQuantity: pending.requestedQuantity,
        filledQuantity: 0,
        message: `Order status: ${status}`
      });
    }
  }

  private handleTradeUpdate(trade: LighterTrade): void {
    const clientOrderIndex = this.toNumber(trade.ask_client_id) ?? this.toNumber(trade.bid_client_id);
    if (clientOrderIndex == null) return;
    const pending = this.pendingOrders.get(clientOrderIndex);
    if (!pending) return;
    if (trade.market_id != null && Number(trade.market_id) !== pending.marketId) return;
    const tradeId = this.readTradeId(trade);
    if (tradeId && pending.seenTradeIds.has(tradeId)) return;
    if (tradeId) pending.seenTradeIds.add(tradeId);
    const quantity = this.toNumber(trade.size);
    const price = this.toNumber(trade.price);
    if (quantity == null || quantity <= 0 || price == null || price <= 0) return;
    pending.fills.push({ quantity, price, fee: this.toNumber(trade.taker_fee) ?? this.toNumber(trade.maker_fee) ?? 0 });

    const totalFilled = pending.fills.reduce((sum, fill) => sum + fill.quantity, 0);
    if (totalFilled >= pending.requestedQuantity * 0.99) {
      const averageFillPrice = pending.fills.reduce((sum, fill) => sum + fill.quantity * fill.price, 0) / totalFilled;
      console.log(`[${new Date().toISOString()}] [LIGHTER WS] Trade fill confirmed via WebSocket totalFilled=${totalFilled} requested=${pending.requestedQuantity}`);

      this.resolvePendingOrder(clientOrderIndex, {
        ok: true,
        status: totalFilled >= pending.requestedQuantity ? 'filled' : 'partially_filled',
        orderId: pending.orderId ?? '',
        clientOrderId: pending.clientOrderId ?? '',
        requestedQuantity: pending.requestedQuantity,
        filledQuantity: totalFilled,
        averageFillPrice,
        fee: this.sumPendingFees(pending),
        message: 'Execution confirmed from WebSocket fills'
      });
    }
  }

  private resolvePendingOrder(clientOrderIndex: number, result: ExecutionResult): void {
    const pending = this.pendingOrders.get(clientOrderIndex);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingOrders.delete(clientOrderIndex);
    pending.resolve(result);
  }

  private fillResult(req: OpenExecutionRequest | CloseExecutionRequest, pending: PendingOrder, quantity: number, orderId?: string): ExecutionResult {
    return {
      ok: true,
      status: quantity >= pending.requestedQuantity ? 'filled' : 'partially_filled',
      orderId: orderId ?? '',
      clientOrderId: req.clientOrderId,
      requestedQuantity: pending.requestedQuantity,
      filledQuantity: quantity,
      averageFillPrice: this.averagePendingFillPrice(pending),
      fee: this.sumPendingFees(pending),
      message: 'Execution confirmed from WebSocket fills'
    };
  }

  private averagePendingFillPrice(pending: PendingOrder): number {
    const quantity = pending.fills.reduce((sum, fill) => sum + fill.quantity, 0);
    if (quantity <= 0) return 0;
    return pending.fills.reduce((sum, fill) => sum + fill.quantity * fill.price, 0) / quantity;
  }

  private sumPendingFees(pending: PendingOrder): number {
    return pending.fills.reduce((sum, fill) => sum + fill.fee, 0);
  }

  private flattenOrders(orders?: LighterOrder[] | Record<string, LighterOrder[]>): LighterOrder[] {
    if (!orders) return [];
    return Array.isArray(orders) ? orders : Object.values(orders).flat().filter(Boolean);
  }

  private flattenTrades(trades?: LighterTrade[] | Record<string, LighterTrade[]>): LighterTrade[] {
    if (!trades) return [];
    return Array.isArray(trades) ? trades : Object.values(trades).flat().filter(Boolean);
  }

  private readExchangeOrderId(order: Record<string, unknown> | null): string | undefined {
    if (!order) return undefined;
    for (const key of ['order_id', 'order_index']) {
      const value = order[key];
      if (typeof value === 'string' && value) return value;
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return undefined;
  }

  private readTransactionId(tx: unknown): string | undefined {
    const record = tx as Record<string, unknown> | null;
    const value = record?.tx_hash ?? record?.txHash;
    return typeof value === 'string' && value ? value : undefined;
  }

  private readTradeId(trade: LighterTrade): string | undefined {
    const value = trade.trade_id ?? trade.tx_hash;
    return value == null ? undefined : String(value);
  }

  private toBaseAmount(quantity: number, sizeDecimals: number): number {
    return Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity * 10 ** sizeDecimals) : 0;
  }

  private toPriceUnits(price: number, priceDecimals: number): number {
    if (!Number.isFinite(price) || price <= 0) throw new Error(`Invalid order price: ${price}`);
    return Math.round(price * 10 ** priceDecimals);
  }

  private createClientOrderIndex(): number {
    this.orderSequence = (this.orderSequence + 1) % 1000;
    const value = Math.floor(Date.now() / 1000) + this.orderSequence;
    if (value > Number((2n ** 48n) - 1n)) throw new Error('client_order_index exceeds uint48');
    return value;
  }

  private toNumber(value: unknown): number | null {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  private rejectedResult(req: OpenExecutionRequest | CloseExecutionRequest, message: string): ExecutionResult {
    return { ok: false, status: 'rejected', clientOrderId: req.clientOrderId, requestedQuantity: req.quantity, filledQuantity: 0, message };
  }

  private unknownResult(req: OpenExecutionRequest | CloseExecutionRequest, message: string): ExecutionResult {
    return { ok: false, status: 'unknown', clientOrderId: req.clientOrderId, requestedQuantity: req.quantity, filledQuantity: 0, message };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private startAccountWebSocket(): void {
    this.accountWsStopped = false;
    this.ensureAccountWebSocket();
  }

  private ensureAccountWebSocket(): void {
    if (this.accountWsConnecting || this.accountWs?.readyState === WebSocket.OPEN || this.accountWsStopped) return;
    this.accountWsConnecting = true;
    const ws = new WebSocket(LIGHTER_WS_URL);
    this.accountWs = ws;

    ws.on('open', async () => {
      if (this.accountWs !== ws) return;
      this.accountWsConnecting = false;
      try {
        if (!this.authToken) {
          console.log(`[${new Date().toISOString()}] [LIGHTER WS] Creating auth token for account=${this.accountIndex}`);
          const [auth, authError] = this.signerClient.create_auth_token_with_expiry(60 * 60, undefined, this.apiKeyIndex);
          if (authError || !auth) throw new Error(authError ?? 'Failed to create auth token');
          this.authToken = auth;
          console.log(`[${new Date().toISOString()}] [LIGHTER WS] Auth token created successfully`);
        }
        ws.send(JSON.stringify({ type: 'subscribe', channel: `account_all/${this.accountIndex}`, auth: this.authToken }));
        console.log(`[${new Date().toISOString()}] [LIGHTER WS] Subscribed to account_all/${this.accountIndex}`);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] [LIGHTER WS] Auth error:`, error);
        ws.close();
        return;
      }
      this.accountWsPingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 30_000);
    });

    ws.on('message', raw => {
      if (this.accountWs !== ws) return;
      try {
        const message = JSON.parse(raw.toString()) as AccountMessage;
        console.log(`[${new Date().toISOString()}] [LIGHTER WS] Message received:`, JSON.stringify(message).slice(0, 500));
        this.handleAccountMessage(message);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] [LIGHTER WS] Invalid message:`, error);
      }
    });

    ws.on('error', error => {
      if (this.accountWs === ws) console.error(`[${new Date().toISOString()}] [LIGHTER WS] Error:`, error);
    });

    ws.on('close', () => {
      if (this.accountWs !== ws) return;
      console.log(`[${new Date().toISOString()}] [LIGHTER WS] Connection closed`);
      this.accountWsConnecting = false;
      this.accountWs = undefined;
      if (this.accountWsPingTimer) clearInterval(this.accountWsPingTimer);
      this.accountWsPingTimer = undefined;
      if (!this.accountWsStopped) {
        this.accountWsReconnectTimer = setTimeout(() => {
          this.accountWsReconnectTimer = undefined;
          console.log(`[${new Date().toISOString()}] [LIGHTER WS] Reconnecting...`);
          this.ensureAccountWebSocket();
        }, 3_000);
      }
    });
  }

  stop(): void {
    console.log(`[${new Date().toISOString()}] [LIGHTER] Execution service stopping`);
    this.accountWsStopped = true;
    if (this.accountWsReconnectTimer) clearTimeout(this.accountWsReconnectTimer);
    if (this.accountWsPingTimer) clearInterval(this.accountWsPingTimer);
    this.accountWs?.close();
    this.accountWs = undefined;
    for (const pending of this.pendingOrders.values()) {
      clearTimeout(pending.timer);
      pending.resolve(this.unknownResult({
        symbol: '', marketId: pending.marketId, positionSide: 'long', quantity: pending.requestedQuantity, expectedPrice: 0, reason: 'service_stop', clientOrderId: pending.clientOrderId ?? ''
      }, 'Execution service stopped'));
    }
    this.pendingOrders.clear();
    console.log(`[${new Date().toISOString()}] [LIGHTER] Execution service stopped`);
  }
}
