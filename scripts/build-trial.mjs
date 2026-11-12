import {mkdir,rm,copyFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),target=join(root,'.cloudflare/assets');
await rm(target,{recursive:true,force:true});
await mkdir(target,{recursive:true});
// Only public assets and two explicit HTML files are eligible for upload.
// No credentials, fixtures, database dumps or test reports enter this directory.
async function copyAssets(source,destination){
 for(const entry of await readdir(source,{withFileTypes:true})){
  if(entry.isSymbolicLink()||entry.name.startsWith('.'))throw Error('Unexpected public asset entry');
  const from=join(source,entry.name),to=join(destination,entry.name);
  if(entry.isDirectory()){await mkdir(to,{recursive:true});await copyAssets(from,to);}
  else{if(!/\.(?:js|css|svg|png|jpg|jpeg|webp|ico|woff2?|ttf|txt|json)$/.test(entry.name))throw Error('Unexpected public file type');await copyFile(from,to);}
 }
}
await copyAssets(join(root,'public'),target);
await copyFile(join(root,'frontend/index.html'),join(target,'index.html'));
await copyFile(join(root,'cloudflare/login.html'),join(target,'login.html'));
console.log(JSON.stringify({assets:target,login:'invitation-only',registration:false}));
