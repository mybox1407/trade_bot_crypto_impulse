// src/services/ml/mlModel.ts

import {
  spawn,
  ChildProcess
} from 'node:child_process';

import {
  existsSync,
  readFileSync
} from 'node:fs';

import path from 'node:path';


// ==================== TYPES ====================

export type MlPredictionInput = {
  entryPrice: number;
  ema20: number;
  ema50: number;
  ema200: number;
  lastRsi: number;
  adx: number;
  bbWidth: number;
  atrPct: number;
  lastAtr: number;
  entryDistanceFromEma20Atr: number;
  side: 'long' | 'short';

  /**
   * Время формирования сигнала или открытия сделки.
   *
   * Пример:
   * 2026-09-25T11:30:00.000Z
   */
  openedAt: string;
};


export type MlPredictionResult = {
  probability: number;
  threshold: number;
  passed: boolean;
  trainedAt: string | null;
  trainingRows: number | null;
};


export type MlModelInfo = {
  available: boolean;
  trainedAt: string | null;
  trainingRows: number | null;
  profitRows: number | null;
  lossRows: number | null;
};


type ProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};


type PredictionJson = {
  probability?: unknown;
  threshold?: unknown;
  passed?: unknown;
  trained_at?: unknown;
  training_rows?: unknown;
  feature_count?: unknown;
  error?: unknown;
};


type ModelMetadataJson = {
  trained_at?: unknown;
  training_rows?: unknown;
  profit_rows?: unknown;
  loss_rows?: unknown;

  // Для совместимости со старыми meta-файлами.
  tp_rows?: unknown;
  sl_rows?: unknown;
};


// ==================== PATHS ====================

const PYTHON_BIN =
  process.env.PYTHON_BIN ?? 'python3';


const PROJECT_ROOT = path.resolve(
  process.cwd()
);


const ML_DIR = path.resolve(
  process.env.ML_DIR ??
    path.join(PROJECT_ROOT, 'ml')
);


const TRAIN_SCRIPT = path.join(
  ML_DIR,
  'train_model.py'
);


const PREDICT_SCRIPT = path.join(
  ML_DIR,
  'predict_model.py'
);


const MODEL_FILE = path.join(
  ML_DIR,
  'trade_model.joblib'
);


const MODEL_META_FILE = path.join(
  ML_DIR,
  'trade_model_meta.json'
);


// ==================== TIMEOUTS ====================

const ML_TIMEOUT_MS = 10_000;
const TRAIN_TIMEOUT_MS = 30 * 60 * 1000;


// ==================== PROCESS ====================

function collectProcessOutput(
  child: ChildProcess,
  timeoutMs: number
): Promise<ProcessResult> {
  return new Promise(
    (resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;

      const timeout = setTimeout(
        () => {
          if (settled) {
            return;
          }

          try {
            child.stdin?.destroy();
            child.kill('SIGTERM');
          } catch {
            // Процесс уже мог завершиться.
          }

          finishError(
            new Error(
              `Python process timeout after ${timeoutMs} ms`
            )
          );
        },
        timeoutMs
      );

      const finishError = (
        error: Error
      ): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      const finishSuccess = (
        result: ProcessResult
      ): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };

      child.stdout?.on(
        'data',
        (chunk: Buffer | string) => {
          stdout += chunk.toString();
        }
      );

      child.stderr?.on(
        'data',
        (chunk: Buffer | string) => {
          stderr += chunk.toString();
        }
      );

      child.once(
        'error',
        (error: Error) => {
          finishError(error);
        }
      );

      child.once(
        'close',
        (code: number | null) => {
          finishSuccess({
            code,
            stdout,
            stderr
          });
        }
      );
    }
  );
}


// ==================== VALIDATION ====================

function ensureMlFilesExist(): void {
  if (!existsSync(ML_DIR)) {
    throw new Error(
      `ML directory not found: ${ML_DIR}`
    );
  }

  if (!existsSync(TRAIN_SCRIPT)) {
    throw new Error(
      `Training script not found: ${TRAIN_SCRIPT}`
    );
  }

  if (!existsSync(PREDICT_SCRIPT)) {
    throw new Error(
      `Prediction script not found: ${PREDICT_SCRIPT}`
    );
  }
}


function ensureFiniteInput(
  input: MlPredictionInput
): void {
  const numericValues = [
    input.entryPrice,
    input.ema20,
    input.ema50,
    input.ema200,
    input.lastRsi,
    input.adx,
    input.bbWidth,
    input.atrPct,
    input.lastAtr,
    input.entryDistanceFromEma20Atr
  ];

  if (
    numericValues.some(
      value => !Number.isFinite(value)
    )
  ) {
    throw new Error(
      'ML input contains NaN or Infinity'
    );
  }

  if (
    input.entryPrice <= 0 ||
    input.ema20 <= 0 ||
    input.ema50 <= 0 ||
    input.ema200 <= 0
  ) {
    throw new Error(
      'ML input contains invalid EMA or entry price'
    );
  }

  if (
    input.lastAtr < 0 ||
    input.atrPct < 0
  ) {
    throw new Error(
      'ML input contains invalid ATR values'
    );
  }

  if (
    !input.openedAt ||
    typeof input.openedAt !== 'string'
  ) {
    throw new Error(
      'ML input requires openedAt'
    );
  }

  const openedAtMs = Date.parse(
    input.openedAt
  );

  if (!Number.isFinite(openedAtMs)) {
    throw new Error(
      `Invalid openedAt: ${input.openedAt}`
    );
  }

  if (
    input.side !== 'long' &&
    input.side !== 'short'
  ) {
    throw new Error(
      `Invalid ML side: ${input.side}`
    );
  }
}


// ==================== PREDICTION PARSING ====================

function parsePrediction(
  stdout: string
): MlPredictionResult {
  const output = stdout.trim();

  if (!output) {
    throw new Error(
      'Prediction process returned empty stdout'
    );
  }

  let parsed: PredictionJson;

  try {
    parsed = JSON.parse(
      output
    ) as PredictionJson;
  } catch {
    throw new Error(
      `Invalid JSON from prediction process: ${output}`
    );
  }

  if (parsed.error) {
    throw new Error(
      String(parsed.error)
    );
  }

  if (
    typeof parsed.probability !== 'number' ||
    !Number.isFinite(parsed.probability)
  ) {
    throw new Error(
      `Invalid probability from ML: ${output}`
    );
  }

  if (
    parsed.probability < 0 ||
    parsed.probability > 1
  ) {
    throw new Error(
      `Probability outside [0, 1]: ${output}`
    );
  }

  if (
    typeof parsed.threshold !== 'number' ||
    !Number.isFinite(parsed.threshold)
  ) {
    throw new Error(
      `Invalid threshold from ML: ${output}`
    );
  }

  if (
    parsed.threshold < 0 ||
    parsed.threshold > 1
  ) {
    throw new Error(
      `Threshold outside [0, 1]: ${output}`
    );
  }

  if (
    typeof parsed.passed !== 'boolean'
  ) {
    throw new Error(
      `Invalid passed value from ML: ${output}`
    );
  }

  return {
    probability: parsed.probability,
    threshold: parsed.threshold,
    passed: parsed.passed,

    trainedAt:
      typeof parsed.trained_at === 'string'
        ? parsed.trained_at
        : null,

    trainingRows:
      typeof parsed.training_rows === 'number' &&
      Number.isFinite(parsed.training_rows)
        ? parsed.training_rows
        : null
  };
}


// ==================== MODEL INFO ====================

export function isModelAvailable(): boolean {
  return existsSync(MODEL_FILE);
}


export function getModelInfo(): MlModelInfo {
  if (!isModelAvailable()) {
    return {
      available: false,
      trainedAt: null,
      trainingRows: null,
      profitRows: null,
      lossRows: null
    };
  }

  if (!existsSync(MODEL_META_FILE)) {
    return {
      available: true,
      trainedAt: null,
      trainingRows: null,
      profitRows: null,
      lossRows: null
    };
  }

  try {
    const metadataText = readFileSync(
      MODEL_META_FILE,
      'utf8'
    );

    const metadata = JSON.parse(
      metadataText
    ) as ModelMetadataJson;

    const profitRows =
      typeof metadata.profit_rows === 'number'
        ? metadata.profit_rows
        : typeof metadata.tp_rows === 'number'
          ? metadata.tp_rows
          : null;

    const lossRows =
      typeof metadata.loss_rows === 'number'
        ? metadata.loss_rows
        : typeof metadata.sl_rows === 'number'
          ? metadata.sl_rows
          : null;

    return {
      available: true,

      trainedAt:
        typeof metadata.trained_at === 'string'
          ? metadata.trained_at
          : null,

      trainingRows:
        typeof metadata.training_rows === 'number' &&
        Number.isFinite(metadata.training_rows)
          ? metadata.training_rows
          : null,

      profitRows,
      lossRows
    };
  } catch {
    return {
      available: true,
      trainedAt: null,
      trainingRows: null,
      profitRows: null,
      lossRows: null
    };
  }
}


// ==================== TRAINING ====================

export async function trainModel(): Promise<void> {
  ensureMlFilesExist();

  const child = spawn(
    PYTHON_BIN,
    [TRAIN_SCRIPT],
    {
      cwd: ML_DIR,

      stdio: [
        'ignore',
        'pipe',
        'pipe'
      ],

      windowsHide: true,

      env: {
        ...process.env,
        ML_DIR
      }
    }
  );

  const result = await collectProcessOutput(
    child,
    TRAIN_TIMEOUT_MS
  );

  if (result.code !== 0) {
    throw new Error(
      'ML training failed. ' +
      `Exit code: ${result.code}. ` +
      `stderr: ${result.stderr || 'empty'}`
    );
  }

  if (!isModelAvailable()) {
    throw new Error(
      'Training finished, but model was not created: ' +
      MODEL_FILE
    );
  }

  console.log(
    '[ML] Training completed:\n' +
    result.stdout
  );

  if (result.stderr.trim()) {
    console.warn(
      '[ML] Training stderr:\n' +
      result.stderr
    );
  }
}


// ==================== PREDICTION ====================

export async function predictTrade(
  input: MlPredictionInput
): Promise<MlPredictionResult> {
  ensureMlFilesExist();
  ensureFiniteInput(input);

  if (!isModelAvailable()) {
    throw new Error(
      `ML model not found: ${MODEL_FILE}`
    );
  }

  const child = spawn(
    PYTHON_BIN,
    [PREDICT_SCRIPT],
    {
      cwd: ML_DIR,

      stdio: [
        'pipe',
        'pipe',
        'pipe'
      ],

      windowsHide: true,

      env: {
        ...process.env,
        ML_DIR
      }
    }
  );

  const inputJson = JSON.stringify(
    input
  );

  child.stdin?.write(
    inputJson,
    'utf8'
  );

  child.stdin?.end();

  const result = await collectProcessOutput(
    child,
    ML_TIMEOUT_MS
  );

  if (result.code !== 0) {
    throw new Error(
      'ML prediction failed. ' +
      `Exit code: ${result.code}. ` +
      `stderr: ${result.stderr || result.stdout}`
    );
  }

  return parsePrediction(
    result.stdout
  );
}
