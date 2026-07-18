// packages/query/test/entity-graph.test.ts
//
// TDD (RED): @kgpacks/query does not yet export entityGraph(), so this suite fails
// at import today. It encodes docs/entity-graph.md — the transport-agnostic entity
// neighborhood core over Entity / HAS_ENTITY / ENTITY_RELATION, with auto mode
// selection (co-occurrence when the pack has NO ENTITY_RELATION edges — the CVE
// pack default — and relation traversal when they exist), bounded deterministic
// ordering `(depth ASC, name ASC)`, strict `depth ∈ 1..3` validation, a typed
// result shape, and an error for an unknown seed.

import { afterEach, describe, expect, it } from 'vitest';

import { Database, type Connection } from '@kgpacks/db';

import { entityGraph } from '../src/index.js';

const ENTITIES: { id: string; type: string }[] = [
  { id: 'CWE-79', type: 'weakness' },
  { id: 'WordPress', type: 'product' },
  { id: 'Drupal', type: 'product' },
  { id: 'Acme', type: 'organization' },
];

// Article → the entities it HAS_ENTITY. Co-occurrence: two entities are linked when
// some article mentions BOTH.
const ARTICLES: Record<string, string[]> = {
  'CVE-1': ['CWE-79', 'WordPress'],
  'CVE-2': ['CWE-79', 'Drupal'],
  'CVE-3': ['WordPress', 'Acme'],
};

const RELATIONS: [string, string, string][] = [
  ['CWE-79', 'WordPress', 'observed_in'],
  ['CWE-79', 'Drupal', 'observed_in'],
];

async function seed(withRelations: boolean): Promise<Database> {
  const db = new Database();
  const conn = db.connect();
  try {
    await conn.run('CREATE NODE TABLE Article(title STRING, PRIMARY KEY(title))');
    await conn.run(
      'CREATE NODE TABLE Entity(entity_id STRING, name STRING, type STRING, description STRING, PRIMARY KEY(entity_id))',
    );
    await conn.run('CREATE REL TABLE HAS_ENTITY(FROM Article TO Entity)');
    await conn.run(
      'CREATE REL TABLE ENTITY_RELATION(FROM Entity TO Entity, relation STRING, context STRING)',
    );

    for (const e of ENTITIES) {
      await conn.run('CREATE (:Entity {entity_id: $id, name: $id, type: $type, description: $d})', {
        id: e.id,
        type: e.type,
        d: '',
      });
    }
    for (const [title, ents] of Object.entries(ARTICLES)) {
      await conn.run('CREATE (:Article {title: $t})', { t: title });
      for (const eid of ents) {
        await conn.run(
          'MATCH (a:Article {title: $t}) MATCH (e:Entity {entity_id: $eid}) CREATE (a)-[:HAS_ENTITY]->(e)',
          { t: title, eid },
        );
      }
    }
    if (withRelations) {
      for (const [s, t, rel] of RELATIONS) {
        await conn.run(
          'MATCH (a:Entity {entity_id: $s}) MATCH (b:Entity {entity_id: $t}) ' +
            'CREATE (a)-[:ENTITY_RELATION {relation: $rel, context: $c}]->(b)',
          { s, t, rel, c: '' },
        );
      }
    }
  } finally {
    conn.close();
  }
  return db;
}

let openDb: Database | undefined;
afterEach(() => {
  openDb?.close();
  openDb = undefined;
});

describe('entityGraph — co-occurrence fallback without ENTITY_RELATION edges', () => {
  it('returns the seed at depth 0 and its direct co-occurring neighbors at depth 1', async () => {
    openDb = await seed(false);
    const c: Connection = openDb.connect();
    try {
      const g = await entityGraph(c, { entity: 'CWE-79', depth: 1, mode: 'co-occurrence' });
      expect(g.seed).toBe('CWE-79');
      expect(g.mode).toBe('co-occurrence');

      expect(g.nodes[0]).toMatchObject({ id: 'CWE-79', type: 'weakness', depth: 0 });
      expect(g.nodes[0].articles_count).toBe(2); // CVE-1, CVE-2

      const byId = new Map(g.nodes.map((n) => [n.id, n]));
      expect(byId.get('WordPress')?.depth).toBe(1);
      expect(byId.get('Drupal')?.depth).toBe(1);

      // Bounded + deterministic: depth ASC, then name ASC.
      expect(g.nodes.map((n) => n.id)).toEqual(['CWE-79', 'Drupal', 'WordPress']);

      expect(g.total_nodes).toBe(g.nodes.length);
      expect(g.total_edges).toBe(g.edges.length);
      expect(typeof g.execution_time_ms).toBe('number');

      for (const e of g.edges) {
        expect(typeof e.source).toBe('string');
        expect(typeof e.target).toBe('string');
        expect(typeof e.weight).toBe('number');
      }
    } finally {
      c.close();
    }
  });

  it('reaches 2-hop neighbors at depth 2 (CWE-79 → WordPress → Acme)', async () => {
    openDb = await seed(false);
    const c: Connection = openDb.connect();
    try {
      const g = await entityGraph(c, { entity: 'CWE-79', depth: 2, mode: 'co-occurrence' });
      expect(g.nodes.find((n) => n.id === 'Acme')?.depth).toBe(2);
    } finally {
      c.close();
    }
  });

  it('restricts neighbors to a requested entity type', async () => {
    openDb = await seed(false);
    const c: Connection = openDb.connect();
    try {
      const g = await entityGraph(c, {
        entity: 'WordPress',
        depth: 1,
        type: 'organization',
        mode: 'co-occurrence',
      });
      expect(g.nodes.filter((n) => n.depth > 0).map((n) => n.id)).toEqual(['Acme']);
    } finally {
      c.close();
    }
  });
});

describe('entityGraph — mode selection and validation', () => {
  it('auto-selects co-occurrence when the pack has no ENTITY_RELATION edges', async () => {
    openDb = await seed(false);
    const c: Connection = openDb.connect();
    try {
      expect((await entityGraph(c, { entity: 'CWE-79', mode: 'auto' })).mode).toBe('co-occurrence');
    } finally {
      c.close();
    }
  });

  it('auto-selects relation traversal when ENTITY_RELATION edges exist', async () => {
    openDb = await seed(true);
    const c: Connection = openDb.connect();
    try {
      expect((await entityGraph(c, { entity: 'CWE-79', mode: 'auto' })).mode).toBe('relation');
    } finally {
      c.close();
    }
  });

  it('throws on an out-of-range depth', async () => {
    openDb = await seed(false);
    const c: Connection = openDb.connect();
    try {
      await expect(entityGraph(c, { entity: 'CWE-79', depth: 0 })).rejects.toThrow();
      await expect(entityGraph(c, { entity: 'CWE-79', depth: 4 })).rejects.toThrow();
    } finally {
      c.close();
    }
  });

  it('throws for an unknown seed entity', async () => {
    openDb = await seed(false);
    const c: Connection = openDb.connect();
    try {
      await expect(entityGraph(c, { entity: 'does-not-exist', depth: 1 })).rejects.toThrow();
    } finally {
      c.close();
    }
  });
});
