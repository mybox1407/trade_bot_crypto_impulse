export type OrderSide = 'buy' | 'sell';

export type PositionSide = 'long' | 'short';

export type ExecutionStatus =
  | 'filled'
  | 'partially_filled'
  | 'submitted'
  | 'rejected'
  | 'unknown';

export interface OpenExecutionRequest {
  symbol: string;
  marketId: number;
  side: PositionSide;
  quantity: number;
  expectedPrice: number;
  clientOrderId: string;
}

export interface CloseExecutionRequest {
  symbol: string;
  marketId: number;
  positionSide: PositionSide;
  quantity: number;
  expectedPrice: number;
  reason: string;
  clientOrderId: string;
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
  message?: string;
}

export interface ExecutionService {
  openPosition(
    req: OpenExecutionRequest
  ): Promise<ExecutionResult>;

  closePosition(
    req: CloseExecutionRequest
  ): Promise<ExecutionResult>;
}
