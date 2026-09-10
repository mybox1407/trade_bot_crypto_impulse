// src/routes/position.ts
import { Router } from 'express';
import {
  closePosition,
  getBalance,
  getLastClosedTrade,
  getOpenPositionsCount,
  getPosition,
  getPositionById,
  getPositions,
  hasOpenPosition,
  MAX_PARALLEL_POSITIONS,
  openPosition
} from '../services/positionState';
import { MexcAuthenticatedClient } from '../services/mexcClient';

const router = Router();
const mexcClient = new MexcAuthenticatedClient();

type CloseReason =
  | 'take_profit'
  | 'stop_loss'
  | 'manual'
  | 'time_stop'
  | 'breakeven_stop'
  | 'dead_trade_mfe';

function normalizeSymbol(
  symbol?: string
): string | undefined {
  if (typeof symbol !== 'string') {
    return undefined;
  }

  const normalized = symbol
    .trim()
    .toUpperCase()
    .replace('/', '_')
    .replace('-', '_');

  return normalized || undefined;
}

function normalizeFuturesSymbol(
  symbol: string
): string {
  const normalized = normalizeSymbol(symbol);

  if (!normalized) {
    throw new Error('Invalid Futures symbol');
  }

  if (normalized.includes('_')) {
    return normalized;
  }

  if (normalized.endsWith('USDT')) {
    return `${normalized.slice(0, -4)}_USDT`;
  }

  throw new Error(
    `Invalid Futures symbol "${symbol}". Expected BASE_USDT`
  );
}

async function getFuturesCurrentPrice(
  symbol: string
): Promise<number> {
  const futuresSymbol =
    normalizeFuturesSymbol(symbol);

  const ticker =
    await mexcClient.getFuturesTicker(
      futuresSymbol
    );

  const price = Number(
    ticker.fairPrice ??
    ticker.lastPrice
  );

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(
      `Invalid Futures price for ${futuresSymbol}: ${price}`
    );
  }

  return price;
}

function isValidSide(
  side: unknown
): side is 'long' | 'short' {
  return side === 'long' || side === 'short';
}

function isValidCloseReason(
  reason: unknown
): reason is CloseReason {
  return (
    reason === 'take_profit' ||
    reason === 'stop_loss' ||
    reason === 'manual' ||
    reason === 'time_stop' ||
    reason === 'breakeven_stop' ||
    reason === 'dead_trade_mfe'
  );
}

router.get('/status', (_req, res) => {
  return res.json({
    ok: true,
    market: 'MEXC_FUTURES',
    balance: getBalance(),
    openPositionsCount: getOpenPositionsCount(),
    maxParallelPositions: MAX_PARALLEL_POSITIONS,
    positions: getPositions(),
    lastClosedTrade: getLastClosedTrade()
  });
});

router.get('/balance', (_req, res) => {
  return res.json({
    ok: true,
    market: 'MEXC_FUTURES',
    balance: getBalance()
  });
});

router.post('/open', async (req, res) => {
  try {
    const rawBody = req.body as {
      symbol?: string;
      side?: 'long' | 'short';
      takeProfitPrice?: number;
      stopLossPrice?: number;
    };

    const symbol = normalizeFuturesSymbol(
      rawBody.symbol ?? ''
    );

    const side = rawBody.side;
    const takeProfitPrice =
      Number(rawBody.takeProfitPrice);
    const stopLossPrice =
      Number(rawBody.stopLossPrice);

    if (
      !isValidSide(side) ||
      !Number.isFinite(takeProfitPrice) ||
      !Number.isFinite(stopLossPrice)
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'symbol, side, takeProfitPrice and ' +
          'stopLossPrice are required'
      });
    }

    if (hasOpenPosition(symbol)) {
      return res.status(409).json({
        ok: false,
        message:
          `Position for ${symbol} already open`,
        positions: getPositions()
      });
    }

    if (
      getOpenPositionsCount() >=
      MAX_PARALLEL_POSITIONS
    ) {
      return res.status(409).json({
        ok: false,
        message:
          `Max ${MAX_PARALLEL_POSITIONS} ` +
          'open positions reached',
        positions: getPositions()
      });
    }

    const entryPrice =
      await getFuturesCurrentPrice(symbol);

    const result = await openPosition({
      symbol,
      side,
      entryPrice,
      takeProfitPrice,
      stopLossPrice
    });

    const statusCode = result.ok ? 200 : 400;

    return res.status(statusCode).json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : 'Unknown error'
    });
  }
});

router.post('/check-close', async (req, res) => {
  try {
    const symbol = normalizeFuturesSymbol(
      (req.body as { symbol?: string }).symbol ?? ''
    );

    const position = getPosition(symbol);

    if (!position) {
      return res.json({
        ok: true,
        action: 'none',
        symbol,
        reason: 'no_position'
      });
    }

    const currentPrice =
      await getFuturesCurrentPrice(
        position.symbol
      );

    const hitTakeProfit =
      position.side === 'long'
        ? currentPrice >=
          position.takeProfitPrice
        : currentPrice <=
          position.takeProfitPrice;

    const hitStopLoss =
      position.side === 'long'
        ? currentPrice <=
          position.stopLossPrice
        : currentPrice >=
          position.stopLossPrice;

    if (hitTakeProfit) {
      const result = await closePosition(
        position.id,
        currentPrice,
        'take_profit'
      );

      return res.json({
        ok: result.ok,
        action: result.ok ? 'closed' : 'error',
        symbol: position.symbol,
        currentPrice,
        result
      });
    }

    if (hitStopLoss) {
      const result = await closePosition(
        position.id,
        currentPrice,
        'stop_loss'
      );

      return res.json({
        ok: result.ok,
        action: result.ok ? 'closed' : 'error',
        symbol: position.symbol,
        currentPrice,
        result
      });
    }

    return res.json({
      ok: true,
      action: 'hold',
      symbol: position.symbol,
      currentPrice,
      position
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : 'Unknown error'
    });
  }
});

router.post('/close', async (req, res) => {
  try {
    const rawBody = req.body as {
      positionId?: string;
      symbol?: string;
      reason?: CloseReason;
    };

    const positionId =
      typeof rawBody.positionId === 'string'
        ? rawBody.positionId.trim()
        : undefined;

    const symbol = rawBody.symbol
      ? normalizeFuturesSymbol(rawBody.symbol)
      : undefined;

    const reason = rawBody.reason ?? 'manual';

    if (!isValidCloseReason(reason)) {
      return res.status(400).json({
        ok: false,
        message: `Invalid close reason: ${reason}`
      });
    }

    const position = positionId
      ? getPositionById(positionId)
      : symbol
        ? getPosition(symbol)
        : getPosition();

    if (!position) {
      return res.status(409).json({
        ok: false,
        message: 'No open position'
      });
    }

    const exitPrice =
      await getFuturesCurrentPrice(
        position.symbol
      );

    const result = await closePosition(
      position.id,
      exitPrice,
      reason
    );

    return res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : 'Unknown error'
    });
  }
});

export default router;
