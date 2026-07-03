// @kgpacks/query — entity-graph traversal (ENHANCEMENTS).
//
// A transport-agnostic entity-neighborhood query over the Entity / HAS_ENTITY /
// ENTITY_RELATION graph, reused by the MCP/CLI and the backend `/api/v1/graph`
// API. Two traversal modes:
//
//   - co-occurrence: two entities are linked when some Article HAS_ENTITY BOTH.
//     This is the CVE-pack DEFAULT, whose builder skips ENTITY_RELATION edges.
//   - relation: traverse explicit Entity→Entity ENTITY_RELATION edges (built only
//     under `--with-entity-relations`).
//
// `mode: 'auto'` picks relation when the pack has any ENTITY_RELATION edges, else
// co-occurrence. Results are bounded and deterministically ordered (depth ASC,
// then name ASC). See docs/entity-graph.md.

import type { Connection, Row } from '@kgpacks/db';

import { QueryError } from './errors.js';
import { toIdString } from './row.js';

/** Traversal mode. `auto` selects `relation` when ENTITY_RELATION edges exist. */
export type EntityGraphMode = 'auto' | 'co-occurrence' | 'relation';

/** The resolved (never `auto`) mode reported in the result. */
export type ResolvedEntityGraphMode = 'co-occurrence' | 'relation';

/** Options for {@link entityGraph}. */
export interface EntityGraphOptions {
  /** Seed entity id (Entity primary key). Required. */
  entity: string;
  /** Neighborhood radius, 1..3 (default 1). */
  depth?: number;
  /** Restrict neighbors (depth > 0) to this entity type. */
  type?: string;
  /** Traversal mode (default `auto`). */
  mode?: EntityGraphMode;
  /** Optional cap on the total number of nodes returned. */
  limit?: number;
}

/** One entity node in the neighborhood. */
export interface EntityGraphNode {
  id: string;
  name: string;
  type: string;
  /** Hop distance from the seed (0 = seed). */
  depth: number;
  /** Number of Articles that HAS_ENTITY this entity. */
  articles_count: number;
}

/** One weighted edge between two entity nodes. */
export interface EntityGraphEdge {
  source: string;
  target: string;
  /** Relation label (relation mode only). */
  relation?: string;
  /** Co-occurrence count (co-occurrence mode) or 1 (relation mode). */
  weight: number;
}

/** The entity neighborhood returned by {@link entityGraph}. */
export interface EntityGraphResult {
  seed: string;
  mode: ResolvedEntityGraphMode;
  nodes: EntityGraphNode[];
  edges: EntityGraphEdge[];
  total_nodes: number;
  total_edges: number;
  execution_time_ms: number;
}

const MIN_DEPTH = 1;
const MAX_DEPTH = 3;
/** Default cap on total nodes AND per-expansion fan-out (bounds hub seeds). */
const DEFAULT_LIMIT = 50;

interface SeedRow extends Row {
  id: unknown;
  name: unknown;
  type: unknown;
}

/** True when the pack has any ENTITY_RELATION edge (missing table → false). */
async function hasRelationEdges(conn: Connection): Promise<boolean> {
  try {
    const rows = await conn.run<Row>('MATCH ()-[r:ENTITY_RELATION]->() RETURN count(r) AS c');
    const count = rows.length > 0 ? Number(rows[0].c ?? 0) : 0;
    return Number.isFinite(count) && count > 0;
  } catch {
    // An older pack without the ENTITY_RELATION table → co-occurrence only.
    return false;
  }
}

/** Neighbors of one entity in the current mode, optionally type-restricted. */
async function neighborsOf(
  conn: Connection,
  id: string,
  mode: ResolvedEntityGraphMode,
  type: string | undefined,
  cap: number,
): Promise<{ id: string; name: string; type: string }[]> {
  const typeClause = type ? ' AND e2.type = $type' : '';
  // Bound per-expansion fan-out (ORDER BY name for determinism) so a high-degree
  // hub entity cannot blow up the traversal.
  const tail =
    ' RETURN DISTINCT e2.entity_id AS id, e2.name AS name, e2.type AS type ORDER BY name ASC LIMIT $cap';
  const cypher =
    mode === 'relation'
      ? `MATCH (e1:Entity {entity_id: $id})-[:ENTITY_RELATION]-(e2:Entity)
         WHERE e2.entity_id <> $id${typeClause}${tail}`
      : `MATCH (e1:Entity {entity_id: $id})<-[:HAS_ENTITY]-(:Article)-[:HAS_ENTITY]->(e2:Entity)
         WHERE e2.entity_id <> $id${typeClause}${tail}`;
  const params: Record<string, unknown> = { id, cap };
  if (type) params.type = type;
  const rows = await conn.run<SeedRow>(cypher, params);
  return rows.map((r) => ({
    id: toIdString(r.id),
    name: r.name === null || r.name === undefined ? toIdString(r.id) : String(r.name),
    type: r.type === null || r.type === undefined ? '' : String(r.type),
  }));
}

/** Article counts (HAS_ENTITY in-degree) for a set of entity ids. */
async function articleCounts(conn: Connection, ids: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (ids.length === 0) return counts;
  const rows = await conn.run<Row>(
    `MATCH (a:Article)-[:HAS_ENTITY]->(e:Entity)
     WHERE e.entity_id IN $ids
     RETURN e.entity_id AS id, count(a) AS c`,
    { ids },
  );
  for (const row of rows) counts.set(toIdString(row.id), Number(row.c ?? 0));
  return counts;
}

/** Edges among the selected nodes for the active mode. */
async function edgesAmong(
  conn: Connection,
  ids: string[],
  mode: ResolvedEntityGraphMode,
): Promise<EntityGraphEdge[]> {
  if (ids.length <= 1) return [];
  if (mode === 'relation') {
    const rows = await conn.run<Row>(
      `MATCH (e1:Entity)-[r:ENTITY_RELATION]->(e2:Entity)
       WHERE e1.entity_id IN $ids AND e2.entity_id IN $ids
       RETURN DISTINCT e1.entity_id AS source, e2.entity_id AS target, r.relation AS relation`,
      { ids },
    );
    return rows.map((row) => ({
      source: toIdString(row.source),
      target: toIdString(row.target),
      relation:
        row.relation === null || row.relation === undefined ? undefined : String(row.relation),
      weight: 1,
    }));
  }
  // Co-occurrence: one undirected edge per pair, weight = shared article count.
  const rows = await conn.run<Row>(
    `MATCH (e1:Entity)<-[:HAS_ENTITY]-(a:Article)-[:HAS_ENTITY]->(e2:Entity)
     WHERE e1.entity_id IN $ids AND e2.entity_id IN $ids AND e1.entity_id < e2.entity_id
     RETURN e1.entity_id AS source, e2.entity_id AS target, count(DISTINCT a) AS weight`,
    { ids },
  );
  return rows.map((row) => ({
    source: toIdString(row.source),
    target: toIdString(row.target),
    relation: 'co_occurs',
    weight: Number(row.weight ?? 0),
  }));
}

/**
 * Builds the bounded entity neighborhood around `options.entity`.
 *
 * Throws {@link QueryError} for an out-of-range depth (must be 1..3) or an unknown
 * seed entity. Nodes are ordered `(depth ASC, name ASC)` for a deterministic,
 * transport-stable result.
 */
export async function entityGraph(
  conn: Connection,
  options: EntityGraphOptions,
): Promise<EntityGraphResult> {
  const start = performance.now();

  const depth = options.depth ?? 1;
  if (!Number.isInteger(depth) || depth < MIN_DEPTH || depth > MAX_DEPTH) {
    throw new QueryError(
      `depth must be an integer between ${MIN_DEPTH} and ${MAX_DEPTH}, got ${depth}`,
    );
  }

  const seedRows = await conn.run<SeedRow>(
    'MATCH (e:Entity {entity_id: $id}) RETURN e.entity_id AS id, e.name AS name, e.type AS type',
    { id: options.entity },
  );
  if (seedRows.length === 0) {
    throw new QueryError(`entity not found: ${options.entity}`);
  }
  const seedId = toIdString(seedRows[0].id);
  const seedName =
    seedRows[0].name === null || seedRows[0].name === undefined ? seedId : String(seedRows[0].name);
  const seedType =
    seedRows[0].type === null || seedRows[0].type === undefined ? '' : String(seedRows[0].type);

  const mode: ResolvedEntityGraphMode =
    (options.mode ?? 'auto') === 'auto'
      ? (await hasRelationEdges(conn))
        ? 'relation'
        : 'co-occurrence'
      : (options.mode as ResolvedEntityGraphMode);

  const limit =
    typeof options.limit === 'number' && options.limit > 0 ? options.limit : DEFAULT_LIMIT;

  // Breadth-first expansion, recording the FIRST (shortest) depth an entity is
  // reached at. The seed's own type is never subject to the type filter. Each
  // expansion is fan-out-capped at `limit` (ordered by name) to bound hub seeds.
  const found = new Map<string, { id: string; name: string; type: string; depth: number }>();
  found.set(seedId, { id: seedId, name: seedName, type: seedType, depth: 0 });
  let frontier = [seedId];
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      const neighbors = await neighborsOf(conn, nodeId, mode, options.type, limit);
      for (const neighbor of neighbors) {
        if (found.has(neighbor.id)) continue;
        found.set(neighbor.id, { ...neighbor, depth: d });
        next.push(neighbor.id);
      }
    }
    frontier = next;
  }

  // Deterministic order: depth ASC, then name ASC.
  let ordered = [...found.values()].sort(
    (a, b) => a.depth - b.depth || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  if (ordered.length > limit) {
    ordered = ordered.slice(0, limit);
  }

  const ids = ordered.map((n) => n.id);
  const counts = await articleCounts(conn, ids);
  const nodes: EntityGraphNode[] = ordered.map((n) => ({
    id: n.id,
    name: n.name,
    type: n.type,
    depth: n.depth,
    articles_count: counts.get(n.id) ?? 0,
  }));

  const idSet = new Set(ids);
  const edges = (await edgesAmong(conn, ids, mode)).filter(
    (e) => idSet.has(e.source) && idSet.has(e.target),
  );

  return {
    seed: seedId,
    mode,
    nodes,
    edges,
    total_nodes: nodes.length,
    total_edges: edges.length,
    execution_time_ms: performance.now() - start,
  };
}
