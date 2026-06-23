// apps/frontend/src/components/ChatPanel.tsx
//
// The streaming chat surface. Submitting opens an SSE stream; the submit control
// is disabled while streaming and re-enabled on done/error. Cited sources and
// the accumulating answer render as React TEXT NODES only (never raw HTML); a
// stream error renders a role="alert". See docs/packages/frontend.md#chatpanel.

import { useState } from 'react';
import type { FormEvent } from 'react';

import type { ApiClient } from '../api/client';
import { useChatStream } from '../hooks/useChatStream';

export interface ChatPanelProps {
  api: ApiClient;
}

export function ChatPanel({ api }: ChatPanelProps) {
  const { state, answer, sources, error, ask } = useChatStream(api);
  const [question, setQuestion] = useState('');
  const streaming = state === 'streaming';

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = question.trim();
    if (trimmed.length === 0 || streaming) return;
    ask({ question: trimmed });
  };

  return (
    <section className="chat-panel" aria-label="Chat">
      <h2>Ask</h2>
      <form onSubmit={handleSubmit}>
        <label htmlFor="chat-question">Ask a question</label>
        <input
          id="chat-question"
          type="text"
          value={question}
          placeholder="What is quantum entanglement?"
          onChange={(event) => setQuestion(event.target.value)}
          disabled={streaming}
        />
        <button type="submit" disabled={streaming || question.trim().length === 0}>
          Send
        </button>
      </form>

      {sources.length > 0 && (
        <div className="chat-sources">
          <h3>Sources</h3>
          <ul>
            {sources.map((source) => (
              <li key={source}>{source}</li>
            ))}
          </ul>
        </div>
      )}

      {answer.length > 0 && <p className="chat-answer">{answer}</p>}

      {error && (
        <p role="alert" className="chat-error">
          {error.message}
        </p>
      )}
    </section>
  );
}
