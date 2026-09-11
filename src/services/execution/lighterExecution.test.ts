import {
  LighterExecutionService
} from './lighterExecution';

const privateKey =
  process.env.LIGHTER_API_KEY ??
  '00'.repeat(32);

const client =
  new LighterExecutionService(
    privateKey,
    0,
    746073
  );

const clientOrderIndex =
  Date.now();

const result =
  new Promise(resolve => {
    (
      client as any
    ).pendingOrders.set(
      clientOrderIndex,
      {
        marketId: 2,
        clientOrderIndex,
        requestedQuantity: 0.01,
        timer: setTimeout(() => {
          resolve({
            ok: false,
            status: 'unknown',
            filledQuantity: 0,
            requestedQuantity: 0.01,
            message: 'Test timeout'
          });
        }, 3000),
        resolve
      }
    );
  });

(
  client as any
).testAccountMessage({
  type: 'update/account_all_orders',
  orders: [
    {
      order_index: 123456,
      client_order_index: clientOrderIndex,
      market_index: 2,
      filled_base_amount: '1000000',
      filled_quote_amount: '250000000',
      status: 'filled'
    }
  ]
});

const executionResult =
  await result;

console.log(
  JSON.stringify(
    executionResult,
    null,
    2
  )
);

client.stop();
