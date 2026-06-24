// apps/frontend/src/__tests__/ui.test.tsx
//
// TDD contract for the React surface (RED until the hook + components exist).
// Drives everything through INJECTED fakes (a fake-EventSource-backed ApiClient
// and a mocked-fetch ApiClient) — no real network, no real EventSource.
//
// Documents the component/accessibility contract the implementation must satisfy:
//   - `useChatStream(api)`  — idle → streaming → done/error state machine, with
//     the answer ACCUMULATING and `reset()` returning to idle.
//   - `<ChatPanel api={api} />` — submit opens a stream; the submit control is
//     DISABLED while streaming and re-enabled on done/error; streamed sources +
//     answer render as text; a stream error renders a `role="alert"`.
//   - `<SearchBox api={api} onResults={…} />` — a labelled "Search" submit runs
//     `search()` and lifts the typed `SearchResponse`.
//   - `<ResultsView results graph onSelect />` — results + graph render as plain
//     text (no innerHTML); clicking a result calls `onSelect(title)`.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiClient, type ApiClientOptions } from '../api/client';
import { ApiClientError } from '../api/errors';
import { ChatPanel } from '../components/ChatPanel';
import { ResultsView } from '../components/ResultsView';
import { SearchBox } from '../components/SearchBox';
import { useChatStream } from '../hooks/useChatStream';
import type { GraphResponse, SearchResponse } from '../api/types';

import { lastFakeEventSource, resetFakeEventSources, FakeEventSource } from './fake-event-source';
import { jsonResponse, makeFetch } from './http-mocks';

type Factory = NonNullable<ApiClientOptions['eventSourceFactory']>;
const eventSourceFactory = ((url: string) => new FakeEventSource(url)) as unknown as Factory;

function streamClient(): ApiClient {
  return new ApiClient({ baseUrl: 'http://api.test', eventSourceFactory });
}

const SEARCH_RESPONSE: SearchResponse = {
  query: 'Quantum entanglement',
  results: [
    {
      article: "Bell's theorem",
      similarity: 0.91,
      category: 'Physics',
      word_count: 1200,
      summary: 'A no-go theorem on local hidden variables.',
    },
  ],
  total: 1,
  execution_time_ms: 5,
};

const GRAPH_RESPONSE: GraphResponse = {
  seed: 'Quantum entanglement',
  nodes: [
    {
      id: '1',
      title: 'Quantum entanglement',
      category: 'Physics',
      word_count: 1200,
      depth: 0,
      links_count: 1,
      summary: 'Seed article.',
    },
  ],
  edges: [
    { source: 'Quantum entanglement', target: "Bell's theorem", type: 'internal', weight: 1 },
  ],
  total_nodes: 1,
  total_edges: 1,
  execution_time_ms: 7,
};

beforeEach(() => {
  resetFakeEventSources();
});

describe('useChatStream', () => {
  it('moves idle → streaming → done, accumulates the answer, and exposes sources + meta', () => {
    const api = streamClient();
    const { result } = renderHook(() => useChatStream(api));

    expect(result.current.state).toBe('idle');

    act(() => result.current.ask({ question: 'What is entanglement?' }));
    expect(result.current.state).toBe('streaming');

    const es = lastFakeEventSource();
    act(() => es.emit('sources', JSON.stringify(['Quantum entanglement'])));
    act(() => es.emit('token', 'Entanglement '));
    act(() => es.emit('token', 'links particles.'));

    expect(result.current.sources).toEqual(['Quantum entanglement']);
    expect(result.current.answer).toBe('Entanglement links particles.');

    act(() =>
      es.emit('done', JSON.stringify({ query_type: 'vector_search', execution_time_ms: 12 })),
    );
    expect(result.current.state).toBe('done');
    expect(result.current.doneMeta).toEqual({ query_type: 'vector_search', execution_time_ms: 12 });
  });

  it('surfaces an in-stream error as state=error with an ApiClientError', () => {
    const api = streamClient();
    const { result } = renderHook(() => useChatStream(api));

    act(() => result.current.ask({ question: 'x' }));
    act(() => lastFakeEventSource().emit('error', 'AgentError'));

    expect(result.current.state).toBe('error');
    expect(result.current.error).toBeInstanceOf(ApiClientError);
    expect(result.current.error?.code).toBe('AGENT_ERROR');
  });

  it('reset() returns to idle and clears answer/sources/error', () => {
    const api = streamClient();
    const { result } = renderHook(() => useChatStream(api));

    act(() => result.current.ask({ question: 'x' }));
    act(() => lastFakeEventSource().emit('token', 'hello'));
    act(() => result.current.reset());

    expect(result.current.state).toBe('idle');
    expect(result.current.answer).toBe('');
    expect(result.current.sources).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('closes the EventSource when the hosting component unmounts', () => {
    const api = streamClient();
    const { result, unmount } = renderHook(() => useChatStream(api));

    act(() => result.current.ask({ question: 'x' }));
    const es = lastFakeEventSource();

    unmount();
    expect(es.closeCount).toBeGreaterThanOrEqual(1);
    expect(es.readyState).toBe(FakeEventSource.CLOSED);
  });
});

describe('ChatPanel', () => {
  it('streams an answer, disables the submit while streaming, and re-enables it on done', async () => {
    const user = userEvent.setup();
    render(<ChatPanel api={streamClient()} />);

    await user.type(screen.getByRole('textbox'), 'What is entanglement?');
    const submit = screen.getByRole('button', { name: /send|ask|submit/i });
    await user.click(submit);

    // While streaming, the form is disabled (prevents overlap / respects limits).
    expect(submit).toBeDisabled();

    const es = lastFakeEventSource();
    act(() => es.emit('sources', JSON.stringify(['Quantum entanglement'])));
    act(() => es.emit('token', 'Entanglement links particles.'));

    expect(await screen.findByText(/Entanglement links particles\./)).toBeInTheDocument();
    expect(screen.getAllByText(/Quantum entanglement/).length).toBeGreaterThanOrEqual(1);

    act(() =>
      es.emit('done', JSON.stringify({ query_type: 'vector_search', execution_time_ms: 12 })),
    );
    await waitFor(() => expect(submit).toBeEnabled());
  });

  it('renders a role="alert" and re-enables the form when the stream fails', async () => {
    const user = userEvent.setup();
    render(<ChatPanel api={streamClient()} />);

    await user.type(screen.getByRole('textbox'), 'x');
    const submit = screen.getByRole('button', { name: /send|ask|submit/i });
    await user.click(submit);

    act(() => lastFakeEventSource().fail());

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await waitFor(() => expect(submit).toBeEnabled());
  });
});

describe('SearchBox', () => {
  it('runs search() on submit and lifts the typed SearchResponse to onResults', async () => {
    const user = userEvent.setup();
    const { fetch } = makeFetch((call) => {
      if (call.url.includes('/api/v1/search')) return jsonResponse(SEARCH_RESPONSE);
      // Debounced autocomplete (incidental) — answer with an empty suggestion set.
      return jsonResponse({ query: '', suggestions: [], total: 0 });
    });
    const api = new ApiClient({ baseUrl: 'http://api.test', fetch });
    const onResults = vi.fn();

    render(<SearchBox api={api} onResults={onResults} />);

    await user.type(screen.getByRole('textbox'), 'Quantum entanglement');
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => expect(onResults).toHaveBeenCalledWith(SEARCH_RESPONSE));
  });

  it('selects a suggestion (now a button) and runs a search for it', async () => {
    const user = userEvent.setup();
    const { fetch } = makeFetch((call) => {
      if (call.url.includes('/api/v1/search')) return jsonResponse(SEARCH_RESPONSE);
      if (call.url.includes('/api/v1/autocomplete')) {
        return jsonResponse({
          query: 'qu',
          suggestions: [
            { title: 'Quantum entanglement', category: 'Physics', match_type: 'prefix' },
          ],
          total: 1,
        });
      }
      return jsonResponse({ query: '', suggestions: [], total: 0 });
    });
    const api = new ApiClient({ baseUrl: 'http://api.test', fetch });
    const onResults = vi.fn();

    render(<SearchBox api={api} onResults={onResults} />);
    await user.type(screen.getByLabelText(/search articles/i), 'qu');

    // The suggestion is a keyboard-operable button (was an inert <li> before).
    const suggestion = await screen.findByRole('button', { name: 'Quantum entanglement' });
    await user.click(suggestion);

    await waitFor(() => expect(onResults).toHaveBeenCalledWith(SEARCH_RESPONSE));
  });

  it('surfaces a failed search with role="alert" instead of swallowing it', async () => {
    const user = userEvent.setup();
    const { fetch } = makeFetch((call) => {
      if (call.url.includes('/api/v1/search')) throw new Error('network down');
      return jsonResponse({ query: '', suggestions: [], total: 0 });
    });
    const api = new ApiClient({ baseUrl: 'http://api.test', fetch });

    render(<SearchBox api={api} onResults={vi.fn()} />);
    await user.type(screen.getByLabelText(/search articles/i), 'quantum');
    await user.click(screen.getByRole('button', { name: /search/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('ResultsView', () => {
  it('renders search results as plain text and calls onSelect when a result is chosen', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    const { container } = render(
      <ResultsView results={SEARCH_RESPONSE} graph={null} onSelect={onSelect} />,
    );

    expect(container.textContent).toContain("Bell's theorem");
    expect(container.textContent).toContain('A no-go theorem on local hidden variables.');
    expect(container.textContent).toContain('Physics');

    await user.click(screen.getByText("Bell's theorem"));
    expect(onSelect).toHaveBeenCalledWith("Bell's theorem");
  });

  it('renders the graph neighborhood (nodes + edges) as plain text', () => {
    const { container } = render(
      <ResultsView results={null} graph={GRAPH_RESPONSE} onSelect={() => {}} />,
    );

    // The seed node title renders…
    expect(container.textContent).toContain('Quantum entanglement');
    // …and the EDGE target ("Bell's theorem" is NOT a node here) proves edges render.
    expect(container.textContent).toContain("Bell's theorem");
  });

  it('announces an empty result set instead of rendering nothing', () => {
    const empty: SearchResponse = { query: 'zzz', results: [], total: 0, execution_time_ms: 1 };
    render(<ResultsView results={empty} graph={null} onSelect={() => {}} />);

    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(/No results found for "zzz"/);
  });
});
