// @kgpacks/backend — entity-graph service.
//
// Thin wrapper over `@kgpacks/query`'s transport-agnostic `entityGraph`, mapping
// its typed failures onto the API error envelope: an unknown seed → 404, an
// out-of-range depth → 400 (depth is already schema-bounded on the HTTP path, so
// this is defensive). See docs/entity-graph.md.

import type { Connection } from '@kgpacks/db';
import { entityGraph, QueryError, type EntityGraphResult } from '@kgpacks/query';

import { ApiError } from '../errors.js';

export interface EntityGraphParams {
  entity: string;
  depth: number;
  limit: number;
  type?: string;
  mode: 'auto' | 'co-occurrence' | 'relation';
}

/** Builds the entity neighborhood; throws `404` for an unknown seed entity. */
export async function getEntityGraph(
  conn: Connection,
  params: EntityGraphParams,
): Promise<EntityGraphResult> {
  try {
    return await entityGraph(conn, {
      entity: params.entity,
      depth: params.depth,
      limit: params.limit,
      type: params.type,
      mode: params.mode,
    });
  } catch (err) {
    if (err instanceof QueryError) {
      if (/not found/i.test(err.message)) {
        throw ApiError.notFound(`Entity not found: ${params.entity}`);
      }
      throw ApiError.invalidParameter(err.message);
    }
    throw err;
  }
}
