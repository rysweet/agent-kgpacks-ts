// apps/frontend/src/api/types.ts
//
// Wire types RESTATED from the @kgpacks/backend `/api/v1` contract — identical
// snake_case field names and casing (`max_results`, `query_type`,
// `execution_time_ms`, `word_count`, …). This module never imports from the
// backend; the two stay aligned by contract. See docs/packages/frontend.md.

// ─── Chat ─────────────────────────────────────────────────────────────────────
export interface ChatRequest {
  question: string; // length 1–500
  pack?: string; // ^[a-z0-9][a-z0-9-]*$ (Phase 1: default pack only)
  max_results?: number; // 1–50, default 10
}

export interface ChatResponse {
  answer: string;
  sources: string[];
  query_type: string; // stable label, "vector_search" in Phase 1
  execution_time_ms: number;
}

export interface StreamChatRequest {
  question: string; // length 1–500
  max_results?: number; // 1–50, default 10
}

export interface StreamDone {
  query_type: string;
  execution_time_ms: number;
}

// ─── Search / hybrid-search ───────────────────────────────────────────────────
export interface SearchResult {
  article: string;
  similarity: number; // [0, 1]
  category: string | null;
  word_count: number;
  summary: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  total: number;
  execution_time_ms: number;
}

// ─── Graph ────────────────────────────────────────────────────────────────────
export interface GraphNode {
  id: string;
  title: string;
  category: string | null;
  word_count: number;
  depth: number; // 0 = seed
  links_count: number;
  summary: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string; // "internal"
  weight: number; // 1
}

export interface GraphResponse {
  seed: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  total_nodes: number;
  total_edges: number;
  execution_time_ms: number;
}

// ─── Article detail ───────────────────────────────────────────────────────────
export interface ArticleSection {
  title: string;
  content: string;
  word_count: number;
  level: number;
}

export interface ArticleDetail {
  title: string;
  category: string | null;
  word_count: number;
  sections: ArticleSection[];
  links: string[];
  backlinks: string[];
  categories: string[];
  wikipedia_url: string;
  last_updated: string; // ISO-8601 …Z
}

// ─── Autocomplete / categories / stats / health ──────────────────────────────
export interface AutocompleteSuggestion {
  title: string;
  category: string | null;
  match_type: 'prefix' | 'contains';
}

export interface AutocompleteResponse {
  query: string;
  suggestions: AutocompleteSuggestion[];
  total: number;
}

export interface CategoryCount {
  name: string;
  article_count: number;
}

export interface CategoriesResponse {
  categories: CategoryCount[];
  total: number;
}

export interface StatsResponse {
  articles: {
    total: number;
    by_category: Record<string, number>;
    by_depth: Record<string, number>;
  };
  sections: { total: number; avg_per_article: number };
  links: { total: number; avg_per_article: number };
  database: { size_mb: number; last_updated: string | null };
  performance: unknown | null;
}

export interface HealthResponse {
  status: 'healthy' | 'unhealthy';
  version: string;
  database: 'connected' | 'disconnected';
  timestamp: string;
}
