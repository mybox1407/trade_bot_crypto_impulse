import {
  existsSync,
  readFileSync
} from 'node:fs';

import path from 'node:path';

import {
  trainModel,
  isModelAvailable as isModelFileAvailable
} from './mlModel';

const DAY_MS =
  24 * 60 * 60 * 1000;

const ML_DIR = path.resolve(
  process.env.ML_DIR ??
    path.join(process.cwd(), 'ml')
);

const MODEL_FILE = path.join(
  ML_DIR,
  'trade_model.joblib'
);

const MODEL_META_FILE = path.join(
  ML_DIR,
  'trade_model_meta.json'
);

let trainingInProgress = false;
let schedulerStarted = false;
let trainingLoopPromise: Promise<void> | null = null;

export type MlModelInfo = {
  available: boolean;
  trainedAt: string | null;
  trainingRows: number | null;
  tpRows: number | null;
  slRows: number | null;
};

function sleep(
  milliseconds: number
): Promise<void> {
  return new Promise(resolve => {
    setTimeout(
      resolve,
      milliseconds
    );
  });
}

export function isModelAvailable(): boolean {
  return (
    existsSync(MODEL_FILE) &&
    isModelFileAvailable()
  );
}

export function getModelInfo(): MlModelInfo {
  if (!isModelAvailable()) {
    return {
      available: false,
      trainedAt: null,
      trainingRows: null,
      tpRows: null,
      slRows: null
    };
  }

  if (!existsSync(MODEL_META_FILE)) {
    return {
      available: true,
      trainedAt: null,
      trainingRows: null,
      tpRows: null,
      slRows: null
    };
  }

  try {
    const raw = readFileSync(
      MODEL_META_FILE,
      'utf8'
    );

    const parsed = JSON.parse(raw) as {
      trained_at?: unknown;
      training_rows?: unknown;
      tp_rows?: unknown;
      sl_rows?: unknown;
    };

    return {
      available: true,
      trainedAt:
        typeof parsed.trained_at === 'string'
          ? parsed.trained_at
          : null,
      trainingRows:
        typeof parsed.training_rows === 'number'
          ? parsed.training_rows
          : null,
      tpRows:
        typeof parsed.tp_rows === 'number'
          ? parsed.tp_rows
          : null,
      slRows:
        typeof parsed.sl_rows === 'number'
          ? parsed.sl_rows
          : null
    };
  } catch (error) {
    console.warn(
      '[ML] Failed to read model metadata:',
      error
    );

    return {
      available: true,
      trainedAt: null,
      trainingRows: null,
      tpRows: null,
      slRows: null
    };
  }
}

export async function retrainModel(
  reason: string
): Promise<boolean> {
  if (trainingInProgress) {
    console.warn(
      `[ML] Training already in progress. ` +
      `Skip request: ${reason}`
    );

    return false;
  }

  trainingInProgress = true;

  console.log(
    `[ML] Training started. Reason: ${reason}`
  );

  try {
    await trainModel();

    if (!isModelAvailable()) {
      throw new Error(
        `Model was not created: ${MODEL_FILE}`
      );
    }

    console.log(
      '[ML] Training completed successfully.'
    );

    const info = getModelInfo();

    console.log(
      '[ML] Model metadata:',
      JSON.stringify(info)
    );

    return true;
  } catch (error) {
    console.error(
      '[ML] Training failed. ' +
      'The previous model remains active.',
      error
    );

    return false;
  } finally {
    trainingInProgress = false;
  }
}

async function trainingLoop(): Promise<void> {
  while (schedulerStarted) {
    await sleep(DAY_MS);

    if (!schedulerStarted) {
      break;
    }

    await retrainModel(
      'scheduled daily retraining'
    );
  }
}

export async function startModelTrainingScheduler(): Promise<void> {
  if (schedulerStarted) {
    console.warn(
      '[ML] Training scheduler already started.'
    );

    return;
  }

  schedulerStarted = true;

  const initialTrainingSucceeded =
    await retrainModel(
      'bot startup'
    );

  if (!initialTrainingSucceeded) {
    console.warn(
      '[ML] Initial training failed. ' +
      'Existing model will be used if available.'
    );
  }

  trainingLoopPromise = trainingLoop();
  void trainingLoopPromise;
}

export async function stopModelTrainingScheduler(): Promise<void> {
  schedulerStarted = false;
  trainingLoopPromise = null;
}
