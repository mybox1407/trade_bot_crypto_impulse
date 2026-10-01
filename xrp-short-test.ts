import 'dotenv/config';
import { SignerClient } from 'zklighter-sdk';

const API_URL =
  process.env.LIGHTER_API_URL ??
  'https://mainnet.zklighter.elliot.ai';

const API_SECRET =
  process.env.LIGHTER_API_SECRET ?? '';

const API_KEY_INDEX =
  Number(process.env.LIGHTER_API_KEY_INDEX ?? 0);

const ACCOUNT_INDEX =
  Number(process.env.LIGHTER_ACCOUNT_INDEX ?? 0);

// Укажи здесь marketId XRP из Lighter
const XRP_MARKET_ID = 7;

const PRICE_DECIMALS = 6;
const SIZE_DECIMALS = 0;

const BALANCE_PERCENT = 0.10;
const STOP_LOSS_ATR_MULTIPLIER = 2.8;
const TAKE_PROFIT_ATR_MULTIPLIER = 3.0;
const MARKET_SLIPPAGE_BPS = 50;
const PROTECTION_SLIPPAGE_PCT = 0.5;

type Candle = {
  open: number;
  high: number;
  low: number;
  close: number;
};

function toUnits(
  value: number,
  decimals: number
): number {
  return Math.round(value * 10 ** decimals);
}

function createClientOrderIndex(): number {
  return Math.floor(Date.now() / 1000);
}

function assertPositive(
  name: string,
  value: number
): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} is invalid: ${value}`);
  }
}

async function getAccountBalance(
  signer: SignerClient
): Promise<number> {
  const url = new URL(
    `${API_URL}/api/v1/account`
  );

  url.searchParams.set('by', 'index');
  url.searchParams.set(
    'value',
    String(ACCOUNT_INDEX)
  );

  const result =
    signer.create_auth_token_with_expiry(
      60 * 60,
      undefined,
      API_KEY_INDEX
    );

  const authToken = result[0];

  if (!authToken) {
    throw new Error(
      'Failed to create Lighter auth token'
    );
  }

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: authToken
    }
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `Account request failed: ` +
      `${response.status}: ${body}`
    );
  }

  const data = JSON.parse(body) as any;

  const accounts =
    Array.isArray(data.accounts)
      ? data.accounts
      : [];

  const account =
    accounts.find((item: any) =>
      Number(
        item?.index ??
        item?.account_index
      ) === ACCOUNT_INDEX
    ) ??
    data.account;

  if (!account) {
    throw new Error(
      `Account ${ACCOUNT_INDEX} not found`
    );
  }

  const balance = Number(
    account.collateral ??
    account.available_balance ??
    account.availableBalance ??
    account.balance ??
    account.total_asset_value
  );

  if (!Number.isFinite(balance) || balance < 0) {
    throw new Error(
      `Invalid balance: ${balance}`
    );
  }

  return balance;
}

async function getMarkPrice(): Promise<number> {
  const url = new URL(
    `${API_URL}/api/v1/orderBookDetails`
  );

  url.searchParams.set(
    'market_id',
    String(XRP_MARKET_ID)
  );

  const response = await fetch(url);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `Order book request failed: ` +
      `${response.status}: ${body}`
    );
  }

  const data = JSON.parse(body) as any;

  const book =
    data.perp_order_books?.[0] ??
    data.perps_order_books?.[0] ??
    data.order_book_details?.[0] ??
    data.orderBookDetails?.[0] ??
    data;

  const markPrice = Number(
    book.mark_price ??
    book.markPrice ??
    book.last_trade_price ??
    book.lastPrice ??
    book.mid_price ??
    book.midPrice
  );

  if (!Number.isFinite(markPrice) || markPrice <= 0) {
    throw new Error(
      `Mark price is invalid: ${markPrice}; ` +
      `response: ${JSON.stringify(data).slice(0, 1000)}`
    );
  }

  return markPrice;
}

async function getCandles(): Promise<Candle[]> {
  const url = new URL(
    `${API_URL}/api/v1/candles`
  );

  const endTimestamp =
    Math.floor(Date.now() / 1000);

  const startTimestamp =
    endTimestamp - 100 * 15 * 60;

  url.searchParams.set(
    'market_id',
    String(XRP_MARKET_ID)
  );
  url.searchParams.set(
    'resolution',
    '15m'
  );
  url.searchParams.set(
    'start_timestamp',
    String(startTimestamp)
  );
  url.searchParams.set(
    'end_timestamp',
    String(endTimestamp)
  );
  url.searchParams.set(
    'count_back',
    '100'
  );
  url.searchParams.set(
    'set_timestamp_to_end',
    'false'
  );

  const response = await fetch(url);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `Candles request failed: ` +
      `${response.status}: ${body}`
    );
  }

  const data = JSON.parse(body) as any;

  if (!Array.isArray(data.c)) {
    throw new Error(
      'Invalid candles response: ' +
      JSON.stringify(data).slice(0, 1000)
    );
  }

  return data.c
    .map((candle: any) => ({
      open: Number(candle.o),
      high: Number(candle.h),
      low: Number(candle.l),
      close: Number(candle.c)
    }))
    .filter((candle: Candle) =>
      Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close) &&
      candle.high > 0 &&
      candle.low > 0
    );
}

function calculateAtr(
  candles: Candle[],
  period = 14
): number {
  if (candles.length < period + 1) {
    throw new Error(
      `Not enough candles for ATR: ${candles.length}`
    );
  }

  const trueRanges: number[] = [];

  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const previous = candles[i - 1];

    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(
          current.high - previous.close
        ),
        Math.abs(
          current.low - previous.close
        )
      )
    );
  }

  const values =
    trueRanges.slice(-period);

  return values.reduce(
    (sum, value) => sum + value,
    0
  ) / values.length;
}

function getOrderId(
  order: unknown
): string | undefined {
  if (!order || typeof order !== 'object') {
    return undefined;
  }

  const record =
    order as Record<string, unknown>;

  const value =
    record.order_id ??
    record.orderIndex ??
    record.order_index;

  return value == null
    ? undefined
    : String(value);
}

function getOrderIndex(
  order: unknown
): number | undefined {
  if (!order || typeof order !== 'object') {
    return undefined;
  }

  const record =
    order as Record<string, unknown>;

  const value =
    record.order_index ??
    record.orderIndex ??
    record.order_id;

  const index = Number(value);

  return Number.isSafeInteger(index)
    ? index
    : undefined;
}

function createAuthToken(
  signer: SignerClient
): string {
  const result =
    signer.create_auth_token_with_expiry(
      60 * 60,
      undefined,
      API_KEY_INDEX
    );

  const token = result[0];

  if (!token) {
    throw new Error(
      'Failed to create Lighter auth token'
    );
  }

  return token;
}

type RemoteOrder = {
  market_index?: number | string;
  client_order_index?: number | string;
  order_index?: number | string;
  order_id?: number | string;
  status?: string;
  filled_base_amount?: number | string;
  remaining_base_amount?: number | string;
  is_ask?: boolean | number;
};

async function getOrders(
  signer: SignerClient,
  endpoint:
    | 'accountActiveOrders'
    | 'accountInactiveOrders'
): Promise<RemoteOrder[]> {
  const url = new URL(
    `${API_URL}/api/v1/${endpoint}`
  );

  url.searchParams.set(
    'account_index',
    String(ACCOUNT_INDEX)
  );
  url.searchParams.set(
    'market_id',
    String(XRP_MARKET_ID)
  );
  url.searchParams.set(
    'market_type',
    'perp'
  );

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: createAuthToken(signer)
    }
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `${endpoint} failed: ` +
      `${response.status}: ${body}`
    );
  }

  const data = JSON.parse(body) as any;

  return Array.isArray(data.orders)
    ? data.orders
    : [];
}

async function waitForEntryFill(
  signer: SignerClient,
  clientOrderIndex: number,
  timeoutMs = 45_000
): Promise<{
  filledBaseAmount: number;
  averagePrice?: number;
  order: RemoteOrder;
}> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const [active, inactive] =
      await Promise.all([
        getOrders(
          signer,
          'accountActiveOrders'
        ),
        getOrders(
          signer,
          'accountInactiveOrders'
        )
      ]);

    const order = [
      ...active,
      ...inactive
    ].find(item =>
      Number(item.client_order_index) ===
      clientOrderIndex
    );

    if (order) {
      const filledBaseAmount =
        Number(
          order.filled_base_amount ?? 0
        );

      const status =
        String(order.status ?? '')
          .toLowerCase();

      console.log('ENTRY STATUS', {
        clientOrderIndex,
        status,
        filledBaseAmount,
        remainingBaseAmount:
          order.remaining_base_amount,
        isAsk: order.is_ask
      });

      if (
        Number.isFinite(filledBaseAmount) &&
        filledBaseAmount > 0
      ) {
        return {
          filledBaseAmount,
          order
        };
      }

      if (
        status.includes('cancel') ||
        status === 'rejected' ||
        status === 'failed' ||
        status === 'expired'
      ) {
        throw new Error(
          `Entry was not filled: ${status}`
        );
      }
    }

    await new Promise(resolve =>
      setTimeout(resolve, 1_500)
    );
  }

  throw new Error(
    `Entry fill timeout for client_order_index=` +
    clientOrderIndex
  );
}

async function main(): Promise<void> {
  if (!API_SECRET) {
    throw new Error(
      'LIGHTER_API_SECRET is missing in .env'
    );
  }

  const signer = new SignerClient(
    API_URL,
    API_SECRET.replace(/^0x/, ''),
    API_KEY_INDEX,
    ACCOUNT_INDEX
  );

  const balance =
    await getAccountBalance(signer);

  const entryPrice =
    await getMarkPrice();

  const candles =
    await getCandles();

  const atr =
    calculateAtr(candles);

  const margin =
    balance * BALANCE_PERCENT;

  const quantity =
    margin / entryPrice;

  const baseAmount =
    Math.floor(
      quantity * 10 ** SIZE_DECIMALS
    );

  if (baseAmount <= 0) {
    throw new Error(
      `Invalid base amount: ${baseAmount}`
    );
  }

  const stopLossPrice =
    entryPrice +
    atr * STOP_LOSS_ATR_MULTIPLIER;

  const takeProfitPrice =
    entryPrice -
    atr * TAKE_PROFIT_ATR_MULTIPLIER;

  const entryClientOrderIndex =
    createClientOrderIndex();

  console.log({
    marketId: XRP_MARKET_ID,
    balance,
    margin,
    entryPrice,
    atr,
    quantity,
    baseAmount,
    stopLossPrice,
    takeProfitPrice,
    entryIsAsk: true
  });

  const [
    entryOrder,
    entryTx,
    entryError
  ] =
    await signer.create_market_order_if_slippage(
      XRP_MARKET_ID,
      entryClientOrderIndex,
      baseAmount,
      MARKET_SLIPPAGE_BPS / 10_000,
      true,
      false,
      -1,
      API_KEY_INDEX,
      toUnits(
        entryPrice,
        PRICE_DECIMALS
      )
    );

  if (entryError) {
    throw new Error(
      `Short entry failed: ${entryError}`
    );
  }

  console.log('SHORT ENTRY SUBMITTED', {
    orderId: getOrderId(entryOrder),
    orderIndex: getOrderIndex(entryOrder),
    clientOrderIndex: entryClientOrderIndex,
    order: entryOrder,
    tx: entryTx
  });

  const filled =
    await waitForEntryFill(
      signer,
      entryClientOrderIndex
    );

  const filledBaseAmount =
    filled.filledBaseAmount;

  const filledQuantity =
    filledBaseAmount /
    10 ** SIZE_DECIMALS;

  const actualEntryPrice =
    entryPrice;

  console.log('SHORT ENTRY FILLED', {
    filledBaseAmount,
    filledQuantity,
    actualEntryPrice,
    isAsk: true
  });

  const slClientOrderIndex =
    entryClientOrderIndex + 1;

  const tpClientOrderIndex =
    entryClientOrderIndex + 2;

  const slTrigger =
    toUnits(
      stopLossPrice,
      PRICE_DECIMALS
    );

  const tpTrigger =
    toUnits(
      takeProfitPrice,
      PRICE_DECIMALS
    );

  const slExecution =
    toUnits(
      stopLossPrice *
      (1 + PROTECTION_SLIPPAGE_PCT / 100),
      PRICE_DECIMALS
    );

  const tpExecution =
    toUnits(
      takeProfitPrice *
      (1 + PROTECTION_SLIPPAGE_PCT / 100),
      PRICE_DECIMALS
    );

  const [
    slOrder,
    slTx,
    slError
  ] =
    await signer.create_sl_order(
      XRP_MARKET_ID,
      slClientOrderIndex,
      filledBaseAmount,
      slTrigger,
      slExecution,
      false,
      true,
      -1,
      API_KEY_INDEX
    );

  if (slError) {
    throw new Error(
      `Stop-loss creation failed: ${slError}`
    );
  }

  console.log('SHORT STOP-LOSS CREATED', {
    orderId: getOrderId(slOrder),
    triggerPrice: stopLossPrice,
    executionPrice:
      stopLossPrice *
      (1 + PROTECTION_SLIPPAGE_PCT / 100),
    order: slOrder,
    tx: slTx
  });

  const [
    tpOrder,
    tpTx,
    tpError
  ] =
    await signer.create_tp_order(
      XRP_MARKET_ID,
      tpClientOrderIndex,
      filledBaseAmount,
      tpTrigger,
      tpExecution,
      false,
      true,
      -1,
      API_KEY_INDEX
    );

  if (tpError) {
    throw new Error(
      `Take-profit creation failed: ${tpError}`
    );
  }

  console.log('SHORT TAKE-PROFIT CREATED', {
    orderId: getOrderId(tpOrder),
    triggerPrice: takeProfitPrice,
    executionPrice:
      takeProfitPrice *
      (1 + PROTECTION_SLIPPAGE_PCT / 100),
    order: tpOrder,
    tx: tpTx
  });

  console.log('DONE: POSITION FILLED AND PROTECTED');
}

main().catch(error => {
  console.error(
    `[${new Date().toISOString()}]`,
    error instanceof Error
      ? error.message
      : error
  );

  process.exitCode = 1;
});
