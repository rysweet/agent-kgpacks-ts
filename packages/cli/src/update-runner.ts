import type { UpdateKnowledgePackConfig, UpdateKnowledgePackResult } from '@kgpacks/ingestion';

export type UpdateKnowledgePackSeam = (
  config: UpdateKnowledgePackConfig,
) => Promise<UpdateKnowledgePackResult>;

/** Lazily loads the write-side update engine so read-only CLI commands stay light. */
export function defaultUpdateKnowledgePack(): UpdateKnowledgePackSeam {
  return async (config) => {
    const { updateKnowledgePack } = await import('@kgpacks/ingestion');
    return updateKnowledgePack(config);
  };
}
