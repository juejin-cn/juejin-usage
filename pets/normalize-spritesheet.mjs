#!/usr/bin/env node
/**
 * Force a spritesheet image to the Desktop pet atlas size (1536×2288 WebP).
 *
 * Usage:
 *   node pets/normalize-spritesheet.mjs <input> [-o <output>] [--mode stretch]
 *
 * Prefers ImageMagick (`magick`), then ffmpeg+libwebp, then resize→PNG + `cwebp`
 * (ffmpeg or macOS `sips`). Default mode stretches to the exact canvas so the
 * scanner accepts the file; if the source is not already an 8×11 cell atlas,
 * animation frames will look wrong.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const TARGET_WIDTH = 1536;
const TARGET_HEIGHT = 2288;

function usage(exitCode = 1) {
  console.error(`Usage: node pets/normalize-spritesheet.mjs <input.webp|png|...> [-o output.webp] [--mode stretch]

Resizes to ${TARGET_WIDTH}×${TARGET_HEIGHT} WebP for ~/.ai-usage/pets/<id>/spritesheet.webp.

Needs one of:
  - ImageMagick (\`magick\`)
  - ffmpeg with libwebp
  - ffmpeg or macOS \`sips\` plus \`cwebp\`

Default --mode stretch fills the canvas (passes the Desktop scanner).
If the source is not an 8×11 / 192×208 atlas, stretch only satisfies size checks.`);
  process.exit(exitCode);
}

function which(cmd) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
    encoding: 'utf8',
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function ffmpegHasLibwebp() {
  if (!which('ffmpeg')) return false;
  const result = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  const text = `${result.stdout}\n${result.stderr}`;
  return /\blibwebp\b/.test(text);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let input;
  let output;
  let mode = 'stretch';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') usage(0);
    if (arg === '-o' || arg === '--output') {
      output = args[++i];
      if (!output) usage();
      continue;
    }
    if (arg === '--mode') {
      mode = args[++i];
      if (mode !== 'stretch') {
        console.error(`Unsupported --mode "${mode}" (only stretch is implemented).`);
        process.exit(1);
      }
      continue;
    }
    if (arg.startsWith('-')) {
      console.error(`Unknown flag: ${arg}`);
      usage();
    }
    if (input) {
      console.error('Only one input file is allowed.');
      usage();
    }
    input = arg;
  }
  if (!input) usage();
  const resolvedInput = resolve(input);
  const ext = extname(resolvedInput);
  const defaultOutput =
    ext.toLowerCase() === '.webp'
      ? resolvedInput
      : `${ext ? resolvedInput.slice(0, -ext.length) : resolvedInput}.webp`;
  return {
    input: resolvedInput,
    output: resolve(output ?? defaultOutput),
    mode,
  };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${command} failed${detail ? `: ${detail}` : ''}`);
  }
}

function convertWithMagick(input, tempOut) {
  run('magick', [
    input,
    '-resize',
    `${TARGET_WIDTH}x${TARGET_HEIGHT}!`,
    '-quality',
    '85',
    tempOut,
  ]);
}

function convertWithFfmpegWebp(input, tempOut) {
  run('ffmpeg', [
    '-y',
    '-i',
    input,
    '-vf',
    `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}`,
    '-c:v',
    'libwebp',
    '-quality',
    '85',
    '-frames:v',
    '1',
    tempOut,
  ]);
}

function resizeToPng(input, tempPng) {
  if (which('ffmpeg')) {
    run('ffmpeg', [
      '-y',
      '-i',
      input,
      '-vf',
      `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}`,
      '-frames:v',
      '1',
      tempPng,
    ]);
    return;
  }
  if (process.platform === 'darwin' && which('sips')) {
    run('sips', [
      '-z',
      String(TARGET_HEIGHT),
      String(TARGET_WIDTH),
      input,
      '--out',
      tempPng,
    ]);
    return;
  }
  throw new Error('Need ffmpeg or macOS sips to resize before cwebp');
}

function convertWithCwebpPipeline(input, tempOut) {
  const tempPng = tempOut.replace(/\.webp$/i, '.png');
  try {
    resizeToPng(input, tempPng);
    run('cwebp', ['-q', '85', tempPng, '-o', tempOut]);
  } finally {
    if (existsSync(tempPng)) {
      try {
        unlinkSync(tempPng);
      } catch {
        // ignore
      }
    }
  }
}

function pickConverter() {
  if (which('magick')) return { name: 'magick', convert: convertWithMagick };
  if (ffmpegHasLibwebp()) return { name: 'ffmpeg', convert: convertWithFfmpegWebp };
  if (which('cwebp') && (which('ffmpeg') || (process.platform === 'darwin' && which('sips')))) {
    return { name: 'cwebp', convert: convertWithCwebpPipeline };
  }
  return null;
}

function main() {
  const { input, output } = parseArgs(process.argv);
  if (!existsSync(input)) {
    console.error(`Input not found: ${input}`);
    process.exit(1);
  }

  const converter = pickConverter();
  if (!converter) {
    console.error(
      'No usable converter found. Install ImageMagick (`magick`), or ffmpeg with libwebp, or `cwebp` plus ffmpeg/sips.',
    );
    process.exit(1);
  }

  const tempOut = join(
    tmpdir(),
    `jusage-pet-${randomBytes(8).toString('hex')}.webp`,
  );

  try {
    converter.convert(input, tempOut);

    const replaceInPlace = resolve(input) === resolve(output);
    if (replaceInPlace) {
      const backup = `${output}.bak-${randomBytes(4).toString('hex')}`;
      copyFileSync(output, backup);
      try {
        copyFileSync(tempOut, output);
        unlinkSync(tempOut);
        unlinkSync(backup);
      } catch (error) {
        try {
          copyFileSync(backup, output);
          unlinkSync(backup);
        } catch {
          // leave backup if restore also fails
        }
        throw error;
      }
    } else {
      copyFileSync(tempOut, output);
      unlinkSync(tempOut);
    }
  } catch (error) {
    if (existsSync(tempOut)) {
      try {
        unlinkSync(tempOut);
      } catch {
        // ignore cleanup errors
      }
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  console.log(
    `Wrote ${TARGET_WIDTH}×${TARGET_HEIGHT} WebP → ${output} (${converter.name})`,
  );
  console.log(
    'If this was not an 8×11 / 192×208 atlas, re-export the sheet properly; stretch only passes size validation.',
  );
  if (dirname(output).includes('.ai-usage')) {
    console.log('Re-open Settings or click 刷新 to reload the pet catalog.');
  }
}

main();
