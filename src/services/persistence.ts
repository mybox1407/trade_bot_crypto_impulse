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
}

function getStateFilePath(): string {
  return DEFAULT_STATE_FILE;
}

export async function saveOpenPositions(
  positions: VirtualPosition[]
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
    )
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

export async function loadOpenPositions(): Promise<
  VirtualPosition[]
> {
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

    return parsed.positions;
  } catch (error) {
    const code =
      error as NodeJS.ErrnoException;

    if (code.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

export async function clearOpenPositions(): Promise<void> {
  await saveOpenPositions([]);
}
