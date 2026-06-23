// @kgpacks/ingestion — section → chunk windowing.
//
// Pure, deterministic. Splits each section's content into overlapping character
// windows (default 512 chars, 64 overlap) so the write side can index fine-grained
// passages on `Chunk` alongside whole `Section` nodes. Chunk ids are stable and
// derived from the article title + section index + chunk index.

import type { Article, Chunk, ChunkOptions } from './types.js';

const DEFAULT_SIZE = 512;
const DEFAULT_OVERLAP = 64;

/** Splits one piece of text into overlapping windows. Empty/blank text → `[]`. */
export function windowText(text: string, size: number, overlap: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.length <= size) {
    return [trimmed];
  }
  const step = Math.max(1, size - overlap);
  const windows: string[] = [];
  for (let start = 0; start < trimmed.length; start += step) {
    windows.push(trimmed.slice(start, start + size));
    if (start + size >= trimmed.length) {
      break;
    }
  }
  return windows;
}

/** Resolves user options to concrete, sane window dimensions. */
function resolveOptions(options: ChunkOptions = {}): { size: number; overlap: number } {
  const size =
    options.size !== undefined && options.size > 0 ? Math.floor(options.size) : DEFAULT_SIZE;
  const requested =
    options.overlap !== undefined && options.overlap >= 0
      ? Math.floor(options.overlap)
      : DEFAULT_OVERLAP;
  // Overlap must be strictly smaller than the window to guarantee forward progress.
  const overlap = Math.min(requested, size - 1);
  return { size, overlap };
}

/** Chunks one article's sections into overlapping {@link Chunk}s, in document order. */
export function chunkArticle(article: Article, options: ChunkOptions = {}): Chunk[] {
  const { size, overlap } = resolveOptions(options);
  const chunks: Chunk[] = [];
  for (let sectionIndex = 0; sectionIndex < article.sections.length; sectionIndex++) {
    const section = article.sections[sectionIndex];
    const windows = windowText(section.content, size, overlap);
    for (let chunkIndex = 0; chunkIndex < windows.length; chunkIndex++) {
      chunks.push({
        id: `${article.title}#${sectionIndex}#${chunkIndex}`,
        content: windows[chunkIndex],
        articleTitle: article.title,
        sectionIndex,
        chunkIndex,
      });
    }
  }
  return chunks;
}
