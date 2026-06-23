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
// cheap and per-request. The required `vector` extension is loaded onto each
// connection (installed once, then `LOAD`ed per connection).

import type { Connection, Database } from '@kgpacks/db';

/** Options for {@link ConnectionManager}. */
export interface ConnectionManagerOptions {
  /**
   * Extensions to load onto every connection. Defaults to `['vector']` (required
   * by the semantic-search / hybrid / chat vector queries). Extension loading is
   * best-effort: a load failure is recorded once and skipped thereafter so routes
   * that don't need the extension keep working.
   */
  extensions?: string[];
}

export class ConnectionManager {
  readonly #database: Database;
  readonly #extensions: string[];
  readonly #installed = new Set<string>();
  readonly #failed = new Set<string>();

  constructor(database: Database, options: ConnectionManagerOptions = {}) {
    this.#database = database;
    this.#extensions = options.extensions ?? ['vector'];
  }

  /**
   * Opens a fresh connection with the configured extensions loaded. The caller
   * owns the returned connection and must `close()` it (use {@link withConnection}
   * unless the connection must outlive the request, as the SSE stream requires).
   */
  async getConnection(): Promise<Connection> {
    const conn = this.#database.connect();
    for (const ext of this.#extensions) {
      if (this.#failed.has(ext)) continue;
      try {
        if (this.#installed.has(ext)) {
          await conn.run(`LOAD EXTENSION ${ext}`);
        } else {
          await conn.loadExtension(ext);
          this.#installed.add(ext);
        }
      } catch {
        // Best-effort: give up on this extension for the rest of the process so a
        // missing/optional extension never blocks every subsequent connection.
        this.#failed.add(ext);
      }
    }
    return conn;
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
