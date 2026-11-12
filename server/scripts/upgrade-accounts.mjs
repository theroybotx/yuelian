// Bounded upgrade of the existing deployment. Default is read-only inspection.
// This script never seeds business records or drops/recreates a schema.
import {readFile,mkdir,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {homedir,userInfo} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import pg from 'pg';
import {seedMockAccounts,personas} from './mock-data.mjs';
const directory=dirname(fileURLToPath(import.meta.url)),owner='yuelian_security_owner';
const state=join(homedir(),'.local/state/yuelian-security');
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

// Includes columns/defaults, constraints, indexes, policies, triggers, owners,
// table/column grants and complete function definitions. No row data is read.
export async function captureSchema(c){
 const schemas=(await c.query("SELECT nspname AS name,pg_get_userbyid(nspowner) AS owner,nspacl::text AS acl FROM pg_namespace WHERE nspname IN ('app','private') ORDER BY nspname")).rows;
 const tables=(await c.query("SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls,c.relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('app','private') AND c.relkind IN ('r','p','v','m','S','f') ORDER BY n.nspname,c.relname")).rows;
 for(const t of tables){const target=t.schema+'.'+t.name;
  t.columns=(await c.query("SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required,pg_get_expr(d.adbin,d.adrelid) AS default,a.attidentity AS identity,a.attgenerated AS generated,a.attacl::text AS acl FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",[target])).rows;
  t.constraints=(await c.query('SELECT conname AS name,contype AS type,convalidated AS validated,pg_get_constraintdef(oid,true) AS definition FROM pg_constraint WHERE conrelid=$1::regclass ORDER BY conname',[target])).rows;
  t.indexes=(await c.query('SELECT ci.relname AS name,pg_get_indexdef(i.indexrelid) AS definition,i.indisvalid AS valid,i.indisready AS ready FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid WHERE i.indrelid=$1::regclass ORDER BY ci.relname',[target])).rows;
  t.triggers=(await c.query('SELECT tgname AS name,tgenabled AS enabled,pg_get_triggerdef(oid,true) AS definition FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal ORDER BY tgname',[target])).rows;
  t.policies=(await c.query('SELECT polname AS name,polcmd AS command,polpermissive AS permissive,ARRAY(SELECT pg_get_userbyid(r) FROM unnest(polroles) AS r ORDER BY r) AS roles,pg_get_expr(polqual,polrelid) AS using,pg_get_expr(polwithcheck,polrelid) AS check FROM pg_policy WHERE polrelid=$1::regclass ORDER BY polname',[target])).rows;
 }
 const functions=(await c.query("SELECT n.nspname AS schema,p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_userbyid(p.proowner) AS owner,p.proacl::text AS acl,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('app','private') ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)")).rows;
 return {schemas,tables,functions};
}
async function businessState(c){
 const result={};for(const name of ['workspaces','memberships','records','plans','invitations','audit']){
  // 005 legitimately revokes legacy pending invitations; 006 adds a null date.
  const ignored=name==='plans'?['committed_at']:name==='invitations'?['recipient_account_id','revoked_at']:[];
  const rows=(await c.query(`SELECT (to_jsonb(t)-$1::text[])::text AS value FROM app.${name} t ORDER BY (to_jsonb(t)-$1::text[])::text`,[ignored])).rows;
  const digest=createHash('sha256');for(const r of rows)digest.update(r.value+'\n');result[name]={count:rows.length,digest:digest.digest('hex')};
 }return result;
}
function migrationBody(text){const trimmed=text.trim();return trimmed.startsWith('BEGIN;')?trimmed.replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,''):trimmed;}
export async function main(args=process.argv.slice(2)){
 const {values}=parseArgs({args,options:{database:{type:'string'},'rehearsal-database':{type:'string'},apply:{type:'boolean',default:false},'access-file':{type:'string'},report:{type:'string'}}});
 if(!!values.database===!!values['rehearsal-database'])throw Error('Specify exactly one --database or --rehearsal-database.');
 if(values.database&&values.database!=='yuelian_security')throw Error('Production database must match yuelian_security exactly.');
 const database=values.database||values['rehearsal-database'];
 if(values['rehearsal-database']&&!/^yuelian_upgrade_rehearsal_[a-z0-9_]+$/.test(database))throw Error('Rehearsal requires a new yuelian_upgrade_rehearsal_* database.');
 const reference=JSON.parse(await readFile(join(directory,'upgrade-accounts-schema.json'),'utf8'));
 const migrations={};for(const [number,name]of Object.entries(reference.migrations)){const sql=await readFile(join(directory,'../migrations',name.file),'utf8');if(hash(sql)!==name.sha256)throw Error('Migration source differs from the reviewed schema reference: '+number);migrations[number]=sql;}
 const accessFile=values['access-file']||join(state,'mock-access.json'),accessStat=await stat(accessFile);
 if(accessStat.mode&0o077)throw Error('Mock controller configuration must have private file permissions.');
 const {controllerId}=JSON.parse(await readFile(accessFile,'utf8'));
 if(typeof controllerId!=='string'||!controllerId||controllerId.length>200||controllerId.startsWith('mock:'))throw Error('Mock controller configuration is invalid.');
 const c=new pg.Client({host:'/tmp',user:process.env.YUELIAN_MIGRATION_ADMIN||userInfo().username,database,password:undefined,application_name:'yuelian-bounded-account-upgrade',statement_timeout:30000,connectionTimeoutMillis:5000});
 let transaction=false;const report={at:new Date().toISOString(),database,mode:values.apply?'apply':'inspect',production:database==='yuelian_security',applied:[],businessSeedCalled:false};
 try{await c.connect();const actual=(await c.query('SELECT current_database() AS name,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()')).rows[0];if(actual.name!==database||actual.owner!==owner)throw Error('Database identity/owner mismatch; no changes made.');
  const runtime=(await c.query("SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,pg_has_role(rolname,'yuelian_security_owner','MEMBER') AS is_owner_member FROM pg_roles WHERE rolname='yuelian_runtime'")).rows[0];if(!runtime||Object.values(runtime).some(Boolean))throw Error('Runtime role is missing or has elevated privileges.');
  await c.query(values.apply?'BEGIN':'BEGIN READ ONLY');transaction=true;await c.query('SET LOCAL lock_timeout=\'5s\'');await c.query('SET LOCAL ROLE yuelian_security_owner');
  if(values.apply){await c.query("SELECT pg_advisory_xact_lock(hashtextextended('yuelian-account-upgrade-005-006',0))");await c.query('LOCK TABLE app.workspaces,app.memberships,app.records,app.plans,app.invitations,app.audit IN SHARE ROW EXCLUSIVE MODE');}
  const beforeSchema=await captureSchema(c);const version=Object.keys(reference.states).find(v=>same(beforeSchema,reference.states[v]));
  if(!version)throw Error('Schema does not exactly match reviewed migration 004, 005 or 006; partial or unexpected schema rejected.');
  report.beforeVersion=Number(version);report.schemaBefore=hash(JSON.stringify(beforeSchema));report.businessBefore=await businessState(c);
  report.legacyPendingInvitations=Number((await c.query('SELECT count(*) FROM app.invitations WHERE accepted_at IS NULL AND revoked_at IS NULL')).rows[0].count);
  const identities=[controllerId,...personas.map(p=>p.id)];const present=(await c.query('SELECT DISTINCT user_id FROM app.memberships WHERE user_id=ANY($1::text[])',[identities])).rows;
  if(present.length!==7)throw Error('The existing business data does not contain all seven configured mock members; do not seed or replace business data.');
  if(!(await c.query("SELECT 1 FROM app.memberships m JOIN app.workspaces w ON w.id=m.workspace_id WHERE m.user_id=$1 AND m.role='owner' AND m.active AND w.created_by=$1 LIMIT 1",[controllerId])).rowCount)throw Error('Configured controller does not own existing teaching data.');
  report.accountsBefore=Number(version)>=5?Number((await c.query('SELECT count(*) FROM private.accounts')).rows[0].count):0;
  if(values.apply){
   if(Number(version)<5){await c.query(migrationBody(migrations['005']));report.applied.push('005');}
   if(Number(version)<6){await c.query(migrationBody(migrations['006']));report.applied.push('006');}
   await seedMockAccounts(c,controllerId);
   const afterSchema=await captureSchema(c);if(!same(afterSchema,reference.states['006']))throw Error('Post-upgrade schema mismatch; transaction will be rolled back.');
   report.schemaAfter=hash(JSON.stringify(afterSchema));report.businessAfter=await businessState(c);
   if(!same(report.businessBefore,report.businessAfter))throw Error('Existing business data changed unexpectedly; transaction will be rolled back.');
   const accounts=(await c.query('SELECT id,username,registration_role,login_kind,active FROM private.accounts WHERE id=ANY($1::text[])',[identities])).rows;
   if(accounts.length!==7||accounts.some(a=>!a.active||a.login_kind!=='test')||accounts.some(a=>{const p=a.id===controllerId?{key:'zhou',role:'coach'}:personas.find(p=>p.id===a.id);return a.username!=='demo-'+p.key||a.registration_role!==(p.role==='coach'?'coach':'student');}))throw Error('Mock account validation failed; transaction will be rolled back.');
   report.accountsAfter=Number((await c.query('SELECT count(*) FROM private.accounts')).rows[0].count);report.mockAccountsVerified=7;
   if(Number(version)<6&&Number((await c.query('SELECT count(*) FROM app.plans WHERE committed_at IS NOT NULL')).rows[0].count)!==0)throw Error('Historical plan dates must remain unknown.');
   if(Number(version)<5&&Number((await c.query('SELECT count(*) FROM app.invitations WHERE accepted_at IS NULL AND revoked_at IS NULL')).rows[0].count)!==0)throw Error('Legacy invitations were not fully revoked.');
   await c.query('COMMIT');transaction=false;report.status='committed';
  }else{await c.query('ROLLBACK');transaction=false;report.status='read_only_check_passed';report.wouldApply=['005','006'].filter(v=>Number(v)>Number(version));}
 }catch(error){if(transaction)await c.query('ROLLBACK').catch(()=>{});report.status='rejected';report.error=error.message;throw Object.assign(Error(error.message),{upgradeReport:report});}
 finally{await c.end();const destination=values.report||join(state,'upgrades',`accounts-${report.at.replace(/[:.]/g,'-')}.json`);await mkdir(dirname(destination),{recursive:true,mode:0o700});await writeFile(destination,JSON.stringify(report,null,2),{mode:0o600});console.info(JSON.stringify({event:'account_upgrade',status:report.status,database,report:destination,applied:report.applied,mockAccounts:report.mockAccountsVerified||0}));}
 return report;
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)main().catch(error=>{console.error(JSON.stringify({event:'account_upgrade_failed',error:error.message}));process.exitCode=1;});
