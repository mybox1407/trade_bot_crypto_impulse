// xrp-short-test.ts
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

// Укажи фактический market index XRP из конфигурации Lighter
const XRP_MARKET_ID =
  Number(process.env.XRP_MARKET_ID ?? 0);

const PRICE_DECIMALS = 4;
const SIZE_DECIMALS = 6;

const BALANCE_PERCENT = 0.10;
const SL_ATR_MULTIPLIER = 2.8;
const TP_ATR_MULTIPLIER = 3.0;
const SLIPPAGE_BPS = 50;

const signer = new SignerClient(
  API_URL,
  API_SECRET.replace(/^0x/, ''),
  API_KEY_INDEX,
  ACCOUNT_INDEX
);

function units(value: number, decimals: number): number {
  return Math.round(value * 10 ** decimals);
}

function clientOrderIndex(): number {
  return Math.floor(Date.now() / 1000);
}

async function getBalance(): Promise<number> {
  const response = await fetch(
    `${API_URL}/api/v1/account`,
  );

  if (!response.ok) {
    throw new Error(
      `Balance request failed: ${response.status}`,
    );
  }

  const data = await response.json() as any;

  const balance = Number(
    data.accounts?.[0]?.available_balance ??
    data.available_balance ??
    data.balance
  );

  if (!Number.isFinite(balance) || balance <= 0) {
    throw new Error(`Invalid balance: ${balance}`);
  }

  return balance;
}

async function getCandles(): Promise<number[][]> {
  const response = await fetch(
    `${API_URL}/api/v1/candles?market_id=${XRP_MARKET_ID}&resolution=15m&count=100`,
  );

  if (!response.ok) {
    throw new Error(
      `Candles request failed: ${response.status}`,
    );
  }

  const data = await response.json() as any;

  return data.candles ?? data;
}

function calculateAtr(candles: number[][], period = 14): number {
  if (candles.length < period + 1) {
    throw new Error('Not enough candles for ATR');
  }

  const trueRanges: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const previousClose = Number(candles[i - 1][4]);
    const high = Number(candles[i][2]);
    const low = Number(candles[i][3]);

    trueRanges.push(
      Math.max(
        high - low,
        Math.abs(high - previousClose),
        Math.abs(low - previousClose),
      ),
    );
  }

  const recent = trueRanges.slice(-period);

  return recent.reduce(
    (sum, value) => sum + value,
    0,
  ) / recent.length;
}

async function getMarkPrice(): Promise<number> {
  const response = await fetch(
    `${API_URL}/api/v1/orderBookDetails?market_id=${XRP_MARKET_ID}`,
  );

  if (!response.ok) {
    throw new Error(
      `Market price request failed: ${response.status}`,
    );
  }

  const data = await response.json() as any;

  const price = Number(
    data.mark_price ??
    data.markPrice ??
    data.mid_price ??
    data.midPrice
  );

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid XRP price: ${price}`);
  }

  return price;
}

async function main(): Promise<void> {
  if (!API_SECRET) {
    throw new Error(
      'LIGHTER_API_SECRET is required',
    );
  }

  if (!Number.isInteger(XRP_MARKET_ID)) {
    throw new Error(
      `Invalid XRP_MARKET_ID: ${XRP_MARKET_ID}`,
    );
  }

  const balance = await getBalance();
  const price = await getMarkPrice();
  const candles = await getCandles();
  const atr = calculateAtr(candles);

  const margin = balance * BALANCE_PERCENT;
  const quantity = margin / price;

  const entryPrice = price;

  // Short: SL выше входа, TP ниже входа
  const stopLossPrice =
    entryPrice + atr * SL_ATR_MULTIPLIER;

  const takeProfitPrice =
    entryPrice - atr * TP_ATR_MULTIPLIER;

  const baseAmount = units(
    quantity,
    SIZE_DECIMALS,
  );

  if (baseAmount <= 0) {
    throw new Error('Calculated order size is zero');
  }

  const entryClientIndex = clientOrderIndex();

  console.log({
    marketId: XRP_MARKET_ID,
    balance,
    margin,
    entryPrice,
    atr,
    quantity,
    stopLossPrice,
    takeProfitPrice,
    entryIsAsk: true,
  });

  // SHORT = SELL = isAsk=true
  const [entryOrder, entryTx, entryError] =
    await signer.create_market_order_if_slippage(
      XRP_MARKET_ID,
      entryClientIndex,
      baseAmount,
      SLIPPAGE_BPS / 10_000,
      true,
      false,
      -1,
      API_KEY_INDEX,
      units(entryPrice, PRICE_DECIMALS),
    );

  if (entryError) {
    throw new Error(
      `Short entry failed: ${entryError}`,
    );
  }

  console.log('SHORT ENTRY SUBMITTED', {
    order: entryOrder,
    tx: entryTx,
  });

  // Для Short защитные заявки закрывают через BUY = isAsk=false
  const slClientIndex = clientOrderIndex() + 1;
  const tpClientIndex = clientOrderIndex() + 2;

  const slTrigger = units(
    stopLossPrice,
    PRICE_DECIMALS,
  );

  const tpTrigger = units(
    takeProfitPrice,
    PRICE_DECIMALS,
  );

  const slExecution = units(
    stopLossPrice * 1.005,
    PRICE_DECIMALS,
  );

  const tpExecution = units(
    takeProfitPrice * 1.005,
    PRICE_DECIMALS,
  );

  const [slOrder, slTx, slError] =
    await signer.create_sl_order(
      XRP_MARKET_ID,
      slClientIndex,
      baseAmount,
      slTrigger,
      slExecution,
      false,
      true,
      -1,
      API_KEY_INDEX,
    );

  if (slError) {
    throw new Error(
      `SL creation failed: ${slError}`,
    );
  }

  console.log('SHORT SL SUBMITTED', {
    order: slOrder,
    tx: slTx,
    triggerPrice: stopLossPrice,
    executionPrice: stopLossPrice * 1.005,
  });

  const [tpOrder, tpTx, tpError] =
    await signer.create_tp_order(
      XRP_MARKET_ID,
      tpClientIndex,
      baseAmount,
      tpTrigger,
      tpExecution,
      false,
      true,
      -1,
      API_KEY_INDEX,
    );

  if (tpError) {
    throw new Error(
      `TP creation failed: ${tpError}`,
    );
  }

  console.log('SHORT TP SUBMITTED', {
    order: tpOrder,
    tx: tpTx,
    triggerPrice: takeProfitPrice,
    executionPrice: takeProfitPrice * 1.005,
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
