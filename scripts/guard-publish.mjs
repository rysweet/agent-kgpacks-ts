#!/usr/bin/env node
// Publish guard: this repo produces the installable `agent-kgpacks-ts` tarball,
// but it must NOT be published from here. The downstream private-feed pipeline
// owns publishing. `prepublishOnly` runs this before any `npm publish`, so an
// accidental publish hard-fails unless KGPACKS_ALLOW_PUBLISH=1 is explicitly set
// (which the downstream pipeline does deliberately).
if (process.env.KGPACKS_ALLOW_PUBLISH === '1') {
  process.exit(0);
}

console.error(
  [
    'Refusing to publish agent-kgpacks-ts from this repository.',
    '',
    'Publishing is performed by the downstream private-feed pipeline, not from',
    'this repo. This repo only produces the installable tarball via `npm pack`.',
    '',
    'If you are that pipeline and really intend to publish, re-run with',
    'KGPACKS_ALLOW_PUBLISH=1 set in the environment.',
  ].join('\n'),
);
process.exit(1);
