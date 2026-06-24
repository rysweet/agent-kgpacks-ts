// apps/frontend/src/components/ResultsView.tsx
//
// Renders search results and, when present, a graph neighborhood — both as PLAIN
// TEXT lists (no d3, no SVG, no innerHTML). Selecting a result calls `onSelect`
// so the parent can load that article's graph. This is the seam where a future
// visual graph component drops in behind the unchanged `GraphResponse` contract.
// See docs/packages/frontend.md#resultsview.

import type { GraphResponse, SearchResponse } from '../api/types';

export interface ResultsViewProps {
  results: SearchResponse | null;
  graph: GraphResponse | null;
  onSelect(title: string): void;
}

export function ResultsView({ results, graph, onSelect }: ResultsViewProps) {
  return (
    <section className="results-view" aria-label="Results">
      {results && (
        <div className="search-results">
          <h3>Results for {results.query}</h3>
          {/* Announce that the search completed and how many results it found,
              including the zero-result case (otherwise screen-reader users hear
              nothing and sighted users see an ambiguous empty list). */}
          <p className="results-status" role="status" aria-live="polite">
            {results.results.length === 0
              ? `No results found for "${results.query}".`
              : `${results.results.length} result${results.results.length === 1 ? '' : 's'} for "${results.query}".`}
          </p>
          {results.results.length > 0 && (
            <ul>
              {results.results.map((result) => (
                <li key={result.article}>
                  <button type="button" onClick={() => onSelect(result.article)}>
                    {result.article}
                  </button>
                  <span className="result-similarity"> {result.similarity.toFixed(2)} </span>
                  {result.category !== null && (
                    <span className="result-category"> {result.category} </span>
                  )}
                  <span className="result-summary"> {result.summary}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {graph && (
        <div className="graph-view">
          <h3>Graph: {graph.seed}</h3>
          <ul className="graph-nodes">
            {graph.nodes.map((node) => (
              <li key={node.id}>
                {node.title} (depth {node.depth})
              </li>
            ))}
          </ul>
          <ul className="graph-edges">
            {graph.edges.map((edge, index) => (
              <li key={`${edge.source}->${edge.target}#${index}`}>
                {edge.source} → {edge.target}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
