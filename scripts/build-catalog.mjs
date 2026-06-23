#!/usr/bin/env node
// Data-driven catalog builder — the single replacement for the reference repo's
// 68 per-domain `build_*_pack.py` scripts. Reads `catalog/<pack>/urls.txt` and
// builds each pack's LadybugDB (fetch -> extract -> embed -> index) via
// @kgpacks/ingestion, writing to `data/packs/<pack>/pack.db`.
//
//   node scripts/build-catalog.mjs --list
//   node scripts/build-catalog.mjs                       # build the whole catalog
//   node scripts/build-catalog.mjs --pack go-expert      # build one (csv for many)
//   node scripts/build-catalog.mjs --max-articles 10     # cap per-pack ingestion
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPack } from '../packages/ingestion/dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const catalogDir = join(root, 'catalog');
const outRoot = join(root, 'data', 'packs');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const only = opt('--pack');
const maxArticles = Number(opt('--max-articles', '60'));
const maxDepth = Number(opt('--max-depth', '1'));

let packs = (await readdir(catalogDir, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
if (only) {
  const wanted = new Set(only.split(','));
  packs = packs.filter((p) => wanted.has(p));
}
if (args.includes('--list')) {
  console.log(packs.join('\n'));
  process.exit(0);
}

const seedsOf = async (pack) =>
  (await readFile(join(catalogDir, pack, 'urls.txt'), 'utf8'))
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//.test(s));

let ok = 0;
let failed = 0;
for (const pack of packs) {
  if (!existsSync(join(catalogDir, pack, 'urls.txt'))) continue;
  const seeds = await seedsOf(pack);
  if (seeds.length === 0) {
    console.warn(`skip ${pack}: no urls`);
    continue;
  }
  const packDir = join(outRoot, pack);
  await mkdir(packDir, { recursive: true });
  const dbPath = join(packDir, 'pack.db');
  const t0 = Date.now();
  try {
    const res = await buildPack({
      seeds,
      dbPath,
      maxDepth,
      maxArticles: Math.min(maxArticles, seeds.length),
    });
    ok++;
    const summary = {
      pack,
      dbPath: res.dbPath,
      articles: res.articles.length,
      sections: res.sections.length,
      chunks: res.chunks.length,
      entities: res.entities.length,
      relationships: res.relationships.length,
      links: res.links?.length ?? 0,
      seconds: Math.round((Date.now() - t0) / 1000),
    };
    console.log(JSON.stringify(summary));
  } catch (err) {
    failed++;
    console.error(`FAILED ${pack}: ${err?.message ?? err}`);
  }
}
console.log(`\ncatalog build complete: ${ok} ok, ${failed} failed, of ${packs.length} selected`);
process.exit(failed > 0 ? 1 : 0);
