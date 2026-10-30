import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const app=fileURLToPath(new URL('..',import.meta.url));
execFileSync('cargo',['build','--manifest-path','tools/read-daily/Cargo.toml','--locked','--target-dir','src-tauri/target/read-validation'],{cwd:app,stdio:'inherit'});
const binary=fileURLToPath(new URL(`../src-tauri/target/read-validation/debug/read-daily${process.platform==='win32'?'.exe':''}`,import.meta.url));
execFileSync(process.execPath,[fileURLToPath(new URL('./capture-golden.mjs',import.meta.url)),'--rust-bin',binary],{cwd:app,stdio:'inherit'});
