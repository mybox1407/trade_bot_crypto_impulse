import {
  setBalance
} from './positionState';

export interface LiveAccountState {
  balance: number;
  equity?: number;
  availableBalance?: number;
  updatedAt: string;
}

let accountState:
  LiveAccountState | null = null;

function validateNonNegative(
  value: number,
  field: string
): number {
  if (
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new Error(
      `Invalid live account ${field}: ${value}`
    );
  }

  return value;
}

export function updateLiveAccountState(
  data: {
    balance: number;
    equity?: number;
    availableBalance?: number;
  }
): LiveAccountState {
  const nextState:
    LiveAccountState = {
    balance: validateNonNegative(
      data.balance,
      'balance'
    ),
    equity:
      data.equity == null
        ? undefined
        : validateNonNegative(
            data.equity,
            'equity'
          ),
    availableBalance:
      data.availableBalance == null
        ? undefined
        : validateNonNegative(
            data.availableBalance,
            'availableBalance'
          ),
    updatedAt:
      new Date().toISOString()
  };

  accountState = nextState;

  setBalance(
    nextState.balance
  );

  return (
    getLiveAccountState()!
  );
}

export function getLiveAccountState():
  | LiveAccountState
  | null {
  return accountState
    ? {
        ...accountState
      }
    : null;
}

export function clearLiveAccountState(): void {
  accountState = null;
}
