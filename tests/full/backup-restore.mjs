// Restore an encrypted pre-deployment backup into a fresh isolated database.
// Never restores over the running development database.
import {readFileSync,unlinkSync,mkdirSync,writeFileSync} from 'node:fs';
import {createDecipheriv,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import pg from '../../server/node_modules/pg/lib/index.js';
const source=process.argv[2];if(!source||!source.endsWith('.pgdump.aesgcm'))throw Error('Encrypted backup path required');
const data=readFileSync(source),key=readFileSync('/Users/jarvisxiao/.local/state/yuelian-security/backup.key');
if(data.subarray(0,5).toString()!=='YLBK1'||key.length!==32)throw Error('Invalid encrypted backup');
const decipher=createDecipheriv('aes-256-gcm',key,data.subarray(5,17));decipher.setAuthTag(data.subarray(-16));const plain=Buffer.concat([decipher.update(data.subarray(17,-16)),decipher.final()]);
const name='yuelian_acceptance_restore_'+randomUUID().replaceAll('-','').slice(0,12),file='/tmp/'+name+'.pgdump';writeFileSync(file,plain,{mode:0o600,flag:'wx'});plain.fill(0);
const admin=new pg.Client({host:'/tmp',user:'jarvisxiao',database:'postgres'});await admin.connect();await admin.query(`CREATE DATABASE ${name} OWNER yuelian_security_owner`);await admin.end();
try{execFileSync('/usr/local/bin/pg_restore',['--exit-on-error','--dbname='+name,file],{env:{...process.env,PGHOST:'/tmp',PGUSER:'jarvisxiao'},stdio:['ignore','pipe','pipe']});}finally{unlinkSync(file);}
const db=new pg.Client({host:'/tmp',user:'jarvisxiao',database:name});await db.connect();const tables=(await db.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='r' ORDER BY c.relname")).rows;const rows=(await db.query('SELECT kind,count(*)::int n FROM app.records GROUP BY kind ORDER BY kind')).rows;const counts=(await db.query('SELECT (SELECT count(*)::int FROM app.workspaces) workspaces,(SELECT count(*)::int FROM app.memberships) memberships')).rows[0];if(!tables.every(t=>t.relrowsecurity)||counts.workspaces!==3)throw Error('Restore verification failed');const role=(await db.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='yuelian_runtime'")).rows[0];if(role.rolsuper||role.rolbypassrls)throw Error('Unsafe runtime role');await db.query('SET ROLE yuelian_runtime');if((await db.query('SELECT count(*)::int n FROM app.records')).rows[0].n!==0)throw Error('RLS did not isolate anonymous access');await db.end();
mkdirSync('output/full-20261101/backup',{recursive:true});writeFileSync('output/full-20261101/backup/results.json',JSON.stringify({at:new Date().toISOString(),source,database:name,status:'passed',encryptedBackupAuthenticated:true,restored:true,plaintextRemoved:true,productionDataTouched:false,tables,rows,counts},null,2));console.log(JSON.stringify({status:'passed',database:name,plaintextRemoved:true,evidence:'output/full-20261101/backup/results.json'}));
