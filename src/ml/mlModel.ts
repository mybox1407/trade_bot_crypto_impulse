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
};

const PYTHON_BIN =
  process.env.PYTHON_BIN ?? 'python';

const PROJECT_ROOT = path.resolve(
  process.cwd()
);

const PREDICT_SCRIPT = path.join(
  PROJECT_ROOT,
  'ml',
  'predict_model.py'
);

const ML_TIMEOUT_MS = 10_000;

function parsePrediction(
  stdout: string,
): MlPredictionResult {
  const parsed = JSON.parse(
    stdout.trim()
  ) as Partial<MlPredictionResult> & {
    error?: string;
  };

  if (parsed.error) {
    throw new Error(parsed.error);
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
  };
}

export function predictTrade(
  input: MlPredictionInput,
): Promise<MlPredictionResult> {
  return new Promise(
    (resolve, reject) => {
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

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finishError = (
        error: Error,
      ): void => {
        if (settled) return;

        settled = true;
        reject(error);
      };

      const finishSuccess = (
        result: MlPredictionResult,
      ): void => {
        if (settled) return;

        settled = true;
        resolve(result);
      };

      const timeout = setTimeout(() => {
        child.kill();

        finishError(
          new Error(
            `ML prediction timeout after ${ML_TIMEOUT_MS} ms`
          ),
        );
      }, ML_TIMEOUT_MS);

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
          finishError(error);
        },
      );

      child.once(
        'close',
        (code: number | null) => {
          clearTimeout(timeout);

          if (settled) return;

          if (code !== 0) {
            finishError(
              new Error(
                `ML process failed. ` +
                `Code=${code}. ` +
                `stderr=${stderr}`
              ),
            );
            return;
          }

          try {
            const result = parsePrediction(
              stdout
            );

            finishSuccess(result);
          } catch (error) {
            finishError(
              error instanceof Error
                ? error
                : new Error(String(error)),
            );
          }
        },
      );

      child.stdin.write(
        JSON.stringify(input)
      );

      child.stdin.end();
    },
  );
}
