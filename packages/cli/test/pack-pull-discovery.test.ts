import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExternalServiceError } from '../src/external-transport.js';
import { discoverLatestPackBaseUrl, pullPack, resolvePackBaseUrl } from '../src/pack-pull.js';

const REPO = 'owner/repo';
const INDEX = 'cve.pack-release.json';
const SIGNATURE = `${INDEX}.sig`;

function asset(tag: string, name: string, repo = REPO, size?: number) {
  return {
    name,
    browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${name}`,
    ...(size === undefined ? {} : { size }),
  };
}

function release(
  tag: string,
  options: {
    id?: number | string;
    publishedAt?: string;
    draft?: boolean;
    prerelease?: boolean;
    assets?: ReturnType<typeof asset>[];
  } = {},
) {
  return {
    id: options.id ?? 1,
    tag_name: tag,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    published_at: options.publishedAt ?? '2026-01-01T00:00:00Z',
    assets: options.assets ?? [asset(tag, INDEX), asset(tag, SIGNATURE)],
  };
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), { status: 200, ...init });
}

describe('strict GitHub pack release discovery', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('discovers only when no explicit source exists and preserves explicit URL resolution', () => {
    expect(resolvePackBaseUrl({ repo: REPO, tag: 'cve-v1.2.3' })).toBe(
      'https://github.com/owner/repo/releases/download/cve-v1.2.3',
    );
    expect(
      resolvePackBaseUrl({
        repo: 'ignored/repository',
        tag: 'ignored',
        baseUrl: 'https://mirror.example/releases/',
      }),
    ).toBe('https://mirror.example/releases');
  });

  it('paginates within bounds and recognizes a stable dated immutable tag', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      release(`other-v1.0.${index}`, { id: index + 1, assets: [] }),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(firstPage))
      .mockResolvedValueOnce(json([release('cve-2026.07', { id: 101 })]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(discoverLatestPackBaseUrl('cve', REPO)).resolves.toBe(
      'https://github.com/owner/repo/releases/download/cve-2026.07',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('orders by version, publication time, raw ASCII tag, then release ID', async () => {
    const candidates = [
      release('cve-v2.0.0+build.a', {
        id: 8,
        publishedAt: '2026-03-01T00:00:00Z',
      }),
      release('cve-v2.0.0+build.z', {
        id: 7,
        publishedAt: '2026-03-01T00:00:00Z',
      }),
      release('cve-v2.0.0+old', {
        id: 99,
        publishedAt: '2026-02-01T00:00:00Z',
      }),
      release('cve-v1.9.9', {
        id: 100,
        publishedAt: '2026-04-01T00:00:00Z',
      }),
    ];

    for (const ordered of [candidates, [...candidates].reverse()]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(ordered)));
      await expect(discoverLatestPackBaseUrl('cve', REPO)).resolves.toBe(
        'https://github.com/owner/repo/releases/download/cve-v2.0.0+build.z',
      );
      vi.unstubAllGlobals();
    }

    const duplicateTag = [release('cve-v2.0.0', { id: 9 }), release('cve-v2.0.0', { id: 10 })];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(duplicateTag)));
    await expect(discoverLatestPackBaseUrl('cve', REPO)).resolves.toContain('cve-v2.0.0');
  });

  it('excludes drafts, prereleases, missing stability metadata, and SemVer prereleases', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          json([
            release('cve-v9.0.0', { draft: true }),
            release('cve-v8.0.0', { prerelease: true }),
            { ...release('cve-v7.0.0'), draft: undefined },
            release('cve-v6.0.0-rc.1'),
            release('cve-v2.0.0'),
          ]),
        ),
    );

    await expect(discoverLatestPackBaseUrl('cve', REPO)).resolves.toContain('cve-v2.0.0');
  });

  it('fails closed for duplicate corpora and repository/tag-mismatched assets', async () => {
    const tag = 'cve-v2.0.0';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        json([
          release(tag, {
            assets: [asset(tag, INDEX), asset(tag, INDEX), asset(tag, SIGNATURE)],
          }),
        ]),
      ),
    );
    await expect(discoverLatestPackBaseUrl('cve', REPO)).rejects.toMatchObject({
      code: 'ambiguous',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        json([
          release(tag, {
            assets: [asset('cve-v1.0.0', INDEX), asset(tag, SIGNATURE)],
          }),
        ]),
      ),
    );
    await expect(discoverLatestPackBaseUrl('cve', REPO)).rejects.toMatchObject({
      code: 'trust',
    });
  });

  it('rejects duplicate part filenames before downloading corpus bytes', async () => {
    const sha256 = '0'.repeat(64);
    const index = {
      name: 'cve',
      version: '2.0.0',
      format: 'tar.gz-multipart-v1',
      sha256,
      totalBytes: 2,
      parts: [
        { file: 'cve.tar.gz.000', bytes: 1, sha256 },
        { file: 'cve.tar.gz.000', bytes: 1, sha256 },
      ],
    };
    const fetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      return Promise.resolve(
        url.endsWith('.sig')
          ? new Response('', { status: 404 })
          : new Response(JSON.stringify(index), { status: 200 }),
      );
    });

    await expect(
      pullPack({
        name: 'cve',
        packsDir: '/unused',
        baseUrl: 'https://mirror.example/releases',
        noVerify: true,
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({ code: 'invalid-response' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('requires exactly one signature unless verification is explicitly disabled', async () => {
    const unsigned = release('cve-v3.0.0', {
      assets: [asset('cve-v3.0.0', INDEX)],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(json([unsigned]))),
    );

    await expect(discoverLatestPackBaseUrl('cve', REPO)).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(discoverLatestPackBaseUrl('cve', REPO, false)).resolves.toContain('cve-v3.0.0');
  });

  it('fails when a full final page reaches the configured pagination bound', async () => {
    const page = Array.from({ length: 100 }, (_, index) =>
      release(`other-v1.0.${index}`, { id: index + 1, assets: [] }),
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(page)));

    await expect(
      discoverLatestPackBaseUrl('cve', REPO, true, {
        limits: { discoveryMaxPages: 1 },
      }),
    ).rejects.toMatchObject({ code: 'response-too-large' });
  });

  it('retries only transient discovery failures and caps the operation at three attempts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '999' } }))
      .mockResolvedValueOnce(json([release('cve-v2.0.0')]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      discoverLatestPackBaseUrl('cve', REPO, true, {
        limits: { retryBaseDelayMs: 0, maxRetryAfterMs: 0 },
      }),
    ).resolves.toContain('cve-v2.0.0');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const permanent = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', permanent);
    await expect(discoverLatestPackBaseUrl('cve', REPO)).rejects.toMatchObject({
      code: 'http',
      status: 401,
    });
    expect(permanent).toHaveBeenCalledTimes(1);
  });

  it('does not discover or retry after an explicit-tag failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      pullPack({
        name: 'cve',
        packsDir: '/unused',
        repo: REPO,
        tag: 'cve-v1.0.0',
      }),
    ).rejects.toBeInstanceOf(ExternalServiceError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('api.github.com');
  });

  it('rejects an untrusted automatic-release signature before parsing the index', async () => {
    const tag = 'cve-v3.0.0';
    const fetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('api.github.com')) return Promise.resolve(json([release(tag)]));
      if (url.endsWith('.sig')) {
        return Promise.resolve(new Response(Buffer.alloc(64).toString('base64'), { status: 200 }));
      }
      return Promise.resolve(new Response('not-json', { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(pullPack({ name: 'cve', packsDir: '/unused', repo: REPO })).rejects.toMatchObject({
      code: 'trust',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
