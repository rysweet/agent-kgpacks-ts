import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ExternalServiceError,
  createExternalContext,
  downloadBoundedFile,
  exactOriginPolicy,
  fetchBoundedBytes,
} from '../src/external-transport.js';

const SOURCE = 'https://downloads.example/corpus';
const POLICY = exactOriginPolicy(SOURCE);

afterEach(() => vi.useRealTimers());

describe('bounded external transport', () => {
  it('streams a response to disk without buffering the corpus', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kgpacks-transport-'));
    const destination = join(directory, 'part');
    try {
      const context = createExternalContext(
        {
          fetch: vi.fn().mockResolvedValue(new Response('corpus bytes', { status: 200 })),
        },
        1_000,
      );
      await expect(
        downloadBoundedFile(context, SOURCE, POLICY, destination, 12, 'corpus download'),
      ).resolves.toMatchObject({ bytes: 12 });
      expect(readFileSync(destination, 'utf8')).toBe('corpus bytes');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects disallowed redirect origins without exposing a signed URL', async () => {
    const secret = 'super-secret-token';
    const context = createExternalContext(
      {
        fetch: vi.fn().mockResolvedValue(
          new Response('', {
            status: 302,
            headers: { Location: `https://evil.example/file?token=${secret}` },
          }),
        ),
      },
      1_000,
    );

    const error = await fetchBoundedBytes(context, SOURCE, POLICY, 100, 'index download').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect(error).toMatchObject({ code: 'origin' });
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain('evil.example');
  });

  it('enforces redirect and response-size limits', async () => {
    const redirects = vi
      .fn()
      .mockResolvedValue(
        new Response('', { status: 302, headers: { Location: `${SOURCE}/next` } }),
      );
    const redirectContext = createExternalContext(
      { fetch: redirects, limits: { maxRedirects: 1 } },
      1_000,
    );
    await expect(
      fetchBoundedBytes(redirectContext, SOURCE, POLICY, 100, 'index download'),
    ).rejects.toMatchObject({ code: 'redirect' });
    expect(redirects).toHaveBeenCalledTimes(2);

    const sizeContext = createExternalContext(
      {
        fetch: vi
          .fn()
          .mockResolvedValue(
            new Response('12345', { status: 200, headers: { 'Content-Length': '5' } }),
          ),
      },
      1_000,
    );
    await expect(
      fetchBoundedBytes(sizeContext, SOURCE, POLICY, 4, 'index download'),
    ).rejects.toMatchObject({ code: 'response-too-large' });
  });

  it('does not retry timeout or caller cancellation', async () => {
    const timeoutFetch = vi.fn((_input, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    const timeoutContext = createExternalContext(
      { fetch: timeoutFetch, limits: { requestTimeoutMs: 5, retryBaseDelayMs: 0 } },
      1_000,
    );
    await expect(
      fetchBoundedBytes(timeoutContext, SOURCE, POLICY, 100, 'index download'),
    ).rejects.toMatchObject({ code: 'timeout', retryable: false });
    expect(timeoutFetch).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    controller.abort();
    const cancelledFetch = vi.fn();
    const cancelledContext = createExternalContext(
      { fetch: cancelledFetch, signal: controller.signal },
      1_000,
    );
    await expect(
      fetchBoundedBytes(cancelledContext, SOURCE, POLICY, 100, 'index download'),
    ).rejects.toMatchObject({ code: 'cancelled', retryable: false });
    expect(cancelledFetch).not.toHaveBeenCalled();
  });

  it('redacts nested transport failures and never exceeds three attempts', async () => {
    const secret = 'ghp_not_for_logs';
    const fetchMock = vi.fn().mockRejectedValue(new Error(`failed ${SOURCE}?token=${secret}`));
    const context = createExternalContext(
      {
        fetch: fetchMock,
        limits: { maxAttempts: 3, retryBaseDelayMs: 0 },
      },
      1_000,
    );
    const error = await fetchBoundedBytes(context, SOURCE, POLICY, 100, 'index download').catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: 'transport', retryable: true });
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain(SOURCE);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
