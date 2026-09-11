import { Router } from 'express';
import { getCurrentPrice } from '../services/exchange';
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
  openPosition,
  getPositionNotional
} from '../services/positionState';

const router = Router();

function normalizeSymbol(
  symbol?: string
): string | undefined {
  return typeof symbol === 'string'
    ? symbol.trim().toUpperCase()
    : undefined;
}

function isValidPrice(
  price: number | null
): price is number {
  return price != null && Number.isFinite(price);
}

router.get('/status', (_req, res) => {
  res.json({
    ok: true,
    balance: getBalance(),
    openPositionsCount: getOpenPositionsCount(),
    maxParallelPositions: MAX_PARALLEL_POSITIONS,
    positions: getPositions(),
    lastClosedTrade: getLastClosedTrade()
  });
});

router.get('/balance', (_req, res) => {
  res.json({
    ok: true,
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

    const symbol = normalizeSymbol(rawBody.symbol);

    const {
      side,
      takeProfitPrice,
      stopLossPrice
    } = rawBody;

    if (
      !symbol ||
      !side ||
      takeProfitPrice == null ||
      stopLossPrice == null
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'symbol, side, takeProfitPrice, stopLossPrice are required'
      });
    }

    if (hasOpenPosition(symbol)) {
      return res.status(409).json({
        ok: false,
        message: `Position for ${symbol} already open`,
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
          `open positions reached`,
        positions: getPositions()
      });
    }

    const entryPrice =
      getCurrentPrice(symbol);

    if (!isValidPrice(entryPrice)) {
      return res.status(503).json({
        ok: false,
        message:
          `Current price unavailable for ${symbol}`
      });
    }

    const positionNotional = getPositionNotional();
    const quantity = positionNotional / entryPrice;

    const result = openPosition({
      symbol,
      side,
      entryPrice,
      quantity,
      takeProfitPrice,
      stopLossPrice
    });

    const statusCode =
      result.ok ? 200 : 400;

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
    const symbol = normalizeSymbol(
      (req.body as { symbol?: string }).symbol
    );

    if (!symbol) {
      return res.status(400).json({
        ok: false,
        message: 'symbol is required'
      });
    }

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
      getCurrentPrice(position.symbol);

    if (!isValidPrice(currentPrice)) {
      return res.status(503).json({
        ok: false,
        message:
          `Current price unavailable for ${position.symbol}`
      });
    }

    const hitTakeProfit =
      position.side === 'long'
        ? currentPrice >= position.takeProfitPrice
        : currentPrice <= position.takeProfitPrice;

    const hitStopLoss =
      position.side === 'long'
        ? currentPrice <= position.stopLossPrice
        : currentPrice >= position.stopLossPrice;

    if (hitTakeProfit) {
      const result = closePosition(
        position.id,
        currentPrice,
        'take_profit'
      );

      return res.json({
        ok: true,
        action: 'closed',
        symbol: position.symbol,
        currentPrice,
        result
      });
    }

    if (hitStopLoss) {
      const result = closePosition(
        position.id,
        currentPrice,
        'stop_loss'
      );

      return res.json({
        ok: true,
        action: 'closed',
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
      reason?:
        | 'take_profit'
        | 'stop_loss'
        | 'manual';
    };

    const {
      positionId,
      reason
    } = rawBody;

    const symbol =
      normalizeSymbol(rawBody.symbol);

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
      getCurrentPrice(position.symbol);

    if (!isValidPrice(exitPrice)) {
      return res.status(503).json({
        ok: false,
        message:
          `Current price unavailable for ${position.symbol}`
      });
    }

    const result = closePosition(
      position.id,
      exitPrice,
      reason || 'manual'
    );

    return res.json(result);
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
