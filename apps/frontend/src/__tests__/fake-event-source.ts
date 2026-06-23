// apps/frontend/src/__tests__/fake-event-source.ts
//
// A controllable `EventSource` double for the streamChat / useChatStream suites.
// Tests construct it through the client's injectable `eventSourceFactory`, then
// drive the stream with `emit(name, data)` (named SSE frames) and `fail()` (a
// transport-level error carrying no data). It counts `close()` calls so suites can
// assert single, idempotent teardown. No real network or `EventSource` is used.

export interface FakeSseEvent {
  type: string;
  data?: string;
}

export type FakeSseListener = (event: FakeSseEvent) => void;

export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  static instances: FakeEventSource[] = [];

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;

  readonly url: string;
  withCredentials = false;
  readyState: number = FakeEventSource.OPEN;
  onopen: FakeSseListener | null = null;
  onmessage: FakeSseListener | null = null;
  onerror: FakeSseListener | null = null;
  closeCount = 0;

  private readonly listeners = new Map<string, Set<FakeSseListener>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: FakeSseListener): void {
    const set = this.listeners.get(type) ?? new Set<FakeSseListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: FakeSseListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.closeCount += 1;
  }

  /** Dispatch a named SSE frame, e.g. `emit('token', 'hi')`. */
  emit(type: string, data: string): void {
    const event: FakeSseEvent = { type, data };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    if (type === 'message') this.onmessage?.(event);
  }

  /** Simulate a transport-level failure: an `error` event carrying NO data. */
  fail(): void {
    this.readyState = FakeEventSource.CLOSED;
    const event: FakeSseEvent = { type: 'error' };
    this.onerror?.(event);
    for (const listener of this.listeners.get('error') ?? []) listener(event);
  }
}

/** Resets the captured-instances registry (call in `beforeEach`). */
export function resetFakeEventSources(): void {
  FakeEventSource.instances = [];
}

/** Returns the most recently constructed fake, or throws if none exists. */
export function lastFakeEventSource(): FakeEventSource {
  const instance = FakeEventSource.instances.at(-1);
  if (!instance) throw new Error('no FakeEventSource has been constructed');
  return instance;
}
