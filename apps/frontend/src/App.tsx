// apps/frontend/src/App.tsx
//
// Composes the three components and owns the single `ApiClient` instance, which
// it passes down as a prop. Selecting a search result loads that article's graph
// neighborhood. Layout is intentionally minimal; the focus is the data contract
// and the streaming UX. See docs/packages/frontend.md#ui.

import { useRef, useState } from 'react';

import { ApiClient } from './api/client';
import { ChatPanel } from './components/ChatPanel';
import { ResultsView } from './components/ResultsView';
import { SearchBox } from './components/SearchBox';
import type { GraphResponse, SearchResponse } from './api/types';

const api = new ApiClient();

export function App() {
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  // Monotonic token so a stale earlier graph response can't replace a newer one.
  const latestGraphRequest = useRef(0);

  const loadGraph = (title: string) => {
    const requestId = ++latestGraphRequest.current;
    api.graph({ article: title }).then(
      (response) => {
        if (requestId === latestGraphRequest.current) setGraph(response);
      },
      () => {
        if (requestId === latestGraphRequest.current) setGraph(null);
      },
    );
  };

  return (
    <main className="app">
      <header className="app-header">
        <h1>agent-kgpacks</h1>
        <p>Ask questions and explore the knowledge graph.</p>
      </header>

      <div className="app-columns">
        <ChatPanel api={api} />
        <div className="app-explore">
          <SearchBox
            api={api}
            onResults={(response) => {
              setResults(response);
              setGraph(null);
            }}
          />
          <ResultsView results={results} graph={graph} onSelect={loadGraph} />
        </div>
      </div>
    </main>
  );
}
