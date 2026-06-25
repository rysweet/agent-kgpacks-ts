// Service-level guard: getStats must work against BOTH the current schema (with
// Article.expansion_depth) and packs built before that column existed. A pre-fix
// pack has Article(title, category, word_count) only; querying expansion_depth on
// it throws a LadybugDB binder exception, which previously 500'd /api/v1/stats for
// every existing pack on disk. getStats now introspects the schema first.

import { afterEach, describe, expect, it } from 'vitest';

import { Database } from '@kgpacks/db';

import { getStats, StatsCache } from '../src/services/article.js';

let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

/** Builds a minimal in-memory pack; includes `expansion_depth` only when asked. */
async function buildMinimalPack(withDepth: boolean): Promise<Database> {
  const database = new Database();
  const conn = database.connect();
  const articleCols = withDepth
    ? 'title STRING, category STRING, word_count INT64, expansion_depth INT64'
    : 'title STRING, category STRING, word_count INT64';
  await conn.run(`CREATE NODE TABLE Article(${articleCols}, PRIMARY KEY(title))`);
  await conn.run('CREATE NODE TABLE Section(id STRING, PRIMARY KEY(id))');
  await conn.run('CREATE REL TABLE HAS_SECTION(FROM Article TO Section)');
  await conn.run('CREATE REL TABLE LINKS_TO(FROM Section TO Section, link_type STRING)');

  if (withDepth) {
    await conn.run(
      "CREATE (:Article {title: 'A', category: 'X', word_count: 10, expansion_depth: 0})",
    );
    await conn.run(
      "CREATE (:Article {title: 'B', category: 'X', word_count: 20, expansion_depth: 1})",
    );
  } else {
    await conn.run("CREATE (:Article {title: 'A', category: 'X', word_count: 10})");
    await conn.run("CREATE (:Article {title: 'B', category: 'X', word_count: 20})");
  }
  await conn.run("CREATE (:Section {id: 'A#0'})");
  await conn.run("CREATE (:Section {id: 'B#0'})");
  return database;
}

describe('getStats — schema-version robustness', () => {
  it('does not 500 on a pack lacking expansion_depth (returns empty by_depth)', async () => {
    db = await buildMinimalPack(false);
    const conn = db.connect();

    const stats = await getStats(conn, ':memory:', new StatsCache());

    expect(stats.articles.total).toBe(2);
    expect(stats.articles.by_category).toEqual({ X: 2 });
    expect(stats.articles.by_depth).toEqual({});
  });

  it('reports by_depth when the column exists', async () => {
    db = await buildMinimalPack(true);
    const conn = db.connect();

    const stats = await getStats(conn, ':memory:', new StatsCache());

    expect(stats.articles.total).toBe(2);
    expect(stats.articles.by_depth).toEqual({ '0': 1, '1': 1 });
  });
});
