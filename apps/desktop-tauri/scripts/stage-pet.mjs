import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const root = fileURLToPath(new URL('../../..', import.meta.url));
const app = fileURLToPath(new URL('..', import.meta.url));
export function stagePet(ui) {
  // Compile the existing Electron atlas/layout helpers rather than forking the
  // frame math or copying the shared React renderer and its dependencies.
  for (const name of ['desktop-pet-layout', 'desktop-pet-sprite', 'dashboard-range']) {
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
  cpSync(join(root, 'apps/desktop/src/renderer/pet.css'), join(ui, 'desktop-pet.css'));
  mkdirSync(join(ui, 'pets'), { recursive: true });
  for (const id of ['hawking', 'yoyo', 'click']) cpSync(join(root, `apps/desktop/src/renderer/assets/pets/${id}/${id}-spritesheet.webp`), join(ui, 'pets', `${id}.webp`));
}
