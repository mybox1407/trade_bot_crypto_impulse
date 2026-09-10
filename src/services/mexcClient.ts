// src/services/mexcClient.ts
import crypto from 'crypto';

type RequestValue = string | number;

export interface TradeFee {
  symbol: string;
  makerFeeRate: number;
  takerFeeRate: number;
}

export class MexcAuthenticatedClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly restUrl = 'https://api.mexc.com';

  constructor() {
    const apiKey = process.env.MEXC_API_KEY;
    const apiSecret = process.env.MEXC_SECRET_KEY;

    if (!apiKey || !apiSecret) {
      throw new Error('MEXC API credentials not configured');
    }

    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  private buildQueryString(
    params: Record<string, RequestValue>
  ): string {
    // Сортируем ключи по алфавиту - это критично для подписи!
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

  async getTradeFee(symbol: string): Promise<TradeFee> {
    const normalizedSymbol = symbol.toUpperCase();

    const params: Record<string, RequestValue> = {
      symbol: normalizedSymbol,
      timestamp: Date.now(),
      recvWindow: 5000
    };

    const response = await fetch(
      this.buildSignedUrl('/api/v3/tradeFee', params),
      {
        method: 'GET',
        headers: this.headers()
      }
    );

    const data = await this.readResponse(response);

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
      symbol: normalizedSymbol,
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
