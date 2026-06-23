// apps/frontend/src/hooks/useChatStream.ts
//
// Encapsulates the streamChat lifecycle for React: it tracks the accumulating
// answer, the cited sources, the streaming/done/error state, and tears the
// EventSource down on unmount or when a new question supersedes the current
// stream. See docs/packages/frontend.md#usechatstream-hook.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiClient } from '../api/client';
import type { ApiClientError } from '../api/errors';
import type { StreamController } from '../api/sse';
import type { StreamChatRequest, StreamDone } from '../api/types';

export type ChatStreamState = 'idle' | 'streaming' | 'done' | 'error';

export interface UseChatStream {
  state: ChatStreamState;
  answer: string;
  sources: string[];
  doneMeta: StreamDone | null;
  error: ApiClientError | null;
  ask(req: StreamChatRequest): void;
  reset(): void;
}

export function useChatStream(api: ApiClient): UseChatStream {
  const [state, setState] = useState<ChatStreamState>('idle');
  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState<string[]>([]);
  const [doneMeta, setDoneMeta] = useState<StreamDone | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const controllerRef = useRef<StreamController | null>(null);

  const closeActive = useCallback(() => {
    controllerRef.current?.close();
    controllerRef.current = null;
  }, []);

  const ask = useCallback(
    (req: StreamChatRequest) => {
      closeActive();
      setAnswer('');
      setSources([]);
      setDoneMeta(null);
      setError(null);
      setState('streaming');
      controllerRef.current = api.streamChat(req, {
        onSources: (titles) => setSources(titles),
        onToken: (text) => setAnswer((prev) => prev + text),
        onDone: (meta) => {
          setDoneMeta(meta);
          setState('done');
        },
        onError: (err) => {
          setError(err);
          setState('error');
        },
      });
    },
    [api, closeActive],
  );

  const reset = useCallback(() => {
    closeActive();
    setState('idle');
    setAnswer('');
    setSources([]);
    setDoneMeta(null);
    setError(null);
  }, [closeActive]);

  // Tear the stream down on unmount — no dangling EventSource.
  useEffect(() => {
    return () => {
      controllerRef.current?.close();
      controllerRef.current = null;
    };
  }, []);

  return { state, answer, sources, doneMeta, error, ask, reset };
}
