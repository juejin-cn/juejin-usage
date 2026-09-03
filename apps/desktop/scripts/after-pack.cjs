const { readdir, rm } = require('node:fs/promises');
const path = require('node:path');

const MACOS_SIMPLIFIED_CHINESE_LOCALE = 'zh_CN.lproj';

/**
 * electron-builder 25 only removes locale files from Contents/Resources.
 * Chromium still ships macOS locale bundles under Electron Framework's
 * Resources, so strip unused languages here before the app is signed.
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const appEntry = (await readdir(context.appOutDir, { withFileTypes: true })).find(
    (entry) => entry.isDirectory() && entry.name.endsWith('.app'),
  );

  if (!appEntry) {
    throw new Error(`Unable to find packaged macOS app in ${context.appOutDir}`);
  }

  const localesDir = path.join(
    context.appOutDir,
    appEntry.name,
    'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources',
  );
  const entries = await readdir(localesDir, { withFileTypes: true });

  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name.endsWith('.lproj') &&
          entry.name !== MACOS_SIMPLIFIED_CHINESE_LOCALE,
      )
      .map((entry) => rm(path.join(localesDir, entry.name), { recursive: true, force: true })),
  );
};
