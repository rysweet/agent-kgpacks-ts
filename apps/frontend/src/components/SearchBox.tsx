// apps/frontend/src/components/SearchBox.tsx
//
// A debounced search input that fetches autocomplete suggestions (only once the
// query is ≥ 2 chars) and, on submit, runs `search()` and lifts the typed
// `SearchResponse` to the parent. In-flight submits are disabled.
// See docs/packages/frontend.md#searchbox.

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import type { ApiClient } from '../api/client';
import type { AutocompleteSuggestion, SearchResponse } from '../api/types';

export interface SearchBoxProps {
  api: ApiClient;
  onResults(results: SearchResponse): void;
}

const DEBOUNCE_MS = 250;

export function SearchBox({ api, onResults }: SearchBoxProps) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<AutocompleteSuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      return;
    }
    // Guard against out-of-order responses: when the query changes, the cleanup
    // marks this request stale so a slow earlier response can't overwrite a newer
    // suggestion list.
    let cancelled = false;
    const handle = setTimeout(() => {
      api.autocomplete({ q: trimmed }).then(
        (res) => {
          if (!cancelled) setSuggestions(res.suggestions);
        },
        () => {
          if (!cancelled) setSuggestions([]);
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [api, query]);

  const runSearch = async (raw: string): Promise<void> => {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const results = await api.search({ query: trimmed });
      onResults(results);
    } catch {
      // Surface the failure instead of leaving stale results with no feedback.
      setError('Search failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void runSearch(query);
  };

  const selectSuggestion = (title: string): void => {
    setQuery(title);
    setSuggestions([]);
    void runSearch(title);
  };

  return (
    <section className="search-box" aria-label="Search">
      <h2>Search</h2>
      <form onSubmit={handleSubmit}>
        <label htmlFor="search-query">Search articles</label>
        <input
          id="search-query"
          type="text"
          value={query}
          placeholder="Quantum entanglement"
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" disabled={busy || query.trim().length === 0}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>

      {error && (
        <p role="alert" className="search-error">
          {error}
        </p>
      )}

      {/* Suggestions are keyboard-operable buttons (Enter/Space select); the list is
          a polite live region so screen-reader users hear that suggestions appeared. */}
      {suggestions.length > 0 && (
        <ul className="search-suggestions" aria-live="polite" aria-label="Suggestions">
          {suggestions.map((suggestion) => (
            <li key={suggestion.title}>
              <button type="button" onClick={() => selectSuggestion(suggestion.title)}>
                {suggestion.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
