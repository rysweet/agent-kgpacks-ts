// Pre-installs the LadybugDB VECTOR + FTS extensions once, serially, before the
// parallel test job. Without this, many test workers race to INSTALL the same
// extension over the network and can read a half-written binary ("file too
// short"). Run after `pnpm -r build`.
import { Database } from '../packages/db/dist/index.js';

const db = new Database();
const conn = db.connect();
try {
  for (const ext of ['vector', 'fts']) {
    await conn.loadExtension(ext);
    console.log(`installed + loaded extension: ${ext}`);
  }
} finally {
  conn.close();
  db.close();
}
