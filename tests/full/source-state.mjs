import {readdirSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
export function sourceState(){
 const paths=[];
 function visit(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const path=dir+'/'+e.name;if(e.isDirectory()){if(e.name!=='node_modules')visit(path);}else if(/\.(?:mjs|js|ts|tsx|sql|css|html)$/.test(e.name))paths.push(path);}}
 for(const dir of ['app','lib','public','server/src','server/shared','server/migrations','frontend','worker','cloudflare'])visit(dir);
 const hash=createHash('sha256'),backend=createHash('sha256');for(const path of paths.sort()){const bytes=readFileSync(path);hash.update(path+'\n').update(bytes);if(path.startsWith('server/')||path.startsWith('lib/'))backend.update(path+'\n').update(bytes);}
 return {commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),implementationDigest:hash.digest('hex'),backendDigest:backend.digest('hex'),files:paths.length};
}
