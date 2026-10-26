import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const app=fileURLToPath(new URL('..',import.meta.url));
const cli=fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js',import.meta.url));
// Seal candidate bundles with an ad-hoc signature. This is not Developer ID
// signing or notarization; explicit release credentials take precedence.
const env={...process.env};
if(process.platform==='darwin'&&!env.APPLE_SIGNING_IDENTITY&&!env.APPLE_CERTIFICATE)env.APPLE_SIGNING_IDENTITY='-';
execFileSync(process.execPath,[cli,'build','--features','custom-protocol',...process.argv.slice(2)],{cwd:app,env,stdio:'inherit'});
