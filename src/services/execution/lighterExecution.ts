import {
  ExecutionService,
  OpenExecutionRequest,
  CloseExecutionRequest,
  ExecutionResult
} from './types';

import {
  getMarketPrice
} from '../exchange';

// zklighter-sdk imports
import {
  SignerClient,
  L2CreateOrderTx,
  OrderType,
  TimeInForce
} from 'zklighter-sdk';

const LIGHTER_API_URL =
  process.env.LIGHTER_API_URL ??
  'https://mainnet.zklighter.elliot.ai';

interface RespSendTx {
  code: number;
  message?: string;
  tx_hash?: string;
}

interface LighterFill {
  fill_id: string;
  order_index: number;
  price: string;
  quantity: string;
  fee: string;
  timestamp: number;
  is_ask: number;
}

export class LighterExecutionService
  implements ExecutionService
{
  private signerClient: SignerClient;
  private nonceCache = new Map<number, number>();

  constructor(
    apiKeyPrivateKey: string,
    private readonly apiKeyIndex: number,
    private readonly accountIndex: number
  ) {
    if (!apiKeyPrivateKey) {
      throw new Error(
        'LighterExecutionService: ' +
          'LIGHTER_API_KEY (private key) is required'
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

    // Normalize private key (remove 0x prefix if present)
    const normalizedKey = apiKeyPrivateKey.startsWith('0x')
      ? apiKeyPrivateKey.slice(2)
      : apiKeyPrivateKey;

    // Initialize SignerClient
    this.signerClient = new SignerClient(
      normalizedKey,
      accountIndex,
      LIGHTER_API_URL
    );
  }

  async openPosition(
    req: OpenExecutionRequest
  ): Promise<ExecutionResult> {
    console.log(
      `[${new Date().toISOString()}] 🔵 [LIGHTER] OPEN ` +
        `${req.symbol} (marketId=${req.marketId}) ` +
        `${req.side.toUpperCase()} ` +
        `qty=${req.quantity.toFixed(8)} ` +
        `@ ~${req.expectedPrice.toFixed(6)}`
    );

    try {
      // 1. Округляем quantity согласно sizeDecimals
      const marketPrice = getMarketPrice(req.symbol);
      const sizeDecimals = marketPrice?.sizeDecimals ?? 8;
      const roundedQuantity =
        Math.round(req.quantity * Math.pow(10, sizeDecimals));

      // 2. Определяем сторону ордера
      // long -> buy (is_ask = false)
      // short -> sell (is_ask = true)
      const isAsk = req.side === 'long' ? false : true;

      // 3. Получаем nonce
      const nonce = await this.getNextNonce();

      // 4. Формируем transaction payload через SDK
      const txPayload: L2CreateOrderTx = {
        tx_type: 14, // TX_TYPE_CREATE_ORDER
        account_id: this.accountIndex,
        market_index: req.marketId,
        client_order_index: BigInt(Date.now()),
        base_amount: BigInt(roundedQuantity),
        price: BigInt(Math.round(req.expectedPrice * 100)), // price in cents
        is_ask: isAsk,
        order_type: OrderType.Market,
        time_in_force: TimeInForce.ImmediateOrCancel,
        reduce_only: false,
        trigger_price: BigInt(0),
        order_expiry: BigInt(0),
        nonce: BigInt(nonce),
        api_key_index: BigInt(this.apiKeyIndex)
      };

      // 5. Подписываем transaction через SDK
      const signature = await this.signerClient.signL2CreateOrderTx(txPayload);

      // 6. Отправляем transaction с подписью
      const txWithSignature = {
        ...txPayload,
        signature
      };

      const sendResult = await this.sendTransaction(txWithSignature);

      if (!sendResult.ok) {
        return {
          ok: false,
          status: 'rejected',
          clientOrderId: req.clientOrderId,
          requestedQuantity: req.quantity,
          filledQuantity: 0,
          message: sendResult.message ?? 'Transaction rejected'
        };
      }

      const txHash = sendResult.txHash;

      console.log(
        `[${new Date().toISOString()}] 🔵 [LIGHTER] TX SENT: ${txHash}`
      );

      // 7. Ждём fill (polling)
      await this.sleep(1000);

      const fills = await this.waitForFills(
        req.marketId,
        this.accountIndex,
        30,
        500
      );

      if (fills.length === 0) {
        return {
          ok: false,
          status: 'unknown',
          clientOrderId: req.clientOrderId,
          requestedQuantity: req.quantity,
          filledQuantity: 0,
          message: 'No fills received'
        };
      }

      // 8. Считаем средний fill price и total fee
      let totalQuantity = 0;
      let totalValue = 0;
      let totalFee = 0;

      for (const fill of fills) {
        const qty = Number(fill.quantity);
        const price = Number(fill.price);
        const fee = Number(fill.fee) ?? 0;

        totalQuantity += qty;
        totalValue += qty * price;
        totalFee += fee;
      }

      const averageFillPrice =
        totalQuantity > 0 ? totalValue / totalQuantity : 0;

      // Конвертируем из cents в обычную цену
      const avgPriceNormalized = averageFillPrice / 100;

      return {
        ok: true,
        status: 'filled',
        orderId: txHash,
        clientOrderId: req.clientOrderId,
        requestedQuantity: req.quantity,
        filledQuantity: totalQuantity / Math.pow(10, sizeDecimals),
        averageFillPrice: avgPriceNormalized,
        fee: totalFee
      };
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] 🔵 [LIGHTER] OPEN ERROR:`,
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
      `[${new Date().toISOString()}] 🔴 [LIGHTER] CLOSE ` +
        `${req.symbol} (marketId=${req.marketId}) ` +
        `${req.positionSide.toUpperCase()} ` +
        `qty=${req.quantity.toFixed(8)} ` +
        `@ ~${req.expectedPrice.toFixed(6)} ` +
        `reason=${req.reason}`
    );

    try {
      // 1. Округляем quantity
      const marketPrice = getMarketPrice(req.symbol);
      const sizeDecimals = marketPrice?.sizeDecimals ?? 8;
      const roundedQuantity =
        Math.round(req.quantity * Math.pow(10, sizeDecimals));

      // 2. Определяем сторону ордера (для закрытия всегда reduce_only)
      // long -> sell (is_ask = true)
      // short -> buy (is_ask = false)
      const isAsk = req.positionSide === 'long' ? true : false;

      // 3. Получаем nonce
      const nonce = await this.getNextNonce();

      // 4. Формируем transaction payload
      const txPayload: L2CreateOrderTx = {
        tx_type: 14,
        account_id: this.accountIndex,
        market_index: req.marketId,
        client_order_index: BigInt(Date.now()),
        base_amount: BigInt(roundedQuantity),
        price: BigInt(Math.round(req.expectedPrice * 100)),
        is_ask: isAsk,
        order_type: OrderType.Market,
        time_in_force: TimeInForce.ImmediateOrCancel,
        reduce_only: true, // reduce-only для закрытия
        trigger_price: BigInt(0),
        order_expiry: BigInt(0),
        nonce: BigInt(nonce),
        api_key_index: BigInt(this.apiKeyIndex)
      };

      // 5. Подписываем transaction
      const signature = await this.signerClient.signL2CreateOrderTx(txPayload);

      // 6. Отправляем transaction с подписью
      const txWithSignature = {
        ...txPayload,
        signature
      };

      const sendResult = await this.sendTransaction(txWithSignature);

      if (!sendResult.ok) {
        return {
          ok: false,
          status: 'rejected',
          clientOrderId: req.clientOrderId,
          requestedQuantity: req.quantity,
          filledQuantity: 0,
          message: sendResult.message ?? 'Transaction rejected'
        };
      }

      const txHash = sendResult.txHash;

      console.log(
        `[${new Date().toISOString()}] 🔴 [LIGHTER] TX SENT: ${txHash}`
      );

      // 7. Ждём fill
      await this.sleep(1000);

      const fills = await this.waitForFills(
        req.marketId,
        this.accountIndex,
        30,
        500
      );

      if (fills.length === 0) {
        return {
          ok: false,
          status: 'unknown',
          clientOrderId: req.clientOrderId,
          requestedQuantity: req.quantity,
          filledQuantity: 0,
          message: 'No fills received'
        };
      }

      // 8. Считаем средний fill price и total fee
      let totalQuantity = 0;
      let totalValue = 0;
      let totalFee = 0;

      for (const fill of fills) {
        const qty = Number(fill.quantity);
        const price = Number(fill.price);
        const fee = Number(fill.fee) ?? 0;

        totalQuantity += qty;
        totalValue += qty * price;
        totalFee += fee;
      }

      const averageFillPrice =
        totalQuantity > 0 ? totalValue / totalQuantity : 0;

      const avgPriceNormalized = averageFillPrice / 100;

      return {
        ok: true,
        status: 'filled',
        orderId: txHash,
        clientOrderId: req.clientOrderId,
        requestedQuantity: req.quantity,
        filledQuantity: totalQuantity / Math.pow(10, sizeDecimals),
        averageFillPrice: avgPriceNormalized,
        fee: totalFee
      };
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] 🔴 [LIGHTER] CLOSE ERROR:`,
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

  private async getNextNonce(): Promise<number> {
    const cachedNonce = this.nonceCache.get(this.apiKeyIndex);

    const nonce = cachedNonce ?? (await this.fetchNonce());

    this.nonceCache.set(this.apiKeyIndex, nonce + 1);

    return nonce;
  }

  private async fetchNonce(): Promise<number> {
    const params = new URLSearchParams({
      account_index: String(this.accountIndex),
      api_key_index: String(this.apiKeyIndex)
    });

    const response = await fetch(
      `${LIGHTER_API_URL}/api/v1/nextNonce?${params.toString()}`
    );

    if (!response.ok) {
      throw new Error(
        `Failed to fetch nonce: HTTP ${response.status}`
      );
    }

    const data = await response.json() as {
      code: number;
      nonce?: number;
    };

    if (data.code !== 200 || data.nonce == null) {
      throw new Error('Invalid nonce response');
    }

    return data.nonce;
  }

  private async sendTransaction(
    tx: L2CreateOrderTx & { signature: string }
  ): Promise<{
    ok: boolean;
    txHash?: string;
    message?: string;
  }> {
    const response = await fetch(
      `${LIGHTER_API_URL}/api/v1/sendTx`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(tx)
      }
    );

    const body = await response.text();

    if (!response.ok) {
      return {
        ok: false,
        message: `HTTP ${response.status}: ${body}`
      };
    }

    const data = JSON.parse(body) as RespSendTx;

    if (data.code !== 200) {
      return {
        ok: false,
        message:
          `API error ${data.code}: ` +
          `${data.message ?? 'unknown error'}`
      };
    }

    return {
      ok: true,
      txHash: data.tx_hash,
      message: data.message
    };
  }

  private async waitForFills(
    marketId: number,
    accountIndex: number,
    maxAttempts: number,
    intervalMs: number
  ): Promise<LighterFill[]> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await this.sleep(intervalMs);

      const fills = await this.fetchFills(marketId, accountIndex);

      if (fills.length > 0) {
        return fills;
      }
    }

    return [];
  }

  private async fetchFills(
    marketId: number,
    accountIndex: number
  ): Promise<LighterFill[]> {
    const params = new URLSearchParams({
      market_id: String(marketId),
      account_index: String(accountIndex)
    });

    const response = await fetch(
      `${LIGHTER_API_URL}/api/v1/fills?${params.toString()}`
    );

    if (!response.ok) {
      return [];
    }

    const data = await response.json() as {
      code: number;
      fills?: LighterFill[];
    };

    if (data.code !== 200) {
      return [];
    }

    return data.fills ?? [];
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
