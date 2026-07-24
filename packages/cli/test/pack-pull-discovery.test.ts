import { afterEach, describe, expect, it, vi } from 'vitest';

import { discoverLatestPackBaseUrl, pullPack } from '../src/pack-pull.js';

describe('latest immutable pack discovery', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('paginates releases and recognizes dated immutable tags', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      tag_name: `other-v1.0.${index}`,
      draft: false,
      prerelease: false,
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
              prerelease: false,
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

  it('selects the highest version and accepts SemVer build metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            tag_name: 'cve-v1.0.0',
            draft: false,
            prerelease: false,
            assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
          },
          {
            tag_name: 'cve-v2.0.0+build.1',
            draft: false,
            prerelease: false,
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
        prerelease: false,
        assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
      },
      {
        tag_name: 'cve-v2.0.0-rc.9',
        draft: false,
        prerelease: false,
        assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
      },
      {
        tag_name: 'cve-v2.0.0+build.2',
        draft: false,
        prerelease: false,
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
              prerelease: false,
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

  it('excludes GitHub drafts and prereleases before ranking stable releases', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              tag_name: 'cve-v9.0.0',
              draft: true,
              prerelease: false,
              assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
            },
            {
              tag_name: 'cve-v8.0.0',
              draft: false,
              prerelease: true,
              assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
            },
            {
              tag_name: 'cve-v2.0.0',
              draft: false,
              prerelease: false,
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

  it('orders equal-precedence candidates by full version before tag bytewise', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              tag_name: 'cve-2026.07',
              draft: false,
              prerelease: false,
              assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
            },
            {
              tag_name: 'cve-v2026.7.0+z',
              draft: false,
              prerelease: false,
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

  it('uses identical ordinal tag ordering across locales and reversed API input', async () => {
    const releases = [
      {
        tag_name: 'cve-2026.07',
        draft: false,
        prerelease: false,
        assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
      },
      {
        tag_name: 'cve-v2026.7.0',
        draft: false,
        prerelease: false,
        assets: [{ name: 'cve.pack-release.json' }, { name: 'cve.pack-release.json.sig' }],
      },
    ];
    const originalLocale = process.env.LC_ALL;
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('locale-sensitive comparison is forbidden');
    });
    try {
      for (const locale of ['C', 'tr_TR.UTF-8']) {
        process.env.LC_ALL = locale;
        for (const ordered of [releases, [...releases].reverse()]) {
          vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(ordered), { status: 200 })),
          );
          await expect(discoverLatestPackBaseUrl('cve', 'owner/repo')).resolves.toBe(
            'https://github.com/owner/repo/releases/download/cve-v2026.7.0',
          );
          vi.unstubAllGlobals();
        }
      }
    } finally {
      localeCompare.mockRestore();
      if (originalLocale === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = originalLocale;
    }
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
              prerelease: false,
              assets: [{ name: 'cve.pack-release.json' }],
            },
            {
              tag_name: 'cve-v2.0.0',
              draft: false,
              prerelease: false,
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
            prerelease: false,
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
                prerelease: false,
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
                prerelease: false,
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
});
