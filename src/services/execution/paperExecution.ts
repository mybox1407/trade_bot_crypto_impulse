// src/services/execution/paperExecution.ts

import {
  ExecutionService,
  OpenExecutionRequest,
  CloseExecutionRequest,
  ExecutionResult,
  EnsureProtectiveOrdersRequest,
  ProtectiveOrders
} from './types';

import {
  TRADE_FEE_RATE
} from '../strategy';

export class PaperExecutionService
  implements ExecutionService
{
  async openPosition(
    req: OpenExecutionRequest
  ): Promise<ExecutionResult> {
    console.log(
      `[${new Date().toISOString()}] ` +
        `📄 [PAPER] OPEN ` +
        `${req.symbol} ` +
        `${req.side.toUpperCase()} ` +
        `qty=${req.quantity.toFixed(8)} ` +
        `@ ${req.expectedPrice.toFixed(6)}`
    );

    const notional =
      req.quantity * req.expectedPrice;

    const fee =
      notional * TRADE_FEE_RATE;

    return {
      ok: true,
      status: 'filled',
      clientOrderId: req.clientOrderId,
      requestedQuantity: req.quantity,
      filledQuantity: req.quantity,
      averageFillPrice: req.expectedPrice,
      fee
    };
  }

  async closePosition(
    req: CloseExecutionRequest
  ): Promise<ExecutionResult> {
    console.log(
      `[${new Date().toISOString()}] ` +
        `📄 [PAPER] CLOSE ` +
        `${req.symbol} ` +
        `${req.positionSide.toUpperCase()} ` +
        `qty=${req.quantity.toFixed(8)} ` +
        `@ ${req.expectedPrice.toFixed(6)} ` +
        `reason=${req.reason}`
    );

    const notional =
      req.quantity * req.expectedPrice;

    const fee =
      notional * TRADE_FEE_RATE;

    return {
      ok: true,
      status: 'filled',
      clientOrderId: req.clientOrderId,
      requestedQuantity: req.quantity,
      filledQuantity: req.quantity,
      averageFillPrice: req.expectedPrice,
      fee
    };
  }

  async ensureProtectiveOrders(
    req: EnsureProtectiveOrdersRequest
  ): Promise<ProtectiveOrders> {
    // Paper-реализация: просто логируем, реальные ордера не ставим
    console.log(
      `[${new Date().toISOString()}] ` +
        `📄 [PAPER] ensureProtectiveOrders ` +
        `${req.symbol} ${req.side.toUpperCase()} ` +
        `qty=${req.quantity.toFixed(8)} ` +
        `TP=${req.takeProfitPrice.toFixed(6)} ` +
        `SL=${req.stopLossPrice.toFixed(6)}`
    );

    // Возвращаем заглушку — в paper-режиме ордера не создаются
    return {
      marketId: req.marketId,
      stopLossClientOrderIndex: 0,
      takeProfitClientOrderIndex: 0
    };
  }
}
