// @kgpacks/backend — chat service.
//
// The one endpoint that uses the higher-level stack: `@kgpacks/query` for vector
// retrieval and an injected `@kgpacks/agent` for answer synthesis. Retrieval runs
// over the same `Section` / `embedding_idx` vector index as search; retrieved
// section ids are mapped back to their article titles to form `sources`.
//
// `query_type` is a *stable* label (`"vector_search"`) rather than the reference
// service's dynamic LLM-classified value — the frontend renders it as opaque text
// and does not branch on it (see docs/packages/backend.md).

import type { SynthesisRequest, SynthesisResult } from '@kgpacks/agent';
import type { Connection, Row } from '@kgpacks/db';
import { createRetriever, type Embedder } from '@kgpacks/query';

import { toText } from '../util.js';

/** Stable query-type label emitted by the TS chat pipeline. */
export const QUERY_TYPE = 'vector_search';

const NODE_TABLE = 'Section';
const VECTOR_INDEX = 'embedding_idx';

/** Minimal structural contract for the synthesis agent (CopilotAgent satisfies it). */
export interface ChatAgent {
  synthesizeAnswer(request: SynthesisRequest): Promise<SynthesisResult>;
}

export interface ChatDeps {
  agent: ChatAgent;
  embedder: Embedder;
}

export interface ChatRequestParams {
  question: string;
  maxResults: number;
}

export interface ChatOutcome {
  answer: string;
  sources: string[];
  query_type: string;
}

/**
 * Runs the chat pipeline against an open connection: vector-retrieve context,
 * synthesize an answer, and collect the de-duplicated article-title sources in
 * retrieval order. Throws on synthesis failure (the route maps it to
 * `500 AGENT_ERROR`).
 */
export async function runChat(
  conn: Connection,
  deps: ChatDeps,
  params: ChatRequestParams,
): Promise<ChatOutcome> {
  const retriever = createRetriever(conn, {
    embedder: deps.embedder,
    nodeTable: NODE_TABLE,
    vectorIndex: VECTOR_INDEX,
  });
  const hits = await retriever.retrieve(params.question, { k: params.maxResults });

  const titleBySection = await mapSectionsToArticles(
    conn,
    hits.map((hit) => hit.id),
  );

  const context = hits.map((hit) => ({
    id: hit.id,
    text: hit.content,
    title: titleBySection.get(hit.id),
  }));

  const sources: string[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const title = titleBySection.get(hit.id);
    if (title !== undefined && !seen.has(title)) {
      seen.add(title);
      sources.push(title);
    }
  }

  const synthesis = await deps.agent.synthesizeAnswer({ question: params.question, context });
  const answer = synthesis.answer.trim().length > 0 ? synthesis.answer : 'No answer generated.';

  return { answer, sources, query_type: QUERY_TYPE };
}

/** Maps retrieved `Section.id` values to their owning `Article.title`. */
async function mapSectionsToArticles(
  conn: Connection,
  sectionIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (sectionIds.length === 0) return map;
  const rows = await conn.run<Row>(
    `MATCH (a:Article)-[:HAS_SECTION]->(s:Section)
     WHERE s.id IN $ids
     RETURN s.id AS id, a.title AS title`,
    { ids: sectionIds },
  );
  for (const row of rows) {
    map.set(toText(row.id), toText(row.title));
  }
  return map;
}
