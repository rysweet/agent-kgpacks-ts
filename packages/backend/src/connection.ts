// @kgpacks/backend — per-request LadybugDB connection manager.
//
// Enforces the Spike-A concurrency rule: LadybugDB `Connection` objects are not
// safe for concurrent in-flight queries, so the backend opens exactly one
// connection per logical unit of work and never shares it between requests.
//
//   - `withConnection(fn)` — opens a fresh connection, runs `fn`, and closes it in
//     a `finally`, matching the reference `get_db()` request dependency.
//   - `getConnection()` — returns a connection whose lifetime the caller manages
//     (the SSE stream holds one open for the duration of the stream), matching the
//     reference `get_long_lived_connection()`.
//
// A single `Database` handle is held for the process lifetime; connections are
// cheap and per-request. The required `vector` extension is INSTALL+LOADed exactly
// ONCE, on a dedicated connection, before any request connection is handed out —
// NOT per request. Both INSTALL and LOAD are write transactions, and LadybugDB
// permits only one write transaction at a time. Loading per request connection
// therefore made concurrent cold-start requests race: each lost connection's
// INSTALL/LOAD threw "Cannot start a new write transaction" (one winner loads the
// extension DB-wide), which the old code swallowed and used to mark the extension
// permanently "failed". In practice the winner's load made vector work anyway, but
// the design was fragile: a request could be handed a connection in the brief
// window before the winner committed and have its vector query fail, and the
// failed-state bookkeeping was simply wrong. Loading once, up front, removes the
// race — a loaded extension is visible to every subsequent connection.

import type { Connection, Database } from '@kgpacks/db';

/** Options for {@link ConnectionManager}. */
export interface ConnectionManagerOptions {
  /**
   * Extensions to load once onto the database. Defaults to `['vector']` (required
   * by the semantic-search / hybrid / chat vector queries). Extension loading is
   * best-effort: a load failure is skipped so routes that don't need the extension
   * keep working.
   */
  extensions?: string[];
}

export class ConnectionManager {
  readonly #database: Database;
  readonly #extensions: string[];
  /** Memoized one-time extension load (shared by all concurrent callers). */
  #ready: Promise<void> | undefined;

  constructor(database: Database, options: ConnectionManagerOptions = {}) {
    this.#database = database;
    this.#extensions = options.extensions ?? ['vector'];
  }

  /**
   * INSTALL+LOADs every configured extension exactly once, on a single dedicated
   * connection, serialized so the write transactions never collide. Concurrent
   * callers all await the same promise. Best-effort per extension: a missing /
   * optional extension is skipped rather than blocking every request.
   */
  #ensureExtensions(): Promise<void> {
    if (this.#ready === undefined) {
      this.#ready = (async () => {
        const conn = this.#database.connect();
        try {
          for (const ext of this.#extensions) {
            try {
              await conn.run(`INSTALL ${ext}`);
              await conn.run(`LOAD EXTENSION ${ext}`);
            } catch {
              // Best-effort: a missing/optional extension must not block requests.
            }
          }
        } finally {
          conn.close();
        }
      })();
    }
    return this.#ready;
  }

  /**
   * Opens a fresh connection (after the one-time extension load has completed). The
   * caller owns the returned connection and must `close()` it (use
   * {@link withConnection} unless the connection must outlive the request, as the
   * SSE stream requires).
   */
  async getConnection(): Promise<Connection> {
    await this.#ensureExtensions();
    return this.#database.connect();
  }

  /**
   * Opens one connection, runs `fn` against it, and closes it in a `finally` —
   * even on error. The TS equivalent of the reference `get_db()` dependency.
   */
  async withConnection<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
    const conn = await this.getConnection();
    try {
      return await fn(conn);
    } finally {
      conn.close();
    }
  }
}
