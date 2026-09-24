import {
  trainModel
} from './mlModel';

const DAY_MS =
  24 * 60 * 60 * 1000;

let trainingInProgress = false;
let schedulerStarted = false;

function sleep(
  milliseconds: number,
): Promise<void> {
  return new Promise(
    resolve => {
      setTimeout(
        resolve,
        milliseconds
      );
    }
  );
}

export async function retrainModel(
  reason: string,
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

    console.log(
      '[ML] Training finished successfully.'
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
      'Trading should remain disabled until ' +
      'a valid model is available.'
    );
  }

  void trainingLoop();
}
