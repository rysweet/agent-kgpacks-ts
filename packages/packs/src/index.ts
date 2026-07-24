// @kgpacks/packs — public entry point.
//
// Knowledge-pack manifest model & validation, installer, registry, and SemVer
// versioning. Zero runtime dependencies (Node built-ins only). See
// docs/packages/packs.md for the full API reference and security model.

export {
  MANIFEST_FILENAME,
  PACK_NAME_RE,
  validateManifest,
  loadManifest,
  loadManifestFromDir,
  saveManifest,
} from './manifest.js';
export type {
  PackManifest,
  PackManifestV2,
  PackLineageV2,
  PackUpdateV2,
  PackUpdateRecordV2,
  PackFileMetadataV2,
  UpdateOperation,
  UpdateClassification,
  Sha256,
  GraphStats,
  EvalScores,
  PackProvenance,
} from './manifest.js';

export {
  parseVersion,
  isValidSemver,
  compareVersions,
  sortVersions,
  latestVersion,
  packVersionFromReleaseTag,
} from './versioning.js';
export type { ParsedVersion } from './versioning.js';

export { installPack, installPackFromStream } from './installer.js';
export type { InstalledPack } from './installer.js';

export { listPacks, packInfo, removePack } from './registry.js';

export {
  PacksError,
  ManifestValidationError,
  PackInstallError,
  PackNotFoundError,
} from './errors.js';
