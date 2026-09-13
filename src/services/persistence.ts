import {
  mkdir,
  readFile,
  rename,
  writeFile
} from 'node:fs/promises';

import {
  dirname
} from 'node:path';

import {
  VirtualPosition
} from './positionState';

const DEFAULT_STATE_FILE =
  process.env.POSITIONS_STATE_FILE ??
  'runtime/open-positions.json';

export interface PersistedPositionState {
  version: 1;
  updatedAt: string;
  positions: VirtualPosition[];
  reconciliationPendingSymbols?: string[];
}

function getStateFilePath(): string {
  return DEFAULT_STATE_FILE;
}

export async function saveOpenPositions(
  positions: VirtualPosition[],
  reconciliationPendingSymbols?: string[]
): Promise<void> {
  const filePath =
    getStateFilePath();

  const temporaryPath =
    `${filePath}.tmp`;

  const payload:
    PersistedPositionState = {
    version: 1,
    updatedAt:
      new Date().toISOString(),
    positions: positions.map(
      position => ({
        ...position,
        metadata: position.metadata
          ? {
              ...position.metadata
            }
          : undefined
      })
    ),
    reconciliationPendingSymbols: reconciliationPendingSymbols
      ? [...reconciliationPendingSymbols]
      : undefined
  };

  await mkdir(
    dirname(filePath),
    {
      recursive: true
    }
  );

  await writeFile(
    temporaryPath,
    JSON.stringify(
      payload,
      null,
      2
    ),
    'utf8'
  );

  await rename(
    temporaryPath,
    filePath
  );
}

export async function loadOpenPositions(): Promise<{
  positions: VirtualPosition[];
  reconciliationPendingSymbols: string[];
}> {
  const filePath =
    getStateFilePath();

  try {
    const content =
      await readFile(
        filePath,
        'utf8'
      );

    const parsed =
      JSON.parse(
        content
      ) as Partial<
        PersistedPositionState
      >;

    if (
      parsed.version !== 1 ||
      !Array.isArray(
        parsed.positions
      )
    ) {
      throw new Error(
        'Invalid persisted position state format'
      );
    }

    return {
      positions: parsed.positions,
      reconciliationPendingSymbols: Array.isArray(parsed.reconciliationPendingSymbols)
        ? parsed.reconciliationPendingSymbols
        : []
    };
  } catch (error) {
    const code =
      error as NodeJS.ErrnoException;

    if (code.code === 'ENOENT') {
      return {
        positions: [],
        reconciliationPendingSymbols: []
      };
    }

    throw error;
  }
}

export async function clearOpenPositions(): Promise<void> {
  await saveOpenPositions([], []);
}
