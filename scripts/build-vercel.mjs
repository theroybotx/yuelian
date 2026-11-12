import {mkdir,readFile,writeFile,copyFile,readdir,lstat} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const output=path.join(root,'.vercel/output'),fn=path.join(output,'functions/gateway.func');
// Refuse overwriting an unknown output. Build in a fresh checkout or move a
// prior build aside; no custom destination or recursive deletion is accepted.
await mkdir(output,{recursive:true});
await mkdir(path.dirname(fn),{recursive:true});
await mkdir(fn);
const manifest={},digests={};
async function asset(source,name){
 if((await lstat(source)).isSymbolicLink())throw Error('Symlink asset refused');
 if(!/^[a-zA-Z0-9_./-]+$/.test(name)||name.split('/').some(x=>x.startsWith('.')))throw Error('Unexpected asset path');
 const to=path.join(fn,'assets',name);await mkdir(path.dirname(to),{recursive:true});await copyFile(source,to);
 manifest['/'+name]=name;
}
async function publicFiles(dir,prefix=''){
 for(const entry of await readdir(dir,{withFileTypes:true})){
  if(entry.isSymbolicLink()||entry.name.startsWith('.'))throw Error('Unexpected public asset');
  const name=prefix+entry.name,source=path.join(dir,entry.name);
  if(entry.isDirectory())await publicFiles(source,name+'/');
  else {if(!/\.(js|css|svg|png|jpg|jpeg|webp|ico|woff2?|ttf|txt|json)$/.test(name))throw Error('Unexpected public type');await asset(source,name);}
 }
}
await publicFiles(path.join(root,'public'));
await asset(path.join(root,'frontend/index.html'),'index.html');
await asset(path.join(root,'cloudflare/login.html'),'login.html');
await copyFile(path.join(root,'vercel/handler.mjs'),path.join(fn,'index.mjs'));
await writeFile(path.join(fn,'worker.mjs'),stripTypeScriptTypes(await readFile(path.join(root,'cloudflare/worker.ts'),'utf8')));
await writeFile(path.join(fn,'assets.json'),JSON.stringify(manifest));
await writeFile(path.join(fn,'.vc-config.json'),JSON.stringify({runtime:'nodejs24.x',handler:'index.mjs',launcherType:'Nodejs',maxDuration:90}));
await writeFile(path.join(output,'config.json'),JSON.stringify({version:3,routes:[{src:'/(.*)',dest:'/gateway'}]}));
async function hashes(dir,prefix=''){
 for(const e of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const name=prefix+e.name;
  if(e.isDirectory())await hashes(path.join(dir,e.name),name+'/');
  else digests[name]=createHash('sha256').update(await readFile(path.join(dir,e.name))).digest('hex');
 }
}
await hashes(output);
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
await writeFile(path.join(output,'build-manifest.json'),JSON.stringify({sourceCommit,node:process.version,assets:Object.keys(manifest).length,files:digests},null,2)+'\n');
console.log(JSON.stringify({sourceCommit,assets:Object.keys(manifest).length,output}));
