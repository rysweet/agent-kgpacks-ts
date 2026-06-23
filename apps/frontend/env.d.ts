/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL prepended to every API path. Empty = same-origin. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
