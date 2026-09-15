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
  private authTokenExpiresAt = 0;
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

      if (execution.filledQuantity <= 0 || execution.averageFillPrice == null) {
        return execution;
      }

      try {
        const actualBaseAmount = this.toBaseAmount(execution.filledQuantity, sizeDecimals);
        if (actualBaseAmount <= 0) {
          return {
            ...execution,
            ok: false,
            status: 'unknown',
            message: 'Execution returned invalid filled quantity'
          };
        }

        const protectiveOrders = await this.createProtectiveOrders(req, actualBaseAmount);
        return { ...execution, ok: true, protectiveOrders };
      } catch (error) {
        /*
         * The entry is already filled. Preserve the fill in the result so the
         * scheduler can persist the local position instead of losing it.
         */
        return {
          ...execution,
          ok: false,
          status: 'unknown',
          filledQuantity: execution.filledQuantity,
          averageFillPrice: execution.averageFillPrice,
          orderId: execution.orderId ?? submitted.orderId,
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
    const protectiveOrders = [
      { label: 'SL', orderId: orders.stopLossOrderId, orderIndex: orders.stopLossOrderIndex, clientOrderIndex: orders.stopLossClientOrderIndex },
      { label: 'TP', orderId: orders.takeProfitOrderId, orderIndex: orders.takeProfitOrderIndex, clientOrderIndex: orders.takeProfitClientOrderIndex }
    ];

    for (const protectiveOrder of protectiveOrders) {
      let orderIndex = protectiveOrder.orderIndex;
      if (orderIndex == null && protectiveOrder.orderId) {
        const parsed = Number(protectiveOrder.orderId);
        if (Number.isSafeInteger(parsed)) orderIndex = parsed;
      }
      if (orderIndex == null) continue;
      if (!Number.isSafeInteger(orderIndex) || orderIndex < 0) throw new Error(`Invalid ${protectiveOrder.label} exchange order index: ${orderIndex}`);

      const [, , sdkError] = await this.signerClient.cancel_order(
        orders.marketId,
        BigInt(orderIndex),
        -1,
        this.apiKeyIndex
      );
      if (sdkError) throw new Error(`Failed to cancel ${protectiveOrder.label} protective order ${orderIndex}: ${sdkError}`);
    }
  }

  private getAuthToken(forceRefresh = false): string {
    if (!forceRefresh && this.authToken && Date.now() < this.authTokenExpiresAt - 10_000) {
      return this.authToken;
    }
    const [authToken, authError] = this.signerClient.create_auth_token_with_expiry(60 * 60, undefined, this.apiKeyIndex);
    if (authError || !authToken) throw new Error(authError ?? 'Failed to create auth token');
    this.authToken = authToken;
    this.authTokenExpiresAt = Date.now() + 55 * 60_000;
    return authToken;
  }

  private async checkPendingRemoteOrders(marketId: number): Promise<boolean> {
    try {
      const [active, inactive] = await Promise.all([
        this.fetchOrders('accountActiveOrders'),
        this.fetchOrders('accountInactiveOrders')
      ]);
      return [...active, ...inactive].some(order => Number(order.market_index) === marketId && ['submitted', 'partially_filled', 'open'].includes(String(order.status).toLowerCase()));
    } catch (error) {
      console.error(`[${new Date().toISOString()}] [LIGHTER] checkPendingRemoteOrders ERROR marketId=${marketId}:`, error);
      throw error;
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

    const [slOrder, slTx, slError] = await this.signerClient.create_sl_order(req.marketId, slClientOrderIndex, baseAmount, slTrigger, slExecution, isAsk, true, -1, this.apiKeyIndex);
    if (slError) throw new Error(`SL creation failed: ${slError}`);

    const slOrderRecord = slOrder as Record<string, unknown> | null;
    const slOrderId = this.readExchangeOrderId(slOrderRecord) ?? this.readTransactionId(slTx);
    const slOrderIndex = this.readOrderIndex(slOrderRecord);

    try {
      const [tpOrder, tpTx, tpError] = await this.signerClient.create_tp_order(req.marketId, tpClientOrderIndex, baseAmount, tpTrigger, tpExecution, isAsk, true, -1, this.apiKeyIndex);
      if (tpError) throw new Error(`TP creation failed: ${tpError}`);
      const tpOrderRecord = tpOrder as Record<string, unknown> | null;
      return {
        marketId: req.marketId,
        stopLossOrderId: slOrderId,
        takeProfitOrderId: this.readExchangeOrderId(tpOrderRecord) ?? this.readTransactionId(tpTx),
        stopLossOrderIndex: slOrderIndex,
        takeProfitOrderIndex: this.readOrderIndex(tpOrderRecord),
        stopLossClientOrderIndex: slClientOrderIndex,
        takeProfitClientOrderIndex: tpClientOrderIndex
      };
    } catch (error) {
      if (slOrderIndex != null) {
        try {
          await this.cancelProtectiveOrders({
            marketId: req.marketId,
            stopLossOrderId: slOrderId,
            stopLossOrderIndex: slOrderIndex,
            stopLossClientOrderIndex: slClientOrderIndex,
            takeProfitClientOrderIndex: tpClientOrderIndex
          });
        } catch (cancelError) {
          console.error(`[${new Date().toISOString()}] [LIGHTER] cancel SL after TP failure failed:`, cancelError);
        }
      }
      throw error;
    }
  }

  private async submitMarketOrder(marketId: number, clientOrderIndex: number, baseAmount: number, expectedPrice: number, isAsk: boolean, reduceOnly: boolean, priceDecimals: number): Promise<{ ok: true; orderId?: string } | { ok: false; message: string }> {
    const maxSlippageBps = Number(process.env.LIGHTER_MARKET_SLIPPAGE_BPS ?? 50);
    if (!Number.isFinite(maxSlippageBps) || maxSlippageBps <= 0) throw new Error(`Invalid LIGHTER_MARKET_SLIPPAGE_BPS: ${maxSlippageBps}`);
    const idealPrice = Math.round(expectedPrice * 10 ** priceDecimals);
    const [order, tx, sdkError] = await this.signerClient.create_market_order_if_slippage(marketId, clientOrderIndex, baseAmount, maxSlippageBps / 10_000, isAsk, reduceOnly, -1, this.apiKeyIndex, idealPrice);
    if (sdkError) return { ok: false, message: sdkError };
    return { ok: true, orderId: this.readExchangeOrderId(order as Record<string, unknown> | null) ?? this.readTransactionId(tx) };
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
          this.resolvePendingOrder(clientOrderIndex, { ok: true, status: reconciled.filledQuantity >= requestedQuantity ? 'filled' : 'partially_filled', orderId: pending.orderId ?? orderId ?? '', clientOrderId: req.clientOrderId, requestedQuantity, filledQuantity: reconciled.filledQuantity, averageFillPrice: reconciled.averageFillPrice, fee: reconciled.fee, message: 'Execution confirmed via REST reconciliation' });
          return;
        }
        if (reconciled.status === 'CANCELED') {
          this.resolvePendingOrder(clientOrderIndex, { ok: false, status: 'rejected', orderId: pending.orderId ?? orderId ?? '', clientOrderId: req.clientOrderId, requestedQuantity, filledQuantity: 0, message: 'Order canceled (confirmed via REST)' });
          return;
        }
        this.resolvePendingOrder(clientOrderIndex, this.unknownResult(req, 'Order accepted but execution remains unconfirmed after REST reconciliation'));
      }, ORDER_WAIT_TIMEOUT_MS);
      this.pendingOrders.set(clientOrderIndex, { marketId, clientOrderIndex, clientOrderId: req.clientOrderId, requestedQuantity, resolve, timer, fills: [], seenTradeIds: new Set(), orderId });
      this.ensureAccountWebSocket();
    });
  }

  private async reconcileOrderViaRest(marketId: number, clientOrderIndex: number, orderId?: string): Promise<RestOrderResult> {
    const start = Date.now();
    while (Date.now() - start < REST_RECONCILIATION_TIMEOUT_MS) {
      try {
        const [active, inactive] = await Promise.all([this.fetchOrders('accountActiveOrders'), this.fetchOrders('accountInactiveOrders')]);
        const order = [...active, ...inactive].find(item => Number(item.market_index) === marketId && (Number(item.client_order_index) === clientOrderIndex || (orderId != null && String(item.order_id) === orderId) || (orderId != null && String(item.order_index) === orderId)));
        if (order) {
          const filledQuantity = this.toNumber(order.filled_base_amount) ?? 0;
          const filledQuote = this.toNumber(order.filled_quote_amount) ?? 0;
          const status = String(order.status ?? '').toLowerCase();
          if (filledQuantity > 0) return { status: 'FILLED', filledQuantity, averageFillPrice: filledQuote > 0 ? filledQuote / filledQuantity : undefined, fee: 0 };
          if (status.startsWith('cancel') || status === 'rejected' || status === 'failed') return { status: 'CANCELED', filledQuantity: 0, fee: 0 };
        }
      } catch (error) {
        if (error instanceof Error && /401|expired|auth/i.test(error.message)) {
          this.authToken = undefined;
          this.authTokenExpiresAt = 0;
        }
      }
      await this.sleep(REST_POLL_INTERVAL_MS);
    }
    return { status: 'UNKNOWN', filledQuantity: 0, fee: 0 };
  }

  private async fetchOrders(endpoint: 'accountActiveOrders' | 'accountInactiveOrders'): Promise<LighterOrder[]> {
    const url = new URL(`${LIGHTER_API_URL}/api/v1/${endpoint}`);
    url.searchParams.set('account_index', String(this.accountIndex));
    url.searchParams.set('limit', '100');
    let response = await fetch(url, { headers: { Accept: 'application/json', Authorization: this.getAuthToken() } });
    if (response.status === 401) {
      this.authToken = undefined;
      this.authTokenExpiresAt = 0;
      response = await fetch(url, { headers: { Accept: 'application/json', Authorization: this.getAuthToken(true) } });
    }
    if (!response.ok) throw new Error(`Lighter orders request failed: ${response.status} ${await response.text()}`);
    const data = await response.json() as Record<string, unknown>;
    return Array.isArray(data.orders) ? data.orders.filter((order): order is LighterOrder => !!order && typeof order === 'object') : [];
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
      this.resolvePendingOrder(clientOrderIndex, { ok: true, status: filledQuantity >= pending.requestedQuantity ? 'filled' : 'partially_filled', orderId: this.readExchangeOrderId(order as Record<string, unknown>) ?? pending.orderId ?? '', clientOrderId: pending.clientOrderId ?? '', requestedQuantity: pending.requestedQuantity, filledQuantity, averageFillPrice: filledQuote > 0 ? filledQuote / filledQuantity : this.averagePendingFillPrice(pending), fee: this.sumPendingFees(pending), message: `Order status: ${status}` });
    } else if (status.startsWith('cancel') || status === 'rejected' || status === 'failed') {
      this.resolvePendingOrder(clientOrderIndex, { ok: false, status: 'rejected', orderId: this.readExchangeOrderId(order as Record<string, unknown>) ?? pending.orderId ?? '', clientOrderId: pending.clientOrderId ?? '', requestedQuantity: pending.requestedQuantity, filledQuantity: 0, message: `Order status: ${status}` });
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
      this.resolvePendingOrder(clientOrderIndex, { ok: true, status: totalFilled >= pending.requestedQuantity ? 'filled' : 'partially_filled', orderId: pending.orderId ?? '', clientOrderId: pending.clientOrderId ?? '', requestedQuantity: pending.requestedQuantity, filledQuantity: totalFilled, averageFillPrice, fee: this.sumPendingFees(pending), message: 'Execution confirmed from WebSocket fills' });
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
    return { ok: true, status: quantity >= pending.requestedQuantity ? 'filled' : 'partially_filled', orderId: orderId ?? '', clientOrderId: req.clientOrderId, requestedQuantity: pending.requestedQuantity, filledQuantity: quantity, averageFillPrice: this.averagePendingFillPrice(pending), fee: this.sumPendingFees(pending), message: 'Execution confirmed from WebSocket fills' };
  }

  private averagePendingFillPrice(pending: PendingOrder): number {
    const quantity = pending.fills.reduce((sum, fill) => sum + fill.quantity, 0);
    return quantity > 0 ? pending.fills.reduce((sum, fill) => sum + fill.quantity * fill.price, 0) / quantity : 0;
  }

  private sumPendingFees(pending: PendingOrder): number { return pending.fills.reduce((sum, fill) => sum + fill.fee, 0); }
  private flattenOrders(orders?: LighterOrder[] | Record<string, LighterOrder[]>): LighterOrder[] { return !orders ? [] : Array.isArray(orders) ? orders : Object.values(orders).flat().filter(Boolean); }
  private flattenTrades(trades?: LighterTrade[] | Record<string, LighterTrade[]>): LighterTrade[] { return !trades ? [] : Array.isArray(trades) ? trades : Object.values(trades).flat().filter(Boolean); }
  private readExchangeOrderId(order: Record<string, unknown> | null): string | undefined { const value = order?.order_id; return typeof value === 'string' && value ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined; }
  private readOrderIndex(order: Record<string, unknown> | null): number | undefined { const value = order?.order_index; const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined; }
  private readTransactionId(tx: unknown): string | undefined { const record = tx as Record<string, unknown> | null; const value = record?.tx_hash ?? record?.txHash; return typeof value === 'string' && value ? value : undefined; }
  private readTradeId(trade: LighterTrade): string | undefined { const value = trade.trade_id ?? trade.tx_hash; return value == null ? undefined : String(value); }
  private toBaseAmount(quantity: number, sizeDecimals: number): number { return Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity * 10 ** sizeDecimals) : 0; }
  private toPriceUnits(price: number, priceDecimals: number): number { if (!Number.isFinite(price) || price <= 0) throw new Error(`Invalid order price: ${price}`); return Math.round(price * 10 ** priceDecimals); }
  private createClientOrderIndex(): number { this.orderSequence = (this.orderSequence + 1) % 1000; const value = Math.floor(Date.now() / 1000) + this.orderSequence; if (value > Number((2n ** 48n) - 1n)) throw new Error('client_order_index exceeds uint48'); return value; }
  private toNumber(value: unknown): number | null { const number = Number(value); return Number.isFinite(number) ? number : null; }
  private rejectedResult(req: OpenExecutionRequest | CloseExecutionRequest, message: string): ExecutionResult { return { ok: false, status: 'rejected', clientOrderId: req.clientOrderId, requestedQuantity: req.quantity, filledQuantity: 0, message }; }
  private unknownResult(req: OpenExecutionRequest | CloseExecutionRequest, message: string): ExecutionResult { return { ok: false, status: 'unknown', clientOrderId: req.clientOrderId, requestedQuantity: req.quantity, filledQuantity: 0, message }; }
  private sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

  private startAccountWebSocket(): void { this.accountWsStopped = false; this.ensureAccountWebSocket(); }
  private ensureAccountWebSocket(): void {
    if (this.accountWsConnecting || this.accountWs?.readyState === WebSocket.OPEN || this.accountWsStopped) return;
    this.accountWsConnecting = true;
    const ws = new WebSocket(LIGHTER_WS_URL);
    this.accountWs = ws;
    ws.on('open', () => {
      if (this.accountWs !== ws) return;
      this.accountWsConnecting = false;
      try {
        const auth = this.getAuthToken();
        ws.send(JSON.stringify({ type: 'subscribe', channel: `account_all/${this.accountIndex}`, auth }));
        this.accountWsPingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' })); }, 30_000);
      } catch (error) { console.error(`[${new Date().toISOString()}] [LIGHTER WS] Auth error:`, error); ws.close(); }
    });
    ws.on('message', raw => { if (this.accountWs !== ws) return; try { this.handleAccountMessage(JSON.parse(raw.toString()) as AccountMessage); } catch (error) { console.error(`[${new Date().toISOString()}] [LIGHTER WS] Invalid message:`, error); } });
    ws.on('error', error => { if (this.accountWs === ws) console.error(`[${new Date().toISOString()}] [LIGHTER WS] Error:`, error); });
    ws.on('close', () => { if (this.accountWs !== ws) return; this.accountWsConnecting = false; this.accountWs = undefined; if (this.accountWsPingTimer) clearInterval(this.accountWsPingTimer); this.accountWsPingTimer = undefined; if (!this.accountWsStopped) this.accountWsReconnectTimer = setTimeout(() => { this.accountWsReconnectTimer = undefined; this.ensureAccountWebSocket(); }, 3_000); });
  }

  stop(): void {
    this.accountWsStopped = true;
    if (this.accountWsReconnectTimer) clearTimeout(this.accountWsReconnectTimer);
    if (this.accountWsPingTimer) clearInterval(this.accountWsPingTimer);
    this.accountWs?.close();
    this.accountWs = undefined;
    for (const pending of this.pendingOrders.values()) { clearTimeout(pending.timer); pending.resolve(this.unknownResult({ symbol: '', marketId: pending.marketId, positionSide: 'long', quantity: pending.requestedQuantity, expectedPrice: 0, reason: 'service_stop', clientOrderId: pending.clientOrderId ?? '' }, 'Execution service stopped')); }
    this.pendingOrders.clear();
  }
}
