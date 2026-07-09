// @kgpacks/query — lexical retrieval.
//
// Exact / substring lookup over the structured `Section` columns a v2 pack
// carries (aliases, purls, cpes, affected_products, cve_id, ecosystems). This is
// the durable counterpart to the semantic path for the load-bearing case the
// vector encoder is weakest at: an EXACT coordinate — an import path like
// `code.gitea.io/gitea`, a purl, or a CPE — that a consumer already knows and
// wants matched verbatim.
//
// Scoring is deterministic and bounded to `[0, 1]`: the fraction of distinct
// query terms that hit any structured field, with a full-query phrase match
// (the whole normalized query found in a field) pinned to `1`. The retriever
// unions these hits with vector hits, keeping the higher score per id.
//
// A v1 pack has none of these columns; rather than silently return nothing, the
// path probes for a structured column up front and fails fast with a clear hint.

import type { Connection, Row } from '@kgpacks/db';

import {
  LEXICAL_FIELDS,
  LEXICAL_MAX_TERMS,
  LEXICAL_MIN_TERM_LENGTH,
  LEXICAL_ROW_CAP,
} from './constants.js';
import { QueryError } from './errors.js';
import { clamp01, coerceContent, toIdString } from './row.js';
import type { RetrieverResult } from './types.js';
import type { VectorConfig } from './vector.js';

/** WHERE fragment matching `$term` (case-insensitively) across the structured fields. */
function fieldMatchClause(alias: string): string {
  return LEXICAL_FIELDS.map((f) => `lower(${alias}.${f}) CONTAINS lower($term)`).join(' OR ');
}

/**
 * Splits a query into distinct lower-cased lexical terms. Import paths, purls and
 * CPEs are delimited by `/`, `@`, `:`, `;`, `,` and whitespace, so a query like
 * `code.gitea.io/gitea` yields both the host token and `gitea`. The full
 * normalized query is appended as a phrase term (exact-match signal).
 */
export function lexicalTerms(query: string): string[] {
  const tokens = query
    .split(/[\s/@:;,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= LEXICAL_MIN_TERM_LENGTH);
  const phrase = query.trim().toLowerCase();
  const terms = phrase.length >= LEXICAL_MIN_TERM_LENGTH ? [phrase, ...tokens] : tokens;
  return [...new Set(terms)].slice(0, LEXICAL_MAX_TERMS);
}

/**
 * Confirms the pack carries the v2 structured columns; a v1 pack throws a binder
 * error on the probe, which we translate into an actionable {@link QueryError}.
 */
async function assertStructuredIndex(conn: Connection, nodeTable: string): Promise<void> {
  try {
    await conn.run<Row>(`MATCH (s:${nodeTable}) RETURN s.${LEXICAL_FIELDS[0]} AS probe LIMIT 1`);
  } catch (cause) {
    throw new QueryError(
      'lexical mode requires a pack with the structured index (v2); this pack predates it. ' +
        'Rebuild / re-pull the pack, or query with --mode hybrid.',
      { cause },
    );
  }
}

/**
 * Lexical retrieval: fraction-of-terms-matched ranking over the structured
 * `Section` fields. Accumulates, per section, how many distinct query terms hit
 * any field; the score is that count over the total term count, clamped to
 * `[0, 1]`. An exact full-query match therefore dominates weaker partial hits.
 */
export async function lexicalRetrieve(
  conn: Connection,
  query: string,
  k: number,
  config: VectorConfig,
): Promise<RetrieverResult[]> {
  const terms = lexicalTerms(query);
  if (terms.length === 0) return [];

  await assertStructuredIndex(conn, config.nodeTable);

  const matchedTerms = new Map<string, number>();
  const content = new Map<string, string>();
  const clause = fieldMatchClause('s');

  for (const term of terms) {
    const rows = await conn.run<Row>(
      `MATCH (s:${config.nodeTable}) WHERE ${clause}
       RETURN s.id AS id, s.content AS content
       LIMIT $limit`,
      { term, limit: LEXICAL_ROW_CAP },
    );
    for (const row of rows) {
      const id = toIdString(row.id);
      matchedTerms.set(id, (matchedTerms.get(id) ?? 0) + 1);
      if (!content.has(id)) content.set(id, coerceContent(row.content));
    }
  }

  return [...matchedTerms.entries()]
    .map(([id, hits]) => ({
      id,
      score: clamp01(hits / terms.length),
      content: content.get(id) ?? '',
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
