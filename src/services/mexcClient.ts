// src/services/mexcClient.ts
import crypto from 'crypto';

type RequestValue = string | number;

export interface TradeFee {
  symbol: string;
  makerFeeRate: number;
  takerFeeRate: number;
}

export interface MexcOrder {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET';
  quantity: number;
  price: number;
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED';
  executedQty: number;
  executedQuoteQty: number;
  createdAt: number;
}

export class MexcAuthenticatedClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly restUrl = 'https://api.mexc.com';

  constructor() {
    const apiKey = process.env.MEXC_API_KEY;
    const apiSecret = process.env.MEXC_API_SECRET;

    if (!apiKey || !apiSecret) {
      throw new Error('MEXC API credentials not configured');
    }

    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  private buildQueryString(
    params: Record<string, RequestValue>
  ): string {
    const sortedKeys = Object.keys(params).sort();
    
    return sortedKeys
      .map(key => `${key}=${String(params[key])}`)
      .join('&');
  }

  private signQueryString(
    queryString: string
  ): string {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
  }

  private headers(): HeadersInit {
    return {
      'X-MEXC-APIKEY': this.apiKey,
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
      throw new Error(`Invalid JSON response from MEXC: ${text}`);
    }
  }

  private buildSignedUrl(
    endpoint: string,
    params: Record<string, RequestValue>
  ): string {
    const queryString = this.buildQueryString(params);
    const signature = this.signQueryString(queryString);

    return `${this.restUrl}${endpoint}?${queryString}&signature=${signature}`;
  }

  async placeOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number
  ): Promise<MexcOrder> {
    const normalizedSymbol = symbol.toUpperCase().replace('/', '');
    
    const params: Record<string, RequestValue> = {
      symbol: normalizedSymbol,
      side,
      type: 'MARKET',
      quantity: quantity.toFixed(8),
      timestamp: Date.now(),
      recvWindow: 5000
    };

    console.log(
      `[MEXC] Placing ${side} order: ${quantity} ${normalizedSymbol} @ MARKET`
    );

    const response = await fetch(
      this.buildSignedUrl('/api/v3/order', params),
      {
        method: 'POST',
        headers: this.headers()
      }
    );

    const data = await this.readResponse(response);

    if (data.code && data.code !== 200) {
      throw new Error(`MEXC API error: ${data.code} - ${data.msg}`);
    }

    console.log(
      `[MEXC] Order placed: ${data.orderId}, executed: ${data.executedQty} @ ${data.price}`
    );

    return {
      orderId: data.orderId,
      symbol: normalizedSymbol,
      side,
      type: 'MARKET',
      quantity: Number(data.quantity ?? quantity),
      price: Number(data.price ?? 0),
      status: data.status,
      executedQty: Number(data.executedQty ?? 0),
      executedQuoteQty: Number(data.executedQuoteQty ?? 0),
      createdAt: Number(data.transactTime ?? Date.now())
    };
  }

  async cancelOrder(
    symbol: string,
    orderId: string
  ): Promise<void> {
    const normalizedSymbol = symbol.toUpperCase().replace('/', '');
    
    const params: Record<string, RequestValue> = {
      symbol: normalizedSymbol,
      orderId,
      timestamp: Date.now(),
      recvWindow: 5000
    };

    const response = await fetch(
      this.buildSignedUrl('/api/v3/order', params),
      {
        method: 'DELETE',
        headers: this.headers()
      }
    );

    const data = await this.readResponse(response);

    if (data.code && data.code !== 200) {
      throw new Error(`MEXC API error: ${data.code} - ${data.msg}`);
    }
  }

  async getOpenOrders(symbol?: string): Promise<MexcOrder[]> {
    const params: Record<string, RequestValue> = {
      timestamp: Date.now(),
      recvWindow: 5000
    };

    if (symbol) {
      params.symbol = symbol.toUpperCase().replace('/', '');
    }

    const response = await fetch(
      this.buildSignedUrl('/api/v3/openOrders', params),
      {
        method: 'GET',
        headers: this.headers()
      }
    );

    const data = await this.readResponse(response);

    if (!Array.isArray(data)) {
      throw new Error('Invalid open orders response from MEXC');
    }

    return data.map((order: any) => ({
      orderId: order.orderId,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      quantity: Number(order.origQty),
      price: Number(order.price),
      status: order.status,
      executedQty: Number(order.executedQty),
      executedQuoteQty: Number(order.executedQuoteQty),
      createdAt: Number(order.time)
    }));
  }

  async getTradeFee(symbol: string): Promise<TradeFee> {
    const normalizedSymbol = symbol.toUpperCase().replace('/', '');
  
    const params: Record<string, RequestValue> = {
      symbol: normalizedSymbol,
      timestamp: Date.now(),
      recvWindow: 5000
    };
  
    const queryString = this.buildQueryString(params);
    const signature = this.signQueryString(queryString);
    
    console.log('[MEXC] Input symbol:', symbol);
    console.log('[MEXC] Normalized symbol:', normalizedSymbol);
    console.log('[MEXC] Query string:', queryString);
    console.log('[MEXC] Signature:', signature);
  
    const response = await fetch(
      `${this.restUrl}/api/v3/tradeFee?${queryString}&signature=${signature}`,
      {
        method: 'GET',
        headers: this.headers()
      }
    );
  
    const data = await this.readResponse(response);
  
    console.log('[MEXC] Response:', JSON.stringify(data).slice(0, 200));
  
    const feeData = Array.isArray(data.data)
      ? data.data[0]
      : data.data ?? data;
  
    const makerFeeRate = Number(
      feeData?.makerCommission ??
      feeData?.makerFeeRate ??
      0.001
    );
  
    const takerFeeRate = Number(
      feeData?.takerCommission ??
      feeData?.takerFeeRate ??
      0.001
    );
  
    return {
      symbol: symbol.toUpperCase(),
      makerFeeRate: Number.isFinite(makerFeeRate) ? makerFeeRate : 0.001,
      takerFeeRate: Number.isFinite(takerFeeRate) ? takerFeeRate : 0.001
    };
  }

  async getAccountBalances(): Promise<
    Array<{
      asset: string;
      free: number;
      locked: number;
      total: number;
    }>
  > {
    const params: Record<string, RequestValue> = {
      timestamp: Date.now(),
      recvWindow: 5000
    };

    const response = await fetch(
      this.buildSignedUrl('/api/v3/account', params),
      {
        method: 'GET',
        headers: this.headers()
      }
    );

    const data = await this.readResponse(response);

    if (!Array.isArray(data.balances)) {
      throw new Error('Invalid balances response from MEXC');
    }

    return data.balances
      .filter((balance: any) => {
        const free = Number(balance.free ?? 0);
        const locked = Number(balance.locked ?? 0);
        return free > 0 || locked > 0;
      })
      .map((balance: any) => {
        const free = Number(balance.free ?? 0);
        const locked = Number(balance.locked ?? 0);

        return {
          asset: String(balance.asset),
          free,
          locked,
          total: free + locked
        };
      });
  }
}
