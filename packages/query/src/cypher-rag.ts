// @kgpacks/query — Cypher-RAG stage (ENHANCEMENTS).
//
// Asks a generator for a Cypher query, runs it through the CORE `validateCypher`
// allow-list FAIL-CLOSED, executes the validated query, and maps the rows into
// `RetrieverResult[]`. The generator's output is UNTRUSTED input: a non-read-only,
// write/DDL, or variable-length-path query is rejected with `CypherValidationError`
// and never reaches the database. It augments — never replaces — the safe vector
// path.

import type { Connection, Row } from '@kgpacks/db';
import { stripMarkdownFences } from '@kgpacks/agent';

import { CYPHER_RAG_SCORE } from './constants.js';
import { validateCypher } from './cypher-safety.js';
import { coerceContent, toIdString } from './row.js';
import type { CypherGenerator, RetrieverResult, SynthesisAgent } from './types.js';

/** Instruction prompting a synthesis agent for a single read-only Cypher query. */
function buildCypherPrompt(question: string): string {
  return [
    'You translate a natural-language question into ONE read-only Cypher query',
    'over a knowledge graph of `Section` nodes connected by `LINKS_TO` edges.',
    'The query MUST start with MATCH or CALL, MUST NOT contain any write or schema',
    'keyword (CREATE, DELETE, DROP, SET, MERGE, REMOVE, DETACH), and MUST NOT use a',
    'variable-length path. Return ONLY the Cypher statement — no prose, no fences.',
    '',
    'Question:',
    question,
  ].join('\n');
}

/**
 * Adapts a synthesis-only agent into a {@link CypherGenerator} by prompting it for
 * a single read-only Cypher statement and unwrapping any surrounding Markdown code
 * fence. A `CopilotAgent` has no Cypher operation of its own, so this is how
 * Cypher-RAG drives it.
 */
export function cypherGeneratorFromAgent(agent: SynthesisAgent): CypherGenerator {
  return {
    async generateCypher(question: string): Promise<string> {
      const result = await agent.synthesizeAnswer({
        question: buildCypherPrompt(question),
        context: [],
      });
      return stripMarkdownFences(result.answer);
    },
  };
}

/**
 * Runs the Cypher-RAG stage (each step fails closed):
 *
 *  1. `cypher = await generator.generateCypher(query)`.
 *  2. `validateCypher(cypher)` — throws `CypherValidationError` before any DB
 *     access if the query is not a read-only `MATCH`/`CALL`, contains a write/DDL
 *     keyword, or uses a variable-length path.
 *  3. `conn.run(cypher)` — the validated query is executed as-is.
 *  4. Rows are mapped to `RetrieverResult` (`id`, `content`, a fixed Cypher-RAG
 *     score), optionally truncated to `opts.k`.
 */
export async function cypherRagRetrieve(
  conn: Connection,
  generator: CypherGenerator,
  query: string,
  opts: { k?: number; nodeTable?: string } = {},
): Promise<RetrieverResult[]> {
  const cypher = await generator.generateCypher(query);
  validateCypher(cypher);

  const rows = await conn.run<Row>(cypher);
  const mapped = rows.map((row) => ({
    id: toIdString(row.id),
    score: CYPHER_RAG_SCORE,
    content: coerceContent(row.content),
  }));

  return opts.k === undefined ? mapped : mapped.slice(0, opts.k);
}
