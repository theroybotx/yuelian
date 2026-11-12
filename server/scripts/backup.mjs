import {createCipheriv,randomBytes} from 'node:crypto';
import {readFile,mkdir,chmod,appendFile,rename,unlink} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
const root=join(homedir(),'.local/state/yuelian-security');
const key=await readFile(join(root,'backup.key'));
if(key.length!==32)throw new Error('Invalid backup key');
const directory=join(root,'backups');await mkdir(directory,{recursive:true,mode:0o700});
const timestamp=new Date().toISOString().replace(/[:.]/g,'-'),target=join(directory,`yuelian-${timestamp}.pgdump.aesgcm`),temp=target+'.partial';
const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),out=createWriteStream(temp,{mode:0o600});
out.write(Buffer.concat([Buffer.from('YLBK1'),iv]));
const child=spawn('/usr/local/bin/pg_dump',['--format=custom','--dbname=yuelian_security'],{stdio:['ignore','pipe','pipe']});
let stderr='';child.stderr.on('data',data=>{if(stderr.length<4000)stderr+=data;});
const exited=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error('Database dump failed')));});
try{await Promise.all([pipeline(child.stdout,cipher,out),exited]);await appendFile(temp,cipher.getAuthTag());await rename(temp,target);await chmod(target,0o600);console.info(JSON.stringify({event:'encrypted_backup_created',file:target,restore_test:'not_run'}));}
catch(error){child.kill();await unlink(temp).catch(()=>{});throw error;}
