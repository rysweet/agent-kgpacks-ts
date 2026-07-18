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
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import {
  createWriteStream,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, dirname } from 'node:path';
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
const requestedTag = opt('--tag');
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
      '       [--corpus-commit sha] [--corpus-date YYYY-MM-DD] [--sign|--no-sign] [--dry-run]',
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
if (manifest.name !== pack) {
  console.error(`manifest name ${JSON.stringify(manifest.name)} does not match --pack ${pack}`);
  process.exit(2);
}
const model = modelArg ?? manifest.model ?? manifest.synthesis_model;

// A dated release tag (`<name>-YYYY.MM[.N]`) pins an immutable version whose
// SemVer form is derived UNPADDED (SemVer forbids leading zeros); the `packs`
// pointer and other non-dated tags fall back to the manifest version. Mirrors
// @kgpacks/packs' packVersionFromReleaseTag (inlined so this script has no build
// dependency on the compiled package).
function deriveVersionFromTag(t) {
  const escapedPack = pack.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^${escapedPack}-(\\d{4})\\.(\\d{2})(?:\\.(\\d+))?$`).exec(
    typeof t === 'string' ? t : '',
  );
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${Number(m[1])}.${month}.${m[3] !== undefined ? Number(m[3]) : 0}`;
}
const version = String(manifest.version ?? '');
const manifestTag = `${pack}-v${version}`;
const tag = requestedTag ?? manifestTag;
const taggedVersion = deriveVersionFromTag(tag);
if (requestedTag && tag !== manifestTag && taggedVersion === null) {
  console.error(
    `release tag ${tag} must equal the manifest-derived tag ${manifestTag} or be a matching dated tag`,
  );
  process.exit(2);
}
if (taggedVersion && taggedVersion !== version) {
  console.error(
    `release tag ${tag} implies version ${taggedVersion}, but manifest declares ${version}`,
  );
  process.exit(2);
}

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
    [
      '--format=ustar',
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-C',
      packDir,
      '-cf',
      '-',
      'manifest.json',
      'pack.db',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const gzip = createGzip({ level: 6 });
  const tarCompletion = new Promise((resolve) => {
    tar.once('close', (code, signal) => resolve({ code, signal }));
  });
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
  const tarResult = await tarCompletion;
  if (tarResult.code !== 0) {
    throw new Error(
      `tar failed (${tarResult.signal ? `signal ${tarResult.signal}` : `exit ${tarResult.code}`})`,
    );
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
    ...(provenance?.build?.date ? { createdAt: provenance.build.date } : {}),
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

// Optional Ed25519 signing of the release index. The private key comes from the
// KGPACKS_SIGNING_KEY env (a base64 PKCS8 DER key, populated from an Actions
// secret in CI); it is never passed on argv or logged. When absent, the release
// is published UNSIGNED (integrity-only) unless --sign forces an error.
const signFlag = has('--sign');
const noSignFlag = has('--no-sign');
function resolveSigning() {
  if (signFlag && noSignFlag) {
    console.error('--sign and --no-sign are mutually exclusive');
    process.exit(2);
  }
  if (noSignFlag) return null;
  const secret = process.env.KGPACKS_SIGNING_KEY;
  if (!secret) {
    if (signFlag) {
      console.error('--sign requires a signing key in KGPACKS_SIGNING_KEY');
      process.exit(2);
    }
    return null;
  }
  let key;
  try {
    key = createPrivateKey({ key: Buffer.from(secret, 'base64'), format: 'der', type: 'pkcs8' });
  } catch (err) {
    console.error(`invalid KGPACKS_SIGNING_KEY: ${err?.message ?? err}`);
    process.exit(2);
  }
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  const publicKeyB64 = Buffer.from(jwk.x, 'base64url').toString('base64');
  return { key, publicKeyB64 };
}

function releaseExists(t) {
  const a = ['release', 'view', t];
  if (repo) a.push('--repo', repo);
  return spawnSync('gh', a, { stdio: 'ignore' }).status === 0;
}

function releaseIsDraft(t) {
  const args = ['release', 'view', t, '--json', 'isDraft', '--jq', '.isDraft'];
  if (repo) args.push('--repo', repo);
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  return result.status === 0 && String(result.stdout).trim() === 'true';
}

function remoteAssets(t) {
  const args = [
    'release',
    'view',
    t,
    '--json',
    'assets',
    '--jq',
    '.assets[] | [.name,.size,.digest] | @tsv',
  ];
  if (repo) args.push('--repo', repo);
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return new Map(
    String(result.stdout ?? '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, size, digest] = line.split('\t');
        return [name, { size: Number(size), digest }];
      }),
  );
}

async function hashAsset(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

async function matchingRemoteAssets(t, assets) {
  const remote = remoteAssets(t);
  if (!remote) return null;
  const local = new Map();
  for (const asset of assets) {
    local.set(basename(asset), {
      path: asset,
      size: statSync(asset).size,
      digest: await hashAsset(asset),
    });
  }
  for (const [name, expected] of remote) {
    const asset = local.get(name);
    if (!asset || expected.size !== asset.size || expected.digest !== asset.digest) return null;
  }
  return { remote, local };
}

async function exactReleaseExists(t, assets) {
  const matching = await matchingRemoteAssets(t, assets);
  return (
    matching !== null &&
    matching.remote.size === matching.local.size &&
    assets.every(
      (asset) =>
        matching.remote.get(basename(asset))?.digest ===
        matching.local.get(basename(asset))?.digest,
    )
  );
}

async function waitForExactReleaseAssets(t, assets) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await exactReleaseExists(t, assets)) return true;
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

/** Create a draft release and publish it only after immutable assets are uploaded. */
async function publishTo(t) {
  if (releaseExists(t)) {
    if (await exactReleaseExists(t, currentAssets)) {
      if (releaseIsDraft(t)) {
        const publishArgs = ['release', 'edit', t, '--draft=false'];
        if (repo) publishArgs.push('--repo', repo);
        gh(publishArgs);
        return true;
      }
      return false;
    }
    if (releaseIsDraft(t)) {
      const matching = await matchingRemoteAssets(t, currentAssets);
      if (matching) {
        const missing = currentAssets.filter((asset) => !matching.remote.has(basename(asset)));
        if (missing.length > 0) {
          const uploadArgs = ['release', 'upload', t, ...missing];
          if (repo) uploadArgs.push('--repo', repo);
          gh(uploadArgs);
        }
        if (!(await waitForExactReleaseAssets(t, currentAssets))) {
          console.error(
            `release ${t} assets could not be verified; leaving the release as a draft`,
          );
          process.exit(1);
        }
        const publishArgs = ['release', 'edit', t, '--draft=false'];
        if (repo) publishArgs.push('--repo', repo);
        gh(publishArgs);
        return true;
      }
    }
    console.error(`release ${t} already exists with mismatched assets; refusing to overwrite it`);
    process.exit(1);
  }
  const createArgs = [
    'release',
    'create',
    t,
    '--draft',
    '--title',
    `Knowledge pack ${pack} ${version}`,
    '--notes',
    notes ?? `Knowledge-pack release assets. Install with: wikigr pack pull <name>`,
  ];
  if (repo) createArgs.push('--repo', repo);
  gh(createArgs);
  const uploadArgs = ['release', 'upload', t, ...currentAssets];
  if (repo) uploadArgs.push('--repo', repo);
  gh(uploadArgs);
  if (!(await waitForExactReleaseAssets(t, currentAssets))) {
    console.error(`release ${t} assets could not be verified; leaving the release as a draft`);
    process.exit(1);
  }
  const publishArgs = ['release', 'edit', t, '--draft=false'];
  if (repo) publishArgs.push('--repo', repo);
  gh(publishArgs);
  return true;
}
// Assets to publish — set in main() once built.
let currentAssets = [];

async function main() {
  if (manifest.schemaVersion === '2') {
    const { validateKnowledgePack } = await import('../packages/ingestion/dist/index.js');
    await validateKnowledgePack(packDir);
  }
  const outDir = opt('--out-dir', await mkdtemp(join(tmpdir(), 'kgpacks-release-')));
  mkdirSync(outDir, { recursive: true });
  console.error(`[release] packaging pack=${pack} v${version} → ${outDir}`);
  const index = await buildParts(outDir);
  const sizeMiB = (index.totalBytes / 1024 / 1024).toFixed(1);
  console.error(
    `[release] ${index.parts.length} part(s), ${sizeMiB} MiB gzipped, sha256=${index.sha256.slice(0, 12)}…`,
  );

  const indexPath = join(outDir, `${pack}.pack-release.json`);
  const assets = [indexPath, ...index.parts.map((p) => join(outDir, p.file))];

  // Sign the RAW index bytes (Ed25519) and publish the detached signature + public
  // key alongside it, so `wikigr pack pull` can verify authenticity before parsing.
  const signing = resolveSigning();
  if (signing) {
    const indexBytes = readFileSync(indexPath);
    const sig = edSign(null, indexBytes, signing.key);
    const sigPath = `${indexPath}.sig`;
    writeFileSync(sigPath, sig.toString('base64') + '\n');
    const pubPath = join(outDir, `${pack}.pubkey`);
    writeFileSync(pubPath, signing.publicKeyB64 + '\n');
    assets.push(sigPath, pubPath);
    console.error('[release] signed index (Ed25519); wrote .sig + .pubkey');
  } else {
    console.error(
      '[release] no signing key (KGPACKS_SIGNING_KEY unset) — publishing UNSIGNED (integrity-only)',
    );
  }
  currentAssets = assets;

  if (dryRun) {
    console.error(`[release] --dry-run: artifacts in ${outDir}`);
    console.log(JSON.stringify({ outDir, ...index }, null, 2));
    return;
  }

  const published = await publishTo(tag);
  console.error(
    published
      ? `[release] uploaded and verified ${assets.length} asset(s) on ${tag}`
      : `[release] ${tag} already contains the exact assets; nothing changed`,
  );
  console.log(JSON.stringify({ tag, repo: repo ?? '(default)', ...index }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
