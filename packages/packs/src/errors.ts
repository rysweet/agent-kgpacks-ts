// Typed error hierarchy for @kgpacks/packs.
//
// All failures extend a common PacksError base so callers can catch the whole
// family or discriminate by subtype. Mirrors the upstream raise/throw semantics the
// package ports: validation never fails silently and never leaves partial state.

export class PacksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ManifestValidationError extends PacksError {}

export class PackInstallError extends PacksError {}

export class PackNotFoundError extends PacksError {}
