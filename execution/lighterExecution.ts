import {
  ExecutionService,
  OpenExecutionRequest,
  CloseExecutionRequest,
  ExecutionResult
} from './types';

const LIGHTER_API_URL =
  process.env.LIGHTER_API_URL ??
  'https://mainnet.zklighter.elliot.ai';

export class LighterExecutionService
  implements ExecutionService
{
  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly accountIndex: number
  ) {
    if (!apiKey || !apiSecret) {
      throw new Error(
        'LighterExecutionService: ' +
          'LIGHTER_API_KEY and LIGHTER_API_SECRET are required'
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
  }

  async openPosition(
    req: OpenExecutionRequest
  ): Promise<ExecutionResult> {
    console.log(
      `[${new Date().toISOString()}] 🔵 [LIGHTER] WOULD OPEN ` +
        `${req.symbol} (marketId=${req.marketId}) ` +
        `${req.side.toUpperCase()} ` +
        `qty=${req.quantity.toFixed(8)} ` +
        `@ ${req.expectedPrice.toFixed(6)}`
    );

    // TODO: реализовать реальное открытие позиции:
    // 1. Округлить quantity и price согласно sizeDecimals / priceDecimals.
    // 2. Сформировать payload для market order.
    // 3. Подписать запрос (API key, secret, nonce, accountIndex).
    // 4. Отправить POST /api/v1/order.
    // 5. Дождаться fill (polling / WebSocket).
    // 6. Вернуть orderId, filledQuantity, averageFillPrice, fee.

    return {
      ok: false,
      status: 'unknown',
      clientOrderId: req.clientOrderId,
      requestedQuantity: req.quantity,
      filledQuantity: 0,
      message: 'Lighter execution not implemented yet'
    };
  }

  async closePosition(
    req: CloseExecutionRequest
  ): Promise<ExecutionResult> {
    console.log(
      `[${new Date().toISOString()}] 🔴 [LIGHTER] WOULD CLOSE ` +
        `${req.symbol} (marketId=${req.marketId}) ` +
        `${req.positionSide.toUpperCase()} ` +
        `qty=${req.quantity.toFixed(8)} ` +
        `@ ${req.expectedPrice.toFixed(6)} ` +
        `reason=${req.reason}`
    );

    // TODO: реализовать реальное закрытие позиции:
    // 1. Определить сторону ордера:
    //    - long -> sell
    //    - short -> buy
    // 2. Установить reduceOnly = true.
    // 3. Округлить quantity.
    // 4. Подписать и отправить order.
    // 5. Дождаться fill.
    // 6. Вернуть orderId, filledQuantity, averageFillPrice, fee.

    return {
      ok: false,
      status: 'unknown',
      clientOrderId: req.clientOrderId,
      requestedQuantity: req.quantity,
      filledQuantity: 0,
      message: 'Lighter execution not implemented yet'
    };
  }
}
