#!/usr/bin/env node
// scripts/guard-publish.mjs
//
// `prepublishOnly` guard. This repository's root package (`agent-kgpacks-ts`, the
// installable `wikigr` CLI) is intentionally NOT published from here: releases to
// the private feed are cut by the downstream private-feed pipeline, which sets the
// explicit opt-in below. A stray `npm publish` from a developer machine or from CI
// would push an unintended build to a registry, so we hard-fail unless the opt-in
// is present.
if (process.env.KGPACKS_ALLOW_PUBLISH === '1') {
  process.exit(0);
}

console.error(
  [
    'Refusing to publish agent-kgpacks-ts.',
    '',
    'Publishing of this package is performed exclusively by the downstream',
    'private-feed release pipeline, not from this repository. Running',
    '`npm publish` here is almost always a mistake.',
    '',
    'If you really are the release pipeline, set KGPACKS_ALLOW_PUBLISH=1 to proceed.',
  ].join('\n'),
);
process.exit(1);
