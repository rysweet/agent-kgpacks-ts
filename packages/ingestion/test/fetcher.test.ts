// SSRF gate + redirect re-validation for the safe fetcher.

import { describe, expect, it } from 'vitest';

import { BlockedUrlError, FetchError } from '../src/errors.js';
import { assertUrlAllowed, createSafeFetcher, isBlockedAddress } from '../src/fetcher.js';
import { fakeNet, makeResponse } from './helpers.js';

const publicLookup = async (): Promise<{ address: string; family: number }[]> => [
  { address: '93.184.216.34', family: 4 },
];

describe('isBlockedAddress — range table', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['169.254.169.254', true], // cloud metadata
    ['100.64.0.1', true], // CGNAT
    ['0.0.0.0', true],
    ['224.0.0.1', true], // multicast
    ['8.8.8.8', false],
    ['93.184.216.34', false],
    ['::1', true],
    ['::', true],
    ['fe80::1', true],
    ['fc00::1', true],
    ['fec0::1', true],
    ['ff02::1', true],
    ['::ffff:127.0.0.1', true], // IPv4-mapped loopback
    ['::ffff:8.8.8.8', false], // IPv4-mapped public
    ['2606:4700:4700::1111', false], // public IPv6 (Cloudflare)
    ['not-an-ip', true], // unparseable ⇒ fail closed
  ])('%s -> blocked=%s', (addr, blocked) => {
    expect(isBlockedAddress(addr)).toBe(blocked);
  });
});

describe('assertUrlAllowed — URL-level rejections', () => {
  it('rejects non-https schemes', async () => {
    await expect(assertUrlAllowed('http://example.com/', publicLookup)).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
    await expect(assertUrlAllowed('file:///etc/passwd', publicLookup)).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
  });

  it('rejects embedded credentials', async () => {
    await expect(
      assertUrlAllowed('https://user:pass@example.com/', publicLookup),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('rejects literal private/loopback/metadata IP hosts without resolving', async () => {
    const explode = async (): Promise<never> => {
      throw new Error('lookup must not be called for literal IPs');
    };
    await expect(assertUrlAllowed('https://127.0.0.1/', explode)).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
    await expect(
      assertUrlAllowed('https://169.254.169.254/latest/meta-data', explode),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(assertUrlAllowed('https://[::1]/', explode)).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
  });

  it('rejects a public hostname that resolves to a private address (DNS rebinding)', async () => {
    const rebind = async (): Promise<{ address: string; family: number }[]> => [
      { address: '10.0.0.5', family: 4 },
    ];
    await expect(assertUrlAllowed('https://safe.example.com/', rebind)).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
  });

  it('rejects when ANY resolved address is private (mixed result)', async () => {
    const mixed = async (): Promise<{ address: string; family: number }[]> => [
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.0.10', family: 4 },
    ];
    await expect(assertUrlAllowed('https://mixed.example.com/', mixed)).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
  });

  it('allows a public hostname resolving only to public addresses', async () => {
    await expect(assertUrlAllowed('https://example.com/', publicLookup)).resolves.toBeUndefined();
  });
});

describe('createSafeFetcher — fetch + redirects', () => {
  it('returns the body for an allowed URL', async () => {
    const net = fakeNet({
      responses: { 'https://example.com/page': makeResponse(200, '<html>hi</html>') },
    });
    const fetch = createSafeFetcher(net);
    await expect(fetch('https://example.com/page')).resolves.toBe('<html>hi</html>');
    expect(net.calls).toEqual(['https://example.com/page']);
  });

  it('re-validates redirect targets and blocks a redirect to an internal host', async () => {
    const net = fakeNet({
      resolves: { 'internal.example.com': [{ address: '10.0.0.9', family: 4 }] },
      responses: {
        'https://safe.example.com/': makeResponse(302, '', {
          location: 'https://internal.example.com/secret',
        }),
      },
    });
    const fetch = createSafeFetcher(net);
    await expect(fetch('https://safe.example.com/')).rejects.toBeInstanceOf(BlockedUrlError);
    // The internal target is never fetched — it is rejected at the gate.
    expect(net.calls).toEqual(['https://safe.example.com/']);
  });

  it('follows an allowed redirect to its final body', async () => {
    const net = fakeNet({
      responses: {
        'https://a.example.com/': makeResponse(301, '', { location: 'https://b.example.com/' }),
        'https://b.example.com/': makeResponse(200, 'final'),
      },
    });
    const fetch = createSafeFetcher(net);
    await expect(fetch('https://a.example.com/')).resolves.toBe('final');
  });

  it('fails closed on too many redirects', async () => {
    const net = fakeNet({
      responses: {
        'https://loop.example.com/': makeResponse(302, '', {
          location: 'https://loop.example.com/',
        }),
      },
    });
    const fetch = createSafeFetcher({ ...net, maxRedirects: 2 });
    await expect(fetch('https://loop.example.com/')).rejects.toBeInstanceOf(FetchError);
  });

  it('fails on a non-2xx terminal status', async () => {
    const net = fakeNet({
      responses: { 'https://example.com/missing': makeResponse(404, 'nope') },
    });
    const fetch = createSafeFetcher(net);
    await expect(fetch('https://example.com/missing')).rejects.toBeInstanceOf(FetchError);
  });

  it('blocks the initial URL before any network call', async () => {
    const net = fakeNet({});
    const fetch = createSafeFetcher(net);
    await expect(fetch('http://example.com/')).rejects.toBeInstanceOf(BlockedUrlError);
    expect(net.calls).toEqual([]);
  });
});

describe('createSafeFetcher — response body size cap', () => {
  it('rejects early when Content-Length exceeds the cap', async () => {
    const net = fakeNet({
      responses: {
        'https://example.com/big': makeResponse(200, 'x', { 'content-length': '999999' }),
      },
    });
    const fetch = createSafeFetcher({ ...net, maxBytes: 1024 });
    await expect(fetch('https://example.com/big')).rejects.toBeInstanceOf(FetchError);
  });

  it('rejects an over-cap body via the text() fallback (no body stream)', async () => {
    const net = fakeNet({
      responses: { 'https://example.com/huge': makeResponse(200, 'a'.repeat(5000)) },
    });
    const fetch = createSafeFetcher({ ...net, maxBytes: 1024 });
    await expect(fetch('https://example.com/huge')).rejects.toBeInstanceOf(FetchError);
  });

  it('rejects mid-stream when a chunked body exceeds the cap', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(512)); // each pull adds 512 bytes, unbounded
      },
      cancel() {
        cancelled = true;
      },
    });
    const net = fakeNet({
      responses: {
        'https://example.com/stream': {
          status: 200,
          headers: { get: () => null },
          text: async () => '',
          body,
        },
      },
    });
    const fetch = createSafeFetcher({ ...net, maxBytes: 1024 });
    await expect(fetch('https://example.com/stream')).rejects.toBeInstanceOf(FetchError);
    expect(cancelled).toBe(true); // the reader cancels the oversized stream
  });

  it('reads a within-cap streamed body', async () => {
    const payload = new TextEncoder().encode('<html>ok</html>');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    const net = fakeNet({
      responses: {
        'https://example.com/ok': {
          status: 200,
          headers: { get: () => null },
          text: async () => 'unused',
          body,
        },
      },
    });
    const fetch = createSafeFetcher({ ...net, maxBytes: 1024 });
    await expect(fetch('https://example.com/ok')).resolves.toBe('<html>ok</html>');
  });
});
