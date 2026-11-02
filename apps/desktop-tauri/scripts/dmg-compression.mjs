import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tauri's create-dmg script uses UDZO/zlib-9 and currently exposes no format
// setting. Scope this adapter to that child's final DMG conversion, BEFORE
// Tauri signs the image. Never rewrite an already-signed release artifact.
export function compressionArgs(args, outputDirectory) {
  const format=args.indexOf('-format'), output=args.indexOf('-o');
  if(args[0]!=='convert'||format<0||args[format+1]!=='UDZO'||output<0||!args[output+1]?.endsWith('.dmg'))return args;
  if(!outputDirectory||!existsSync(outputDirectory)||!existsSync(dirname(args[output+1])))return args;
  if(realpathSync(dirname(args[output+1]))!==realpathSync(outputDirectory))return args;
  const next=[];
  for(let i=0;i<args.length;i++) {
    if(args[i]==='-imagekey'&&args[i+1]?.startsWith('zlib-level=')){i++;continue;}
    next.push(i===format+1?'ULMO':args[i]);
  }
  return next;
}

export function dmgEnvironment(env, outputDirectory, enabled=process.platform==='darwin') {
  if(!enabled)return {env,cleanup(){}};
  const directory=mkdtempSync(join(tmpdir(),'jusage-dmg-tools-'));
  const quote=value=>`'${value.replace(/'/g,"'\\''")}'`;
  writeFileSync(join(directory,'hdiutil'),`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} "$@"\n`,{mode:0o755});
  return {
    env:{...env,PATH:`${directory}${delimiter}${env.PATH||''}`,TUD_DMG_OUTPUT_DIR:outputDirectory},
    cleanup(){rmSync(directory,{recursive:true,force:true});},
  };
}

export function verifyDmgCompression(directory) {
  if(!existsSync(directory))return;
  for(const name of readdirSync(directory).filter(name=>name.endsWith('.dmg'))) {
    const info=execFileSync('/usr/bin/hdiutil',['imageinfo','-plist',join(directory,name)],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
    if(!/<key>Format<\/key>\s*<string>ULMO<\/string>/.test(info))throw new Error(`Expected LZMA DMG: ${name}; check Tauri's bundling invocation`);
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  const next=compressionArgs(args,process.env.TUD_DMG_OUTPUT_DIR);
  if(next!==args)console.log('[desktop-tauri:build] Compressing DMG with LZMA before signing');
  const result=spawnSync('/usr/bin/hdiutil',next,{stdio:'inherit'});
  if(result.error)console.error(result.error.message);
  process.exit(result.status??1);
}
