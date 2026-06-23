// @kgpacks/backend — article-summary helper.
//
// Batch-fetches the lead section (`section_index: 0`) content for a set of
// articles and truncates it to a ~200-char summary, matching the reference
// `services/summary_utils.get_article_summaries`. A single query avoids the N+1
// problem; articles with no lead content are omitted.

import type { Connection, Row } from '@kgpacks/db';

import { toText } from '../util.js';

const SUMMARY_MAX_CHARS = 200;

/** Maps each article title to its truncated lead-section summary. */
export async function getArticleSummaries(
  conn: Connection,
  titles: string[],
): Promise<Map<string, string>> {
  const summaries = new Map<string, string>();
  if (titles.length === 0) return summaries;

  const rows = await conn.run<Row>(
    `MATCH (a:Article)-[:HAS_SECTION {section_index: 0}]->(s:Section)
     WHERE a.title IN $titles
     RETURN a.title AS title, s.content AS content`,
    { titles },
  );

  for (const row of rows) {
    const title = toText(row.title);
    const content = toText(row.content);
    if (content.length > 0 && !summaries.has(title)) {
      summaries.set(
        title,
        content.length > SUMMARY_MAX_CHARS ? `${content.slice(0, SUMMARY_MAX_CHARS)}...` : content,
      );
    }
  }

  return summaries;
}
