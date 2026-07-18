import { afterEach, describe, expect, it, vi } from 'vitest';

import { discoverLatestPackBaseUrl } from '../src/pack-pull.js';

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
              assets: [{ name: 'cve.pack-release.json' }],
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
            assets: [{ name: 'cve.pack-release.json' }],
          },
          {
            tag_name: 'cve-v2.0.0+build.1',
            draft: false,
            assets: [{ name: 'cve.pack-release.json' }],
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
});
