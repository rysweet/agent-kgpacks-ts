// @kgpacks/backend — response shape types.
//
// The frozen JSON contract returned by each endpoint, ported 1:1 from the reference
// `backend/models/*` Pydantic models. Field names use snake_case to match the
// wire format the existing frontend consumes.

export interface ChatResponse {
  answer: string;
  sources: string[];
  query_type: string;
  execution_time_ms: number;
}

export interface SearchResult {
  article: string;
  similarity: number;
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

export interface AutocompleteResult {
  title: string;
  category: string | null;
  match_type: string;
}

export interface AutocompleteResponse {
  query: string;
  suggestions: AutocompleteResult[];
  total: number;
}

export interface GraphNode {
  id: string;
  title: string;
  category: string | null;
  word_count: number;
  depth: number;
  links_count: number;
  summary: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
  weight: number;
}

export interface GraphResponse {
  seed: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  total_nodes: number;
  total_edges: number;
  execution_time_ms: number;
}

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
  last_updated: string;
}

export interface CategoryInfo {
  name: string;
  article_count: number;
}

export interface CategoryListResponse {
  categories: CategoryInfo[];
  total: number;
}

export interface StatsResponse {
  articles: Record<string, unknown>;
  sections: Record<string, unknown>;
  links: Record<string, unknown>;
  database: Record<string, unknown>;
  performance: Record<string, unknown> | null;
}

export interface HealthResponse {
  status: string;
  version: string;
  database: string;
  timestamp: string;
}
