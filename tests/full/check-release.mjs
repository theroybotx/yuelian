import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {sourceState} from './source-state.mjs';
const root=process.cwd(),out=process.env.YUELIAN_RELEASE_OUTPUT||root+'/output/full-20261101/release';mkdirSync(out,{recursive:true});
const env=readFileSync('/Users/jarvisxiao/.local/state/yuelian-security/runtime.env','utf8');
const secrets=env.split('\n').filter(line=>/^[A-Z_]*(?:SECRET|KEY|PASSWORD)[A-Z_]*=/.test(line)).map(line=>line.slice(line.indexOf('=')+1).replace(/^['"]|['"]$/g,'')).filter(value=>value.length>=16);
const sourceFiles=[...new Set(execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean))];
const assets=[];function visit(path){for(const entry of readdirSync(path,{withFileTypes:true})){const p=path+'/'+entry.name;if(entry.isDirectory())visit(p);else assets.push(p);}}if(existsSync(root+'/dist'))visit(root+'/dist');
const findings=[];for(const file of [...sourceFiles,...assets]){const data=readFileSync(file);for(let i=0;i<secrets.length;i++)if(data.includes(Buffer.from(secrets[i])))findings.push({file,kind:'runtime-secret'});if(/sk-[a-zA-Z0-9_-]{28,}/.test(data.toString('utf8')))findings.push({file,kind:'potential-api-key'});}
// Only tests may mention the forbidden host logout target as a negative check.
for(const file of ['public/app.js','public/login.js','public/workspace-client.js','app/login/route.ts'])if(readFileSync(file,'utf8').includes('signout-with-chatgpt'))findings.push({file,kind:'host-logout-in-product'});
const result={at:new Date().toISOString(),source:sourceState(),sourceFiles:sourceFiles.length,artifactFiles:assets.length,secretKinds:secrets.length,status:findings.length?'failed':'passed',findings};writeFileSync(out+'/scan.json',JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,sourceFiles:result.sourceFiles,artifactFiles:result.artifactFiles,findings}));if(findings.length)process.exitCode=1;
