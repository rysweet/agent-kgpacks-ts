// @kgpacks/db — minimal LadybugDB wrapper.
//
// A thin, strict-ESM surface over @ladybugdb/core (a Kùzu-derived embedded graph
// database). Phase 0 scope: open a database, run Cypher with bound parameters,
// load extensions, and clean up. See docs/packages/db.md for the full reference.

import {
  Connection as CoreConnection,
  Database as CoreDatabase,
  type LbugValue,
  type QueryResult,
} from '@ladybugdb/core';

/** Named Cypher parameters bound by the driver (never string-interpolated). */
export type QueryParams = Record<string, unknown>;

/** A single result row keyed by the statement's `RETURN` aliases. */
export type Row = Record<string, unknown>;

function pickResult(result: QueryResult | QueryResult[]): QueryResult {
  return Array.isArray(result) ? result[result.length - 1] : result;
}

function closeResults(result: QueryResult | QueryResult[]): void {
  const all = Array.isArray(result) ? result : [result];
  for (const r of all) {
    try {
      r.close();
    } catch {
      // Releasing a result is best-effort; ignore double-close races.
    }
  }
}

/**
 * Executes Cypher against an open {@link Database}.
 *
 * Obtain one via {@link Database.connect}. Connections are not assumed to be
 * safe for concurrent in-flight queries (see the Spike A concurrency note in
 * docs/packages/db.md); use one connection per logical unit of work.
 */
export class Connection {
  #conn: CoreConnection | null;

  constructor(conn: CoreConnection) {
    this.#conn = conn;
  }

  /**
   * Executes a Cypher statement and returns all rows as plain objects.
   *
   * When `params` is provided the statement is prepared and the values are
   * bound by the driver; otherwise it is executed directly.
   */
  async run<T = Row>(cypher: string, params?: QueryParams): Promise<T[]> {
    const conn = this.#conn;
    if (conn === null) {
      throw new Error('Connection is closed');
    }

    let result: QueryResult | QueryResult[];
    if (params === undefined) {
      result = await conn.query(cypher);
    } else {
      const prepared = await conn.prepare(cypher);
      result = await conn.execute(prepared, params as Record<string, LbugValue>);
    }

    try {
      const rows = await pickResult(result).getAll();
      return rows as unknown as T[];
    } finally {
      closeResults(result);
    }
  }

  /**
   * Installs and loads a LadybugDB extension, issuing the
   * `INSTALL <name>` + `LOAD EXTENSION <name>` sequence so callers don't repeat
   * it. For the statically bundled extensions (e.g. `vector`) this works offline.
   */
  async loadExtension(name: string): Promise<void> {
    await this.run(`INSTALL ${name}`);
    await this.run(`LOAD EXTENSION ${name}`);
  }

  /** Closes the connection and releases native resources. Idempotent. */
  close(): void {
    const conn = this.#conn;
    if (conn === null) {
      return;
    }
    this.#conn = null;
    conn.closeSync();
  }
}

/**
 * A thin handle over a LadybugDB instance.
 *
 * Defaults to an ephemeral in-memory database; pass a filesystem path to open or
 * create an on-disk database.
 */
export class Database {
  #db: CoreDatabase | null;

  constructor(path: string = ':memory:') {
    this.#db = new CoreDatabase(path);
  }

  /** Returns a fresh {@link Connection} bound to this database. */
  connect(): Connection {
    const db = this.#db;
    if (db === null) {
      throw new Error('Database is closed');
    }
    return new Connection(new CoreConnection(db));
  }

  /** Closes the database and releases native resources. Idempotent. */
  close(): void {
    const db = this.#db;
    if (db === null) {
      return;
    }
    this.#db = null;
    db.closeSync();
  }
}
