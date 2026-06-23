// packages/db/test/database.test.ts
//
// Contract tests for the @kgpacks/db wrapper (Database / Connection).
//
// These specify the public surface documented in docs/packages/db.md:
//   - new Database(path?)            // defaults to ':memory:'
//   - database.connect(): Connection
//   - database.close(): void         // idempotent
//   - connection.run<T>(cypher, params?): Promise<T[]>
//   - connection.close(): void       // idempotent
//
// They run fully OFFLINE: only the core graph engine is exercised (no VECTOR/FTS
// extension, which may require network). The vector path is covered by
// spike-a.test.ts.
//
// TDD: these FAIL today because packages/db/src/index.ts does not yet exist.
// They PASS once the wrapper is implemented over @ladybugdb/core.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../src/index.js';

describe('@kgpacks/db — Database', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(); // in-memory (path defaults to ':memory:')
  });

  afterEach(() => {
    db.close();
  });

  it('opens an in-memory database by default and yields a usable connection', () => {
    const conn = db.connect();
    expect(conn).toBeTruthy();
    expect(typeof conn.run).toBe('function');
    expect(typeof conn.loadExtension).toBe('function');
    expect(typeof conn.close).toBe('function');
    conn.close();
  });

  it('connect() returns a fresh Connection on each call', () => {
    const a = db.connect();
    const b = db.connect();
    expect(a).not.toBe(b);
    a.close();
    b.close();
  });

  it('close() is idempotent — calling it twice does not throw', () => {
    expect(() => {
      db.close();
      db.close();
    }).not.toThrow();
  });
});

describe('@kgpacks/db — Connection.run', () => {
  let db: InstanceType<typeof Database>;
  let conn: ReturnType<InstanceType<typeof Database>['connect']>;

  beforeEach(() => {
    db = new Database();
    conn = db.connect();
  });

  afterEach(() => {
    conn.close();
    db.close();
  });

  it('round-trips nodes and returns rows keyed by RETURN aliases', async () => {
    await conn.run('CREATE NODE TABLE Doc(id INT64, title STRING, PRIMARY KEY(id))');
    await conn.run('CREATE (:Doc {id: 1, title: "alpha"})');
    await conn.run('CREATE (:Doc {id: 2, title: "beta"})');

    const rows = await conn.run<{ id: number | bigint; title: string }>(
      'MATCH (d:Doc) RETURN d.id AS id, d.title AS title ORDER BY d.id',
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.title)).toEqual(['alpha', 'beta']);
    expect(Number(rows[0].id)).toBe(1);
    expect(Number(rows[1].id)).toBe(2);
  });

  it('binds named $params instead of interpolating them into the query text', async () => {
    await conn.run('CREATE NODE TABLE Doc(id INT64, title STRING, PRIMARY KEY(id))');
    await conn.run('CREATE (:Doc {id: $id, title: $title})', { id: 7, title: 'gamma' });

    const rows = await conn.run<{ title: string }>(
      'MATCH (d:Doc) WHERE d.id = $id RETURN d.title AS title',
      { id: 7 },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('gamma');
  });

  it('returns an empty array when a MATCH finds nothing', async () => {
    await conn.run('CREATE NODE TABLE Doc(id INT64, PRIMARY KEY(id))');
    const rows = await conn.run('MATCH (d:Doc) WHERE d.id = $id RETURN d.id AS id', {
      id: 999,
    });
    expect(rows).toEqual([]);
  });

  it('rejects on invalid Cypher (run returns a Promise that rejects)', async () => {
    await expect(conn.run('THIS IS NOT VALID CYPHER')).rejects.toThrow();
  });
});

describe('@kgpacks/db — Connection lifecycle', () => {
  it('Connection.close() is idempotent', () => {
    const db = new Database();
    const conn = db.connect();
    expect(() => {
      conn.close();
      conn.close();
    }).not.toThrow();
    db.close();
  });

  it('rejects run() after the connection is closed', async () => {
    const db = new Database();
    const conn = db.connect();
    conn.close();
    await expect(conn.run('RETURN 1 AS one')).rejects.toThrow();
    db.close();
  });
});

describe('@kgpacks/db — on-disk database', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kgpacks-db-'));
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('persists data to a path and reads it back from a reopened database', async () => {
    const path = join(dir, 'pack.lbug');

    const dbWrite = new Database(path);
    const writer = dbWrite.connect();
    await writer.run('CREATE NODE TABLE Doc(id INT64, PRIMARY KEY(id))');
    await writer.run('CREATE (:Doc {id: 42})');
    writer.close();
    dbWrite.close();

    const dbRead = new Database(path);
    const reader = dbRead.connect();
    const rows = await reader.run<{ id: number | bigint }>('MATCH (d:Doc) RETURN d.id AS id');
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].id)).toBe(42);
    reader.close();
    dbRead.close();
  });
});
