import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const root = fileURLToPath(new URL('../../..', import.meta.url));
const app = fileURLToPath(new URL('..', import.meta.url));
export function stagePet(ui) {
  // Compile the existing Electron atlas/layout helpers rather than forking the
  // frame math or copying the shared React renderer and its dependencies.
  for (const name of ['desktop-pet-layout', 'desktop-pet-sprite']) {
    const source = readFileSync(join(root, 'apps/desktop/src/shared', `${name}.ts`), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    writeFileSync(join(ui, `${name}.js`), code.replace("'./desktop-pet-layout'", "'./desktop-pet-layout.js'"));
  }
  for (const file of ['pet.html', 'pet.css', 'pet.js', 'pet-model.mjs']) cpSync(join(app, 'src/pet', file), join(ui, file));
  mkdirSync(join(ui, 'pets'), { recursive: true });
  for (const id of ['hawking', 'yoyo', 'click']) cpSync(join(root, `apps/desktop/src/renderer/assets/pets/${id}/${id}-spritesheet.webp`), join(ui, 'pets', `${id}.webp`));
}
