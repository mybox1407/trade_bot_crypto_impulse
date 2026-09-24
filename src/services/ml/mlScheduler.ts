import { existsSync } from 'node:fs';
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

let trainingInProgress = false;
let schedulerStarted = false;

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
  while (true) {
    await sleep(DAY_MS);

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

  void trainingLoop();
}
