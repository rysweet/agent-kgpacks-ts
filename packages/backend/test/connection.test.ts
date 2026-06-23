// packages/backend/test/connection.test.ts
//
// Tests the per-request connection manager and the Spike-A concurrency invariant:
// `withConnection` opens and closes a fresh connection per call, and concurrent
// requests each get their own connection (one in-flight query each), so parallel
// queries against the shared in-memory database all succeed without interference.

import type { Database } from '@kgpacks/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConnectionManager } from '../src/index.js';
import { buildFixtureDatabase } from './fixture.js';

describe('ConnectionManager', () => {
  let database: Database;

  beforeAll(async () => {
    database = await buildFixtureDatabase();
  });
  afterAll(() => {
    database.close();
  });

  it('withConnection runs a query and returns its result', async () => {
    const manager = new ConnectionManager(database);
    const rows = await manager.withConnection((conn) =>
      conn.run<{ total: number | bigint }>('MATCH (a:Article) RETURN count(*) AS total'),
    );
    expect(Number(rows[0].total)).toBe(6);
  });

  it('getConnection yields a usable, vector-capable connection the caller closes', async () => {
    const manager = new ConnectionManager(database);
    const conn = await manager.getConnection();
    try {
      const rows = await conn.run<{ title: string }>(
        'MATCH (a:Article {title: $t}) RETURN a.title AS title',
        { t: 'Quantum entanglement' },
      );
      expect(rows[0].title).toBe('Quantum entanglement');
    } finally {
      conn.close();
    }
  });

  it('serves concurrent requests on independent connections', async () => {
    const manager = new ConnectionManager(database);
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        manager.withConnection((conn) =>
          conn.run<{ total: number | bigint }>('MATCH (a:Article) RETURN count(*) AS total'),
        ),
      ),
    );
    for (const rows of results) {
      expect(Number(rows[0].total)).toBe(6);
    }
  });
});
