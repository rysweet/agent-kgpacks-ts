interface ResumeDatabaseConnection {
  loadExtension(name: string): Promise<void>;
  run<T extends Record<string, unknown> = Record<string, unknown>>(statement: string): Promise<T[]>;
}

const GENERATED_VECTOR_INDEXES = new Set(['Section.embedding_idx', 'Chunk.chunk_embedding_idx']);

const GENERATED_ROW_CLEANUP = [
  [
    'MATCH ()-[r:ENTITY_RELATION]->() RETURN r LIMIT 1',
    'MATCH ()-[r:ENTITY_RELATION]->() DELETE r',
  ],
  ['MATCH ()-[r:LINKS_TO]->() RETURN r LIMIT 1', 'MATCH ()-[r:LINKS_TO]->() DELETE r'],
  ['MATCH (n:UpdateApplication) RETURN n LIMIT 1', 'MATCH (n:UpdateApplication) DELETE n'],
  ['MATCH (n:PackMetadata) RETURN n LIMIT 1', 'MATCH (n:PackMetadata) DELETE n'],
] as const;

export async function normalizeResumedDatabase(
  connection: ResumeDatabaseConnection,
): Promise<void> {
  await connection.loadExtension('vector');
  const indexes = await connection.run<{ tableName: string; indexName: string }>(
    'CALL SHOW_INDEXES() RETURN table_name AS tableName, index_name AS indexName',
  );
  for (const { tableName, indexName } of indexes) {
    if (GENERATED_VECTOR_INDEXES.has(`${tableName}.${indexName}`)) {
      await connection.run(`CALL DROP_VECTOR_INDEX('${tableName}', '${indexName}')`);
    }
  }
  for (const [inspection, deletion] of GENERATED_ROW_CLEANUP) {
    if ((await connection.run(inspection)).length > 0) await connection.run(deletion);
  }
}
