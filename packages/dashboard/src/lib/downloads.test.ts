import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  detectMacArch,
  detectOsFamily,
  fallbackReleasePage,
  hasInstallerAssets,
  matchReleaseAsset,
  pickLatestPublishedRelease,
  resolveDefaultTarget,
  selectReleaseSource,
  toDesktopReleaseAssets,
  type ReleaseAsset,
} from './downloads.ts';

const assets: ReleaseAsset[] = [
  {
    name: 'Juejin Usage-0.1.1-beta.9-arm64.dmg',
    browser_download_url: 'https://example.test/arm64.dmg',
  },
  {
    name: 'Juejin Usage-0.1.1-beta.9-arm64.dmg.blockmap',
    browser_download_url: 'https://example.test/arm64.blockmap',
  },
  {
    name: 'Juejin Usage-0.1.1-beta.9-x64.dmg',
    browser_download_url: 'https://example.test/x64.dmg',
  },
  {
    name: 'Juejin Usage Setup 0.1.1-beta.9.exe',
    browser_download_url: 'https://example.test/setup.exe',
  },
  {
    name: 'Juejin Usage 0.1.1-beta.9.exe',
    browser_download_url: 'https://example.test/portable.exe',
  },
  {
    name: 'latest.yml',
    browser_download_url: 'https://example.test/latest.yml',
  },
];

describe('detectOsFamily', () => {
  it('detects Windows from UA and platform strings', () => {
    assert.equal(
      detectOsFamily(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Win32',
      ),
      'windows',
    );
  });

  it('detects macOS from Macintosh UA', () => {
    assert.equal(
      detectOsFamily(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'MacIntel',
      ),
      'macos',
    );
  });

  it('treats iPad as macOS for desktop download targeting', () => {
    assert.equal(
      detectOsFamily('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'),
      'macos',
    );
  });

  it('returns other for Linux', () => {
    assert.equal(
      detectOsFamily('Mozilla/5.0 (X11; Linux x86_64)', 'Linux x86_64'),
      'other',
    );
  });
});

describe('detectMacArch / resolveDefaultTarget', () => {
  it('uses Intel UA as x64 and selects the Intel build', () => {
    assert.equal(
      detectMacArch('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'),
      'x64',
    );
    assert.equal(resolveDefaultTarget('macos', 'x64'), 'macos-intel');
  });

  it('uses UA-CH architecture for Apple Silicon', () => {
    assert.equal(detectMacArch('Macintosh', 'arm'), 'arm');
    assert.equal(resolveDefaultTarget('macos', 'arm'), 'macos-arm');
  });

  it('defaults unknown Mac / other OS to Apple Silicon', () => {
    assert.equal(detectMacArch('Macintosh'), 'unknown');
    assert.equal(resolveDefaultTarget('macos', 'unknown'), 'macos-arm');
    assert.equal(resolveDefaultTarget('other'), 'macos-arm');
  });

  it('selects Windows regardless of Mac arch', () => {
    assert.equal(resolveDefaultTarget('windows', 'arm'), 'windows');
  });
});

describe('release asset matching', () => {
  it('skips drafts when picking the latest published release', () => {
    const latest = pickLatestPublishedRelease([
      { draft: true, tag_name: 'v9' },
      { draft: false, tag_name: 'v8' },
    ]);
    assert.equal(latest?.tag_name, 'v8');
  });

  it('picks the highest semver tag even when the list is unordered', () => {
    const latest = pickLatestPublishedRelease([
      { tag_name: 'v0.1.0' },
      { tag_name: 'v0.1.6' },
      { tag_name: 'v0.1.5' },
    ]);
    assert.equal(latest?.tag_name, 'v0.1.6');
  });

  it('prefers a newer tag over an older one listed first', () => {
    const latest = pickLatestPublishedRelease([
      {
        tag_name: 'v0.1.3',
        created_at: '2026-08-31T12:00:00Z',
      },
      {
        tag_name: 'v0.1.6',
        created_at: '2026-08-28T00:00:00Z',
      },
    ]);
    assert.equal(latest?.tag_name, 'v0.1.6');
  });

  it('breaks equal tags with the later created_at', () => {
    const latest = pickLatestPublishedRelease([
      {
        tag_name: 'v0.1.6',
        created_at: '2026-08-28T00:00:00Z',
      },
      {
        tag_name: 'v0.1.6',
        created_at: '2026-08-29T00:00:00Z',
      },
    ]);
    assert.equal(latest?.created_at, '2026-08-29T00:00:00Z');
  });

  it('prefers a stable tag over an earlier prerelease of the same version', () => {
    const latest = pickLatestPublishedRelease([
      { tag_name: 'v0.1.1-beta.12' },
      { tag_name: 'v0.1.1' },
    ]);
    assert.equal(latest?.tag_name, 'v0.1.1');
  });

  it('prefers NSIS Setup exe and architecture-specific DMGs', () => {
    assert.equal(
      matchReleaseAsset(assets, 'windows'),
      'https://example.test/setup.exe',
    );
    assert.equal(
      matchReleaseAsset(assets, 'macos-arm'),
      'https://example.test/arm64.dmg',
    );
    assert.equal(
      matchReleaseAsset(assets, 'macos-intel'),
      'https://example.test/x64.dmg',
    );
  });

  it('falls back to a generic dmg when x64 is missing', () => {
    assert.equal(
      matchReleaseAsset(
        [
          {
            name: 'Juejin Usage-1.0.0.dmg',
            browser_download_url: 'https://example.test/generic.dmg',
          },
        ],
        'macos-intel',
      ),
      'https://example.test/generic.dmg',
    );
  });

  it('matches Gitee dotted installer names', () => {
    const giteeAssets: ReleaseAsset[] = [
      {
        name: 'Juejin.Usage-0.1.1-beta.12-arm64.dmg',
        browser_download_url: 'https://gitee.test/arm64.dmg',
      },
      {
        name: 'Juejin.Usage-0.1.1-beta.12.dmg',
        browser_download_url: 'https://gitee.test/intel.dmg',
      },
      {
        name: 'Juejin.Usage.Setup.0.1.1-beta.12.exe',
        browser_download_url: 'https://gitee.test/setup.exe',
      },
      {
        name: 'Juejin.Usage.0.1.1-beta.12.exe',
        browser_download_url: 'https://gitee.test/portable.exe',
      },
    ];
    assert.equal(matchReleaseAsset(giteeAssets, 'macos-arm'), 'https://gitee.test/arm64.dmg');
    assert.equal(matchReleaseAsset(giteeAssets, 'macos-intel'), 'https://gitee.test/intel.dmg');
    assert.equal(matchReleaseAsset(giteeAssets, 'windows'), 'https://gitee.test/setup.exe');
  });
});

describe('release source selection', () => {
  it('prefers Gitee when it has installers', () => {
    const gitee = toDesktopReleaseAssets('gitee', {
      tag_name: 'v1',
      assets: [
        {
          name: 'Juejin.Usage-1.0.0-arm64.dmg',
          browser_download_url: 'https://gitee.test/app.dmg',
        },
      ],
    });
    const github = toDesktopReleaseAssets('github', {
      tag_name: 'v1',
      assets: [
        {
          name: 'Juejin Usage-1.0.0-arm64.dmg',
          browser_download_url: 'https://github.test/app.dmg',
        },
      ],
    });
    assert.equal(selectReleaseSource(gitee, github).source, 'gitee');
    assert.equal(fallbackReleasePage('gitee'), 'https://gitee.com/juejin-cn/juejin-usage/releases');
  });

  it('falls back to GitHub when Gitee has no installers', () => {
    const gitee = toDesktopReleaseAssets('gitee', {
      tag_name: 'v1',
      assets: [{ name: 'latest.yml', browser_download_url: 'https://gitee.test/latest.yml' }],
    });
    const github = toDesktopReleaseAssets('github', {
      tag_name: 'v1',
      assets: [
        {
          name: 'Juejin Usage Setup 1.0.0.exe',
          browser_download_url: 'https://github.test/setup.exe',
        },
      ],
    });
    assert.equal(hasInstallerAssets(gitee.assets), false);
    assert.equal(selectReleaseSource(gitee, github).source, 'github');
    assert.equal(fallbackReleasePage('github'), 'https://github.com/juejin-cn/juejin-usage/releases');
  });

  it('treats Gitee releases without draft as published', () => {
    const latest = pickLatestPublishedRelease<{
      tag_name: string;
      draft?: boolean;
      prerelease?: boolean;
    }>([{ tag_name: 'v1', prerelease: false }]);
    assert.equal(latest?.tag_name, 'v1');
  });
});
