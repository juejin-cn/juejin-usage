import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { buildSync } from 'esbuild';
const root = fileURLToPath(new URL('../../..', import.meta.url));
const app = fileURLToPath(new URL('..', import.meta.url));
let numberBundle;
export function stagePet(ui) {
  // Bundle the actual dashboard component; keep the rest of the dashboard out.
  if (!numberBundle) {
    const result = buildSync({
      entryPoints: [join(root, 'packages/dashboard/src/pet/number-renderer.tsx')],
      bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic',
      target: 'es2022', minify: true, write: false, metafile: true,
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    if (Object.keys(result.metafile.inputs).some(name => /@heroui|recharts/.test(name))) {
      throw new Error('Pet number renderer must not bundle dashboard UI libraries');
    }
    numberBundle = result.outputFiles[0].text;
  }
  writeFileSync(join(ui, 'pet-numbers.js'), numberBundle);
  cpSync(join(root, 'packages/dashboard/node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2'), join(ui, 'pet-number-font.woff2'));
  const catalogSource = ts.createSourceFile('pets.ts', readFileSync(join(root, 'apps/desktop/src/renderer/pets.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const catalog = catalogSource.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(catalogSource) === 'DESKTOP_PETS'));
  if (!catalog) throw new Error('Electron pet appearance catalog is missing');
  writeFileSync(join(ui, 'pet-appearance.js'), ts.transpileModule(catalog.getText(catalogSource), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);

  // Compile the existing Electron atlas/layout helpers rather than forking the
  // frame math or copying the shared React renderer and its dependencies.
  for (const name of ['desktop-pet-layout', 'desktop-pet-sprite', 'desktop-pet-motion', 'dashboard-range']) {
    const source = readFileSync(join(root, 'apps/desktop/src/shared', `${name}.ts`), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    writeFileSync(join(ui, `${name}.js`), code.replace("'./desktop-pet-layout'", "'./desktop-pet-layout.js'"));
  }
  // Stage the actual Electron formatter without its clsx/Tailwind UI imports.
  const formatSource = ts.createSourceFile('utils.ts', readFileSync(join(root, 'apps/desktop/src/renderer/lib/utils.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const names = new Set(['TOKEN_COUNT_UNITS', 'formatCompactTokenCount', 'roundCompactValue']);
  const declarations = formatSource.statements.filter(node =>
    (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) ||
    (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => names.has(item.name.getText(formatSource)))));
  if (declarations.length !== 3) throw new Error('Electron token formatter changed; update pet staging');
  writeFileSync(join(ui, 'pet-format.js'), ts.transpileModule(declarations.map(node => node.getText(formatSource)).join('\n'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
  writeFileSync(join(ui, 'pet-sync-feedback.js'), ts.transpileModule(readFileSync(join(root, 'packages/core/src/pet-sync-feedback.ts'), 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
  for (const file of ['pet.html', 'pet.css', 'pet.js', 'pet-model.mjs']) cpSync(join(app, 'src/pet', file), join(ui, file));
  if (process.platform === 'win32') {
    const html = join(ui, 'pet.html');
    writeFileSync(html, readFileSync(html, 'utf8').replace('class="desktop-pet-root"', 'class="desktop-pet-root desktop-pet-root--win"'));
  }
  cpSync(join(root, 'apps/desktop/src/renderer/pet.css'), join(ui, 'desktop-pet.css'));
  mkdirSync(join(ui, 'pets'), { recursive: true });
  for (const id of ['hawking', 'yoyo', 'click']) cpSync(join(root, `apps/desktop/src/renderer/assets/pets/${id}/${id}-spritesheet.webp`), join(ui, 'pets', `${id}.webp`));
}
