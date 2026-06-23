#!/usr/bin/env node
// scripts/check-no-python.mjs
//
// Python-free security gate (see docs/PLAN.md).
//
// Enforces the hard constraint that no RUNTIME package may declare or invoke a
// Python dependency. Python is permitted only as a development-time parity oracle
// kept entirely outside the packages/ dependency graph — never in shipped code.
//
// Usage:
//   node scripts/check-no-python.mjs [scanDir]
//     scanDir defaults to "packages".
//
// For every <scanDir>/<pkg>:
//   - reads package.json and flags any Python-flavored dependency name across
//     dependencies / devDependencies / optionalDependencies / peerDependencies;
//   - walks <pkg>/src/** and flags source that spawns/invokes python or a .py file.
//
// Exit 0 => clean. Exit 1 => at least one violation (fails closed).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const scanDir = process.argv[2] ?? 'packages';

// Dependency *names* that indicate a Python runtime coupling.
const DEP_NAME_PATTERNS = [/python/i, /pyodide/i, /^pip($|[-_])/i, /pyright/i];

// Source patterns that spawn/invoke Python or run a .py script.
const SOURCE_PATTERNS = [/\bpython[0-9.]*\b/i, /\bpip[0-9]?\s+install\b/i, /\.py(['"`\s)\];,]|$)/];

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

const violations = [];

function listDirs(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
}

function walkFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function checkPackageJson(pkgDir) {
  const pkgPath = join(pkgDir, 'package.json');
  let raw;
  try {
    raw = readFileSync(pkgPath, 'utf8');
  } catch {
    return;
  }
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    violations.push({ file: pkgPath, reason: 'unparseable package.json' });
    return;
  }
  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const name of Object.keys(deps)) {
      for (const pattern of DEP_NAME_PATTERNS) {
        if (pattern.test(name)) {
          violations.push({
            file: pkgPath,
            reason: `Python-flavored ${field} entry "${name}" (matched ${pattern})`,
          });
        }
      }
    }
  }
}

function checkSources(pkgDir) {
  const srcDir = join(pkgDir, 'src');
  try {
    if (!statSync(srcDir).isDirectory()) return;
  } catch {
    return;
  }
  for (const file of walkFiles(srcDir)) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const pattern of SOURCE_PATTERNS) {
      const match = pattern.exec(content);
      if (match) {
        violations.push({
          file,
          reason: `source invokes Python (matched ${pattern} near "${match[0]}")`,
        });
        break;
      }
    }
  }
}

const packageDirs = listDirs(scanDir);
for (const pkgDir of packageDirs) {
  checkPackageJson(pkgDir);
  checkSources(pkgDir);
}

if (violations.length > 0) {
  console.error(`✗ python-free guard FAILED — ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  - ${relative(process.cwd(), v.file)}: ${v.reason}`);
  }
  console.error('\nRuntime packages must not declare or invoke Python dependencies.');
  process.exit(1);
}

console.log(
  `✓ python-free guard passed — scanned ${packageDirs.length} package(s) under "${scanDir}".`,
);
process.exit(0);
