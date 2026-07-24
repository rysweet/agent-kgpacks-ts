import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PACK_REPO, DEFAULT_PACK_TAG } from '../src/constants.js';
import { discoverLatestPackBaseUrl, pullPack, resolvePackBaseUrl } from '../src/pack-pull.js';

describe('latest immutable pack discovery', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('paginates releases and recognizes dated immutable tags', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      tag_name: `other-v1.0.${index}`,
      draft: false,
      assets: [],
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(firstPage), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              tag_name: 'cve-2026.07',
              draft: false,
              assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
            },
          ]),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(discoverLatestPackBaseUrl('cve', 'owner/repo')).resolves.toBe(
      'https://github.com/owner/repo/releases/download/cve-2026.07',
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/owner/repo/releases?per_page=100&page=1',
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/owner/repo/releases?per_page=100&page=2',
      expect.any(Object),
    );
  });

  it('retries a transient GitHub API response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              tag_name: 'cve-v1.2.3',
              draft: false,
              assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
            },
          ]),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(discoverLatestPackBaseUrl('cve', 'owner/repo')).resolves.toContain('cve-v1.2.3');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('selects the highest version and accepts SemVer build metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            tag_name: 'cve-v1.0.0',
            draft: false,
            assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
          },
          {
            tag_name: 'cve-v2.0.0+build.1',
            draft: false,
            assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
          },
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(discoverLatestPackBaseUrl('cve', 'owner/repo')).resolves.toBe(
      'https://github.com/owner/repo/releases/download/cve-v2.0.0+build.1',
    );
  });

  it('prefers a release over prereleases and breaks equal-precedence ties deterministically', async () => {
    const releases = [
      {
        tag_name: 'cve-v2.0.0+build.1',
        draft: false,
        assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
      },
      {
        tag_name: 'cve-v2.0.0-rc.9',
        draft: false,
        assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
      },
      {
        tag_name: 'cve-v2.0.0+build.2',
        draft: false,
        assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
      },
    ];
    for (const ordered of [releases, [...releases].reverse()]) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(ordered), { status: 200 })),
      );
      await expect(discoverLatestPackBaseUrl('cve', 'owner/repo')).resolves.toBe(
        'https://github.com/owner/repo/releases/download/cve-v2.0.0+build.2',
      );
      vi.unstubAllGlobals();
    }
  });

  it('treats prerelease-only results as no stable immutable release', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              tag_name: 'cve-v2.1.0-rc.1',
              draft: false,
              assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
            },
          ]),
          { status: 200 },
        ),
      ),
    );

    await expect(discoverLatestPackBaseUrl('cve', 'owner/repo')).rejects.toThrow(
      /no immutable release/i,
    );
  });

  it('rejects a stable-looking tag when GitHub marks the release as a prerelease', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              tag_name: 'cve-v2.1.0',
              draft: false,
              prerelease: true,
              assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
            },
          ]),
          { status: 200 },
        ),
      ),
    );

    await expect(discoverLatestPackBaseUrl('cve', 'owner/repo')).rejects.toThrow(
      /no immutable release/i,
    );
  });

  it('orders equal-precedence candidates by full version before tag bytewise', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              tag_name: 'cve-2026.07',
              draft: false,
              assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
            },
            {
              tag_name: 'cve-v2026.7.0+z',
              draft: false,
              assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
            },
          ]),
          { status: 200 },
        ),
      ),
    );

    await expect(discoverLatestPackBaseUrl('cve', 'owner/repo')).resolves.toBe(
      'https://github.com/owner/repo/releases/download/cve-v2026.7.0+z',
    );
  });

  it('ignores a newer unsigned release during trusted discovery', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              tag_name: 'cve-v3.0.0',
              draft: false,
              assets: [{ name: 'cve.pack-release.json' }],
            },
            {
              tag_name: 'cve-v2.0.0',
              draft: false,
              assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
            },
          ]),
          { status: 200 },
        ),
      ),
    );

    await expect(discoverLatestPackBaseUrl('cve', 'owner/repo')).resolves.toBe(
      'https://github.com/owner/repo/releases/download/cve-v2.0.0',
    );
  });

  it('allows unsigned discovery only when verification is explicitly disabled', async () => {
    const response = () =>
      new Response(
        JSON.stringify([
          {
            tag_name: 'cve-v3.0.0',
            draft: false,
            assets: [{ name: 'cve.pack-release.json' }],
          },
        ]),
        { status: 200 },
      );
    vi.stubGlobal('fetch', vi.fn().mockImplementation(response));

    await expect(discoverLatestPackBaseUrl('cve', 'owner/repo')).rejects.toThrow(
      /pack-release\.json\.sig/,
    );
    await expect(discoverLatestPackBaseUrl('cve', 'owner/repo', false)).resolves.toBe(
      'https://github.com/owner/repo/releases/download/cve-v3.0.0',
    );
  });

  it('rejects an untrusted automatic-release signature before parsing the index', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('api.github.com')) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                tag_name: 'cve-v3.0.0',
                draft: false,
                assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
              },
            ]),
            { status: 200 },
          ),
        );
      }
      if (url.endsWith('.sig')) {
        return Promise.resolve(new Response(Buffer.alloc(64).toString('base64'), { status: 200 }));
      }
      return Promise.resolve(new Response('not-json', { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      pullPack({ name: 'cve', packsDir: '/unused', repo: 'owner/repo' }),
    ).rejects.toThrow(/signature verification failed/i);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('cannot override automatic signature enforcement with a false option', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('api.github.com')) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                tag_name: 'cve-v3.0.0',
                draft: false,
                assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
              },
            ]),
            { status: 200 },
          ),
        );
      }
      if (url.endsWith('.sig')) return Promise.resolve(new Response('', { status: 200 }));
      return Promise.resolve(new Response('not-json', { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      pullPack({
        name: 'cve',
        packsDir: '/unused',
        repo: 'owner/repo',
        requireSignature: false,
      }),
    ).rejects.toThrow(/release is unsigned/i);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps resolvePackBaseUrl static and defaults an omitted tag', () => {
    expect(resolvePackBaseUrl({})).toBe(
      `https://github.com/${DEFAULT_PACK_REPO}/releases/download/${DEFAULT_PACK_TAG}`,
    );
    expect(resolvePackBaseUrl({ repo: 'owner/repo' })).toBe(
      `https://github.com/owner/repo/releases/download/${DEFAULT_PACK_TAG}`,
    );
    expect(resolvePackBaseUrl({ baseUrl: 'https://packs.example.test///' })).toBe(
      'https://packs.example.test',
    );
  });

  it('falls back to the default tag only when discovery finds no eligible release', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('api.github.com')) {
        return Promise.resolve(new Response('[]', { status: 200 }));
      }
      return Promise.resolve(new Response('not-found', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      pullPack({ name: 'cve', packsDir: '/unused', repo: 'owner/repo' }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledWith(
      `https://github.com/owner/repo/releases/download/${DEFAULT_PACK_TAG}/cve.pack-release.json`,
      expect.any(Object),
    );
  });

  it('does not misclassify an optional-signature service failure as unsigned', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('.sig')) {
        return Promise.resolve(new Response('forbidden', { status: 403 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      pullPack({
        name: 'cve',
        packsDir: '/unused',
        baseUrl: 'https://packs.example.test',
      }),
    ).rejects.toThrow(/cannot fetch optional release asset.*HTTP 403/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
