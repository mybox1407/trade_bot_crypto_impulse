import { spawn } from 'node:child_process';
import path from 'node:path';

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
  hourUtc: number;
};

export type MlPredictionResult = {
  probability: number;
  threshold: number;
  passed: boolean;
  trainedAt: string | null;
  trainingRows: number | null;
};

const PYTHON_BIN =
  process.env.PYTHON_BIN ?? 'python';

const PROJECT_ROOT = path.resolve(
  process.cwd()
);

const TRAIN_SCRIPT = path.join(
  PROJECT_ROOT,
  'ml',
  'train_model.py'
);

const PREDICT_SCRIPT = path.join(
  PROJECT_ROOT,
  'ml',
  'predict_model.py'
);

const ML_TIMEOUT_MS = 10_000;
const TRAIN_TIMEOUT_MS = 30 * 60 * 1000;

function collectProcessOutput(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise(
    (resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;

      const timeout = setTimeout(() => {
        child.kill();

        if (settled) return;

        settled = true;

        reject(
          new Error(
            `Python process timeout after ${timeoutMs} ms`
          )
        );
      }, timeoutMs);

      child.stdout.on(
        'data',
        (chunk: Buffer) => {
          stdout += chunk.toString();
        },
      );

      child.stderr.on(
        'data',
        (chunk: Buffer) => {
          stderr += chunk.toString();
        },
      );

      child.once(
        'error',
        (error: Error) => {
          clearTimeout(timeout);

          if (settled) return;

          settled = true;
          reject(error);
        },
      );

      child.once(
        'close',
        (code: number | null) => {
          clearTimeout(timeout);

          if (settled) return;

          settled = true;

          resolve({
            code,
            stdout,
            stderr,
          });
        },
      );
    },
  );
}

export async function trainModel(): Promise<void> {
  const child = spawn(
    PYTHON_BIN,
    [TRAIN_SCRIPT],
    {
      cwd: PROJECT_ROOT,
      stdio: [
        'ignore',
        'pipe',
        'pipe',
      ],
      windowsHide: true,
    },
  );

  const result = await collectProcessOutput(
    child,
    TRAIN_TIMEOUT_MS,
  );

  if (result.code !== 0) {
    throw new Error(
      `ML training failed. ` +
      `Code=${result.code}. ` +
      `stderr=${result.stderr}`
    );
  }

  console.log(
    '[ML] Training completed:\n' +
    result.stdout
  );
}

function parsePrediction(
  stdout: string,
): MlPredictionResult {
  const parsed = JSON.parse(
    stdout.trim()
  ) as {
    probability?: unknown;
    threshold?: unknown;
    passed?: unknown;
    trained_at?: unknown;
    training_rows?: unknown;
    error?: unknown;
  };

  if (parsed.error) {
    throw new Error(
      String(parsed.error)
    );
  }

  if (
    typeof parsed.probability !== 'number' ||
    typeof parsed.threshold !== 'number' ||
    typeof parsed.passed !== 'boolean'
  ) {
    throw new Error(
      `Invalid ML response: ${stdout}`
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
      typeof parsed.training_rows === 'number'
        ? parsed.training_rows
        : null,
  };
}

export async function predictTrade(
  input: MlPredictionInput,
): Promise<MlPredictionResult> {
  const child = spawn(
    PYTHON_BIN,
    [PREDICT_SCRIPT],
    {
      cwd: PROJECT_ROOT,
      stdio: [
        'pipe',
        'pipe',
        'pipe',
      ],
      windowsHide: true,
    },
  );

  child.stdin.write(
    JSON.stringify(input)
  );

  child.stdin.end();

  const result = await collectProcessOutput(
    child,
    ML_TIMEOUT_MS,
  );

  if (result.code !== 0) {
    throw new Error(
      `ML prediction failed. ` +
      `Code=${result.code}. ` +
      `stderr=${result.stderr}`
    );
  }

  return parsePrediction(
    result.stdout
  );
}
