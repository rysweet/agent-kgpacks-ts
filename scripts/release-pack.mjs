#!/usr/bin/env node
// Package an installed knowledge pack into a multi-part, integrity-checked
// GitHub release artifact.
//
// Large packs exceed GitHub's 2 GiB per-asset limit (the full CVE pack is
// ~6-7 GiB), so a pack is published as a set of `<name>.tar.gz.NNN` parts plus a
// `<name>.pack-release.json` index carrying per-part and overall SHA-256 sums.
// `wikigr pack pull <name>` consumes exactly this layout: it downloads the parts,
// verifies the checksums, and streams the concatenation through the streaming
// installer (no whole-archive buffering, full tar-entry validation).
//
// The archive is built with system `tar --format=ustar` (deterministic, simple
// ustar headers, no pax/global records — what the in-process installer parses)
// over the pack's `manifest.json` + `pack.db`, gzip-compressed in-process and
// split into fixed-size parts. The tar/gzip stream is never held whole in memory,
// so this scales to multi-GB packs.
//
//   node scripts/release-pack.mjs --pack <name> [--packs-dir data/packs] \
//        [--tag packs] [--repo owner/repo] [--part-size 1900MiB] \
//        [--out-dir <work>] [--notes <text>] [--model <id>] [--dry-run]
//
// --dry-run produces the parts + index in --out-dir and skips all `gh` calls
// (used by the end-to-end test, which serves the dir over localhost and pulls).
import { spawn, spawnSync } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const has = (n) => args.includes(n);

const pack = opt('--pack');
const packsDir = opt('--packs-dir', join(root, 'data', 'packs'));
const tag = opt('--tag', 'packs');
const repo = opt('--repo'); // default: the gh-resolved repo for the cwd
const notes = opt('--notes');
const modelArg = opt('--model');
const corpusCommitArg = opt('--corpus-commit');
const corpusDateArg = opt('--corpus-date');
const dryRun = has('--dry-run');

if (!pack) {
  console.error(
    'usage: release-pack.mjs --pack <name> [--packs-dir dir] [--tag t] [--repo owner/repo]\n' +
      '       [--part-size 1900MiB] [--out-dir dir] [--notes text] [--model id]\n' +
      '       [--corpus-commit sha] [--corpus-date YYYY-MM-DD] [--dry-run]',
  );
  process.exit(2);
}

/** Parse a size like `1900MiB`, `512MB`, `2GiB`, or a plain byte count. */
function parseSize(s, dflt) {
  if (!s) return dflt;
  const m = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|KiB|MiB|GiB)?$/i.exec(s.trim());
  if (!m) {
    console.error(`invalid --part-size ${JSON.stringify(s)}`);
    process.exit(2);
  }
  const n = Number(m[1]);
  const unit = (m[2] ?? 'B').toLowerCase();
  const mult = {
    b: 1,
    kb: 1000,
    mb: 1000 ** 2,
    gb: 1000 ** 3,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
  }[unit];
  return Math.floor(n * mult);
}

// GitHub caps release assets at 2 GiB; default to 1900 MiB to stay safely under.
const partSize = parseSize(opt('--part-size'), 1900 * 1024 * 1024);
if (partSize <= 0) {
  console.error('--part-size must be positive');
  process.exit(2);
}

const packDir = join(packsDir, pack);
const manifestPath = join(packDir, 'manifest.json');
const dbPath = join(packDir, 'pack.db');
for (const [label, p] of [
  ['pack directory', packDir],
  ['manifest.json', manifestPath],
  ['pack.db', dbPath],
]) {
  if (!existsSync(p)) {
    console.error(`${label} not found: ${p}`);
    process.exit(2);
  }
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const model = modelArg ?? manifest.model ?? manifest.synthesis_model;

// A dated release tag (`<name>-YYYY.MM[.N]`) pins an immutable version whose
// SemVer form is derived UNPADDED (SemVer forbids leading zeros); the `packs`
// pointer and other non-dated tags fall back to the manifest version. Mirrors
// @kgpacks/packs' packVersionFromReleaseTag (inlined so this script has no build
// dependency on the compiled package).
function deriveVersionFromTag(t) {
  const m = /-(\d{4})\.(\d{2})(?:\.(\d+))?$/.exec(typeof t === 'string' ? t : '');
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${Number(m[1])}.${month}.${m[3] !== undefined ? Number(m[3]) : 0}`;
}
const version = deriveVersionFromTag(tag) ?? String(manifest.version ?? '0.0.0');

// Provenance is mirrored from the pack manifest into the release index so the two
// can be cross-checked; overrides + the release-time build.date fill any gaps.
function buildProvenance() {
  const base =
    manifest && typeof manifest.provenance === 'object' && manifest.provenance
      ? manifest.provenance
      : {};
  const corpus = { ...(base.corpus ?? {}) };
  if (corpusCommitArg) corpus.commit = corpusCommitArg;
  if (corpusDateArg) corpus.date = corpusDateArg;
  const embedding = { ...(base.embedding ?? {}) };
  if (model && !embedding.model) embedding.model = model;
  const build = { ...(base.build ?? {}) };
  if (!build.date) build.date = new Date().toISOString();
  const provenance = {};
  if (Object.keys(corpus).length) provenance.corpus = corpus;
  if (Object.keys(embedding).length) provenance.embedding = embedding;
  if (Object.keys(build).length) provenance.build = build;
  return Object.keys(provenance).length ? provenance : undefined;
}
const provenance = buildProvenance();

/**
 * Stream `tar --format=ustar manifest.json pack.db` → gzip → fixed-size parts on
 * disk, hashing the overall gzip stream and each part. Returns the index object.
 */
async function buildParts(outDir) {
  const tar = spawn(
    'tar',
    ['--format=ustar', '-C', packDir, '-cf', '-', 'manifest.json', 'pack.db'],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const gzip = createGzip({ level: 6 });
  tar.stdout.pipe(gzip);
  tar.on('error', (err) => gzip.destroy(err));

  const overall = createHash('sha256');
  const parts = [];
  let totalBytes = 0;
  let partIndex = 0;
  let partStream = null;
  let partHash = null;
  let partBytes = 0;
  let partFile = '';

  const openPart = () => {
    partFile = `${pack}.tar.gz.${String(partIndex).padStart(3, '0')}`;
    partStream = createWriteStream(join(outDir, partFile));
    partHash = createHash('sha256');
    partBytes = 0;
  };
  const closePart = () =>
    new Promise((resolve, reject) => {
      if (!partStream) return resolve();
      const file = partFile;
      const bytes = partBytes;
      const sha256 = partHash.digest('hex');
      partStream.end(() => {
        parts.push({ file, bytes, sha256 });
        partIndex += 1;
        partStream = null;
        resolve();
      });
      partStream.on('error', reject);
    });
  const writeChunk = (chunk) =>
    new Promise((resolve, reject) => {
      partStream.write(chunk, (err) => (err ? reject(err) : resolve()));
    });

  openPart();
  for await (const chunk of gzip) {
    overall.update(chunk);
    totalBytes += chunk.length;
    let off = 0;
    while (off < chunk.length) {
      const room = partSize - partBytes;
      const take = Math.min(room, chunk.length - off);
      const slice = chunk.subarray(off, off + take);
      partHash.update(slice);
      await writeChunk(slice);
      partBytes += take;
      off += take;
      if (partBytes >= partSize) {
        await closePart();
        openPart();
      }
    }
  }
  await closePart();
  // Drop a trailing empty part if the stream ended exactly on a boundary.
  const finalParts = parts.filter((p) => p.bytes > 0);
  if (finalParts.length === 0) {
    console.error('produced an empty archive');
    process.exit(1);
  }

  const index = {
    name: String(manifest.name ?? pack),
    version,
    format: 'tar.gz-multipart-v1',
    model: model ?? undefined,
    provenance,
    createdAt: new Date().toISOString(),
    sha256: overall.digest('hex'),
    totalBytes,
    partSize,
    parts: finalParts,
  };
  writeFileSync(join(outDir, `${pack}.pack-release.json`), JSON.stringify(index, null, 2) + '\n');
  return index;
}

function gh(ghArgs) {
  const res = spawnSync('gh', ghArgs, { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`gh ${ghArgs.join(' ')} failed (exit ${res.status})`);
    process.exit(1);
  }
}

function releaseExists(t) {
  const a = ['release', 'view', t];
  if (repo) a.push('--repo', repo);
  return spawnSync('gh', a, { stdio: 'ignore' }).status === 0;
}

/** Create the release tag `t` if it does not exist, then upload `assets` to it. */
function publishTo(t) {
  if (!releaseExists(t)) {
    const createArgs = [
      'release',
      'create',
      t,
      '--title',
      t === 'packs' ? 'Knowledge packs' : `Knowledge pack ${pack} ${version}`,
      '--notes',
      notes ?? `Knowledge-pack release assets. Install with: wikigr pack pull <name>`,
    ];
    if (repo) createArgs.push('--repo', repo);
    gh(createArgs);
  }
  const uploadArgs = ['release', 'upload', t, ...currentAssets, '--clobber'];
  if (repo) uploadArgs.push('--repo', repo);
  gh(uploadArgs);
}
// Assets to publish — set in main() once built.
let currentAssets = [];

async function main() {
  const outDir = opt('--out-dir', await mkdtemp(join(tmpdir(), 'kgpacks-release-')));
  mkdirSync(outDir, { recursive: true });
  console.error(`[release] packaging pack=${pack} v${version} → ${outDir}`);
  const index = await buildParts(outDir);
  const sizeMiB = (index.totalBytes / 1024 / 1024).toFixed(1);
  console.error(
    `[release] ${index.parts.length} part(s), ${sizeMiB} MiB gzipped, sha256=${index.sha256.slice(0, 12)}…`,
  );

  const assets = [
    join(outDir, `${pack}.pack-release.json`),
    ...index.parts.map((p) => join(outDir, p.file)),
  ];
  currentAssets = assets;

  if (dryRun) {
    console.error(`[release] --dry-run: artifacts in ${outDir}`);
    console.log(JSON.stringify({ outDir, ...index }, null, 2));
    return;
  }

  // Publish to the requested tag (immutable when dated), then move the stable
  // `packs` latest-pointer to the same assets so `wikigr pack pull <name>` (which
  // defaults to `packs`) keeps working and always resolves the newest version.
  publishTo(tag);
  if (tag !== 'packs') publishTo('packs');
  console.error(
    `[release] uploaded ${assets.length} asset(s) to ${tag}${tag !== 'packs' ? ' (+ packs pointer)' : ''}`,
  );
  console.log(JSON.stringify({ tag, repo: repo ?? '(default)', ...index }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
