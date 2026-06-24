// @kgpacks/backend — configuration.
//
// Maps `WIKIGR_*` environment variables to a typed, frozen `Settings` object,
// mirroring the reference `backend/config` `Settings`. `loadConfig` is pure (no
// file I/O); environment overrides are the primary configuration path for the
// TypeScript port. Per-route rate limits and cache TTLs carry the reference defaults
// and are individually overridable.

/** Per-route rate limits, requests per minute. */
export interface RateLimits {
  chat: number;
  search: number;
  hybrid: number;
  graph: number;
  articles: number;
  autocomplete: number;
  categories: number;
  stats: number;
}

/** Read-endpoint `Cache-Control: max-age` values, in seconds. */
export interface CacheTtls {
  /** search, autocomplete, graph, categories, hybrid. */
  default: number;
  /** individual article detail. */
  article: number;
  /** database statistics. */
  stats: number;
}

/** Fully-resolved backend settings. */
export interface Settings {
  apiTitle: string;
  apiVersion: string;
  apiDescription: string;
  host: string;
  port: number;
  corsOrigins: string[];
  databasePath: string;
  rateLimitEnabled: boolean;
  /** Trusted reverse-proxy IPs/CIDRs from which `X-Forwarded-For` is honored. */
  trustedProxies: string[];
  /** SSE synthesis timeout in milliseconds (from `WIKIGR_STREAM_TIMEOUT_S`). */
  streamTimeoutMs: number;
  /**
   * Fastify `requestTimeout` in milliseconds (from `WIKIGR_REQUEST_TIMEOUT_S`):
   * the maximum time to receive a complete request from the client. Bounds slow /
   * stalled request bodies (Slowloris); it does NOT cap long-lived SSE responses,
   * which keep streaming once the request has been received.
   */
  requestTimeoutMs: number;
  rateLimits: RateLimits;
  cacheTtl: CacheTtls;
}

type Env = Record<string, string | undefined>;

/** A partial settings override (top-level and nested fields all optional). */
export type SettingsOverride = Partial<Omit<Settings, 'rateLimits' | 'cacheTtl'>> & {
  rateLimits?: Partial<RateLimits>;
  cacheTtl?: Partial<CacheTtls>;
};

const DEFAULT_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
];

function str(env: Env, key: string, fallback: string): string {
  const value = env[key];
  return value === undefined || value === '' ? fallback : value;
}

function int(env: Env, key: string, fallback: number): number {
  const value = env[key];
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function csv(env: Env, key: string, fallback: string[]): string[] {
  const value = env[key];
  if (value === undefined) return fallback;
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : [];
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const value = env[key];
  if (value === undefined) return fallback;
  // Mirrors the reference `!= "false"` semantics: only an explicit "false" disables.
  return value.toLowerCase() !== 'false';
}

/**
 * Builds a frozen {@link Settings} from environment variables (defaults to
 * `process.env`). No file or network I/O is performed.
 */
export function loadConfig(env: Env = process.env): Settings {
  const rateLimits: RateLimits = {
    chat: int(env, 'WIKIGR_RATE_LIMIT_CHAT', 5),
    search: int(env, 'WIKIGR_RATE_LIMIT_SEARCH', 10),
    hybrid: int(env, 'WIKIGR_RATE_LIMIT_HYBRID', 10),
    graph: int(env, 'WIKIGR_RATE_LIMIT_GRAPH', 20),
    articles: int(env, 'WIKIGR_RATE_LIMIT_ARTICLES', 30),
    autocomplete: int(env, 'WIKIGR_RATE_LIMIT_AUTOCOMPLETE', 60),
    categories: int(
      env,
      'WIKIGR_RATE_LIMIT_CATEGORIES',
      int(env, 'WIKIGR_RATE_LIMIT_ARTICLES', 30),
    ),
    stats: int(env, 'WIKIGR_RATE_LIMIT_STATS', int(env, 'WIKIGR_RATE_LIMIT_ARTICLES', 30)),
  };

  const cacheTtl: CacheTtls = {
    default: int(env, 'WIKIGR_CACHE_TTL_DEFAULT', 3600),
    article: int(env, 'WIKIGR_CACHE_TTL_ARTICLE', 86_400),
    stats: int(env, 'WIKIGR_CACHE_TTL_STATS', 300),
  };

  const settings: Settings = {
    apiTitle: str(env, 'WIKIGR_API_TITLE', 'WikiGR Visualization API'),
    apiVersion: str(env, 'WIKIGR_API_VERSION', '1.0.0'),
    apiDescription: str(
      env,
      'WIKIGR_API_DESCRIPTION',
      'RESTful API for Wikipedia knowledge graph queries',
    ),
    host: str(env, 'WIKIGR_HOST', '127.0.0.1'),
    port: int(env, 'WIKIGR_PORT', 8000),
    corsOrigins: csv(env, 'WIKIGR_CORS_ORIGINS', DEFAULT_CORS_ORIGINS),
    databasePath: str(env, 'WIKIGR_DATABASE_PATH', ''),
    rateLimitEnabled: bool(env, 'WIKIGR_RATE_LIMIT_ENABLED', true),
    trustedProxies: csv(env, 'WIKIGR_TRUSTED_PROXIES', []),
    streamTimeoutMs: int(env, 'WIKIGR_STREAM_TIMEOUT_S', 60) * 1000,
    requestTimeoutMs: int(env, 'WIKIGR_REQUEST_TIMEOUT_S', 60) * 1000,
    rateLimits,
    cacheTtl,
  };

  Object.freeze(settings.corsOrigins);
  Object.freeze(settings.trustedProxies);
  Object.freeze(settings.rateLimits);
  Object.freeze(settings.cacheTtl);
  return Object.freeze(settings);
}

/** Shallow-merges a partial override over a base {@link Settings}, re-freezing. */
export function mergeConfig(base: Settings, override?: SettingsOverride): Settings {
  if (override === undefined) return base;
  const merged: Settings = {
    ...base,
    ...override,
    rateLimits: { ...base.rateLimits, ...override.rateLimits },
    cacheTtl: { ...base.cacheTtl, ...override.cacheTtl },
    corsOrigins: override.corsOrigins ?? base.corsOrigins,
    trustedProxies: override.trustedProxies ?? base.trustedProxies,
  };
  Object.freeze(merged.rateLimits);
  Object.freeze(merged.cacheTtl);
  return Object.freeze(merged);
}
