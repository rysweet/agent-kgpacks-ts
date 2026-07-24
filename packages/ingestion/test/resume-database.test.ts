import { describe, expect, it, vi } from 'vitest';

interface ResumeConnection {
  loadExtension(name: string): Promise<void>;
  run(statement: string): Promise<unknown[]>;
}

interface ResumeDatabaseModule {
  normalizeResumedDatabase(connection: ResumeConnection): Promise<void>;
}

const SHOW_INDEXES = 'CALL SHOW_INDEXES() RETURN table_name AS tableName, index_name AS indexName';
const GENERATED_ROWS = [
  [
    'MATCH ()-[r:ENTITY_RELATION]->() RETURN r LIMIT 1',
    'MATCH ()-[r:ENTITY_RELATION]->() DELETE r',
  ],
  ['MATCH ()-[r:LINKS_TO]->() RETURN r LIMIT 1', 'MATCH ()-[r:LINKS_TO]->() DELETE r'],
  ['MATCH (n:UpdateApplication) RETURN n LIMIT 1', 'MATCH (n:UpdateApplication) DELETE n'],
  ['MATCH (n:PackMetadata) RETURN n LIMIT 1', 'MATCH (n:PackMetadata) DELETE n'],
] as const;

async function loadSubject(): Promise<ResumeDatabaseModule> {
  try {
    return await vi.importActual<ResumeDatabaseModule>('../src/resume-database.js');
  } catch (error) {
    expect(error, 'resume normalization must be implemented by resume-database.ts').toBeUndefined();
    throw error;
  }
}

describe('normalizeResumedDatabase', () => {
  it('normalizes only the exact generated-index and generated-row allowlists', async () => {
    const { normalizeResumedDatabase } = await loadSubject();
    const loadExtension = vi.fn(async () => {});
    const run = vi.fn(async (statement: string): Promise<unknown[]> => {
      if (statement === SHOW_INDEXES) {
        return [
          { tableName: 'Section', indexName: 'embedding_idx' },
          { tableName: 'Chunk', indexName: 'chunk_embedding_idx' },
          { tableName: 'Section', indexName: 'operator_index' },
          { tableName: 'Audit', indexName: 'embedding_idx' },
        ];
      }
      if (GENERATED_ROWS.some(([inspection]) => inspection === statement)) return [{}];
      return [];
    });

    await normalizeResumedDatabase({ loadExtension, run });

    expect(loadExtension).toHaveBeenCalledExactlyOnceWith('vector');
    expect(run.mock.calls.map(([statement]) => statement)).toEqual([
      SHOW_INDEXES,
      "CALL DROP_VECTOR_INDEX('Section', 'embedding_idx')",
      "CALL DROP_VECTOR_INDEX('Chunk', 'chunk_embedding_idx')",
      ...GENERATED_ROWS.flatMap(([inspection, deletion]) => [inspection, deletion]),
    ]);
  });

  it('leaves unrelated indexes and absent generated rows untouched', async () => {
    const { normalizeResumedDatabase } = await loadSubject();
    const run = vi.fn(async (statement: string): Promise<unknown[]> => {
      if (statement === SHOW_INDEXES) {
        return [
          { tableName: 'Section', indexName: 'operator_index' },
          { tableName: 'Audit', indexName: 'embedding_idx' },
        ];
      }
      return [];
    });

    await normalizeResumedDatabase({ loadExtension: vi.fn(async () => {}), run });

    expect(run.mock.calls.map(([statement]) => statement)).toEqual([
      SHOW_INDEXES,
      ...GENERATED_ROWS.map(([inspection]) => inspection),
    ]);
  });

  it.each([
    ['extension load', 'load'],
    ['index inspection', SHOW_INDEXES],
    ['allowlisted index drop', "CALL DROP_VECTOR_INDEX('Section', 'embedding_idx')"],
    ['generated-row inspection', GENERATED_ROWS[0][0]],
    ['generated-row deletion', GENERATED_ROWS[0][1]],
  ])('propagates the original %s failure', async (_label, failingStep) => {
    const { normalizeResumedDatabase } = await loadSubject();
    const failure = new Error(`failed at ${failingStep}`);
    const connection: ResumeConnection = {
      async loadExtension() {
        if (failingStep === 'load') throw failure;
      },
      async run(statement) {
        if (statement === failingStep) throw failure;
        if (statement === SHOW_INDEXES) {
          return [{ tableName: 'Section', indexName: 'embedding_idx' }];
        }
        if (statement === GENERATED_ROWS[0][0]) return [{}];
        return [];
      },
    };

    await expect(normalizeResumedDatabase(connection)).rejects.toBe(failure);
  });
});
