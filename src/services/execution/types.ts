export type OrderSide = 'buy' | 'sell';

export type PositionSide = 'long' | 'short';

export type ExecutionStatus =
  | 'filled'
  | 'partially_filled'
  | 'submitted'
  | 'rejected'
  | 'unknown';

export type CloseReason =
  | 'take_profit'
  | 'stop_loss'
  | 'manual'
  | 'time_stop'
  | 'breakeven_stop'
  | 'dead_trade_mfe'
  | 'partial_close'
  | 'reconciliation_missing_remote'
  | 'reconciliation_severe_mismatch';

export interface OpenExecutionRequest {
  symbol: string;
  marketId: number;
  side: PositionSide;
  quantity: number;
  expectedPrice: number;
  clientOrderId: string;
  priceDecimals?: number;
  sizeDecimals?: number;
  stopLossPrice: number;
  takeProfitPrice: number;
}

export interface CloseExecutionRequest {
  symbol: string;
  marketId: number;
  positionSide: PositionSide;
  quantity: number;
  expectedPrice: number;
  reason: CloseReason | string;
  clientOrderId: string;
  priceDecimals?: number;
  sizeDecimals?: number;
}

export interface ProtectiveOrders {
  marketId: number;
  stopLossOrderId?: string;
  takeProfitOrderId?: string;
  stopLossClientOrderIndex: number;
  takeProfitClientOrderIndex: number;
}

export interface ExecutionResult {
  ok: boolean;
  status: ExecutionStatus;
  orderId?: string;
  clientOrderId: string;
  requestedQuantity: number;
  filledQuantity: number;
  averageFillPrice?: number;
  fee?: number;
  protectiveOrders?: ProtectiveOrders;
  message?: string;
}

export interface ExecutionService {
  openPosition(
    req: OpenExecutionRequest
  ): Promise<ExecutionResult>;

  closePosition(
    req: CloseExecutionRequest
  ): Promise<ExecutionResult>;

  cancelProtectiveOrders?(
    orders: ProtectiveOrders
  ): Promise<void>;

  stop?(): void;
}
