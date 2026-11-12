// Local administration only. No public HTTP endpoint, password reset, seeding,
// implicit database target, or changes to an existing account are provided.
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {readFile,open,mkdir,stat,realpath,unlink} from 'node:fs/promises';
import {basename,dirname,isAbsolute,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import pg from 'pg';
import {username,password,hashPassword,reservedUsername} from '../src/auth-crypto.mjs';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const owner='yuelian_security_owner',runtime='yuelian_runtime';
export const DEFAULT_ACCOUNTS=Object.freeze([
 {username:'trial-roy',name:'Roy（试用学员）',role:'student'},
 ...[1,2,3].map(i=>({username:`trial-coach-0${i}`,name:`试用教练0${i}`,role:'coach'})),
 ...[1,2,3,4].map(i=>({username:`trial-student-0${i}`,name:`试用学员0${i}`,role:'student'})),
]);
class ProvisionError extends Error {constructor(code,message){super(message);this.code=code;}}
const reject=(code,message)=>{throw new ProvisionError(code,message);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed)=>Object.keys(value).every(key=>allowed.includes(key));
export const accountId=name=>'account:trial:v1:'+createHash('sha256').update(name).digest('hex').slice(0,32);
export function validateManifest(value){
 if(!object(value)||!keys(value,['accounts'])||!Array.isArray(value.accounts)||!value.accounts.length||value.accounts.length>100)reject('INVALID_MANIFEST','Manifest must contain 1–100 accounts and no password fields.');
 const rows=value.accounts.map(row=>{
  if(!object(row)||!keys(row,['username','name','role'])||!username.safeParse(row.username).success||typeof row.name!=='string'||!row.name.trim()||row.name.trim().length>80||!['coach','student'].includes(row.role))reject('INVALID_MANIFEST','Each account requires a valid username, name and coach/student role only.');
  const name=username.parse(row.username);if(reservedUsername(name))reject('RESERVED_USERNAME','System and demo usernames cannot be provisioned.');
  return {username:name,name:row.name.trim(),role:row.role};
 });
 if(new Set(rows.map(row=>row.username)).size!==rows.length)reject('DUPLICATE_USERNAME','The manifest contains duplicate normalized usernames.');
 return rows;
}
function parseJSON(raw,code){try{return JSON.parse(raw);}catch{reject(code,'Input must be valid JSON; its contents were not logged.');}}
async function readPasswords(accounts){
 if(process.stdin.isTTY)reject('PASSWORD_STDIN_REQUIRED','Pipe password JSON to standard input; do not put passwords in arguments.');
 let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>65536)reject('PASSWORD_INPUT_TOO_LARGE','Password JSON exceeds 64 KiB.');}
 const input=parseJSON(raw,'INVALID_PASSWORD_INPUT');
 if(!object(input)||!keys(input,['passwords'])||!object(input.passwords))reject('INVALID_PASSWORD_INPUT','Standard input requires a passwords object only.');
 const allowed=new Set(accounts.map(row=>row.username));
 for(const [name,value]of Object.entries(input.passwords))if(!allowed.has(name)||!password.safeParse(value).success)reject('INVALID_PASSWORD_INPUT','Passwords must belong to this manifest and meet the existing password policy.');
 return input.passwords;
}
async function preflight(c,database){
 const actual=(await c.query(`SELECT current_database() AS database,current_user AS role,
 pg_get_userbyid(d.datdba) AS owner,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
 pg_has_role(current_user,$1,'MEMBER') AS owner_member,
 EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON t.relnamespace=n.oid WHERE n.nspname IN ('app','private') AND t.relowner=r.oid) AS owns_tables
 FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`,[owner])).rows[0];
 if(actual?.database!==database||actual.owner!==owner)reject('WRONG_DATABASE','Database identity or owner does not match the reviewed target.');
 if(actual.role!==runtime||['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','owner_member','owns_tables'].some(key=>actual[key]))reject('PRIVILEGED_ROLE','Provisioning requires the existing non-owner yuelian_runtime role.');
 const schema=(await c.query("SELECT nspname,pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname IN ('app','private')")).rows;
 if(schema.length!==2||schema.some(row=>row.owner!==owner))reject('WRONG_SCHEMA','Expected application schemas are missing or have an unexpected owner.');
 const objects=(await c.query("SELECT to_regclass('private.accounts') AS accounts,to_regprocedure('private.create_workspace(uuid,text,text)') AS create_workspace")).rows[0];
 if(!objects.accounts||!objects.create_workspace)reject('WRONG_SCHEMA','Account migrations and the existing workspace function must already be installed.');
}
async function credentialsFile(destination){
 if(!destination||!isAbsolute(destination))reject('PRIVATE_OUTPUT_REQUIRED','New accounts require an absolute --credential-output path outside the project.');
 const parent=dirname(destination);await mkdir(parent,{recursive:true,mode:0o700});
 const canonicalParent=await realpath(parent),canonicalProject=await realpath(project),inside=relative(canonicalProject,canonicalParent);
 if(!inside||inside!=='..'&&!inside.startsWith('../')&&!isAbsolute(inside))reject('OUTPUT_IN_PROJECT','Credentials must be stored outside the project and Git.');
 for(let directory=canonicalParent;;directory=dirname(directory)){
  try{await stat(resolve(directory,'.git'));reject('OUTPUT_IN_GIT','Credentials must not be stored inside a Git repository.');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(directory===dirname(directory))break;
 }
 const info=await stat(canonicalParent);if(info.uid!==process.getuid()||info.mode&0o077)reject('OUTPUT_DIRECTORY_NOT_PRIVATE','Credential parent directory must belong to the current user with mode 0700.');
 const path=resolve(canonicalParent,basename(destination));
 let file;try{file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch(error){if(error.code==='EEXIST'||error.code==='ELOOP')reject('OUTPUT_EXISTS','Credential output already exists; it will not be overwritten.');throw error;}
 return {path,file};
}
export async function main(args=process.argv.slice(2)){
 let values;try{({values}=parseArgs({args,options:{database:{type:'string'},file:{type:'string'},apply:{type:'boolean',default:false},'passwords-stdin':{type:'boolean',default:false},'credential-output':{type:'string'}}}));}catch{reject('INVALID_ARGUMENTS','Use --database, optional --file, --apply, --passwords-stdin and --credential-output only.');}
 const database=values.database;
 if(database!=='yuelian_security'&&!/^yuelian_trial_rehearsal_[a-z0-9_]+$/.test(database||''))reject('INVALID_DATABASE','Explicit --database must be yuelian_security or an isolated yuelian_trial_rehearsal_* database.');
 const manifest=values.file?parseJSON(await readFile(values.file,'utf8'),'INVALID_MANIFEST'):{accounts:DEFAULT_ACCOUNTS};
 const accounts=validateManifest(manifest),passwords=values['passwords-stdin']?await readPasswords(accounts):{};
 const c=new pg.Client({database,user:runtime,host:process.env.PGHOST||'/tmp',connectionTimeoutMillis:5000,statement_timeout:10000,application_name:'yuelian-trial-provision'});
 const report={event:'trial_accounts',database,mode:values.apply?'apply':'dry-run',role:runtime,created:0,existing:0,accounts:[],credentialsWritten:false};
 let transaction=false,delivery=null,commitAttempted=false;
 try{
  await c.connect();await preflight(c,database);await c.query(values.apply?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');transaction=true;await c.query("SET LOCAL lock_timeout='5s'");
  if(values.apply)for(const name of accounts.map(row=>row.username).sort())await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['yuelian-trial-provision:'+name]);
  const existing=(await c.query('SELECT id,username,name,registration_role,login_kind,active FROM private.accounts WHERE username=ANY($1::text[]) OR id=ANY($2::text[])'+(values.apply?' FOR SHARE':''),[accounts.map(row=>row.username),accounts.map(row=>accountId(row.username))])).rows;
  for(const row of accounts){
   const id=accountId(row.username),present=existing.find(item=>item.username===row.username||item.id===id);
   if(present&&(present.id!==id||present.username!==row.username||present.name!==row.name||present.registration_role!==row.role||present.login_kind!=='password'||!present.active))reject('ACCOUNT_CONFLICT','Existing account does not match this provisioned identity/configuration; nothing was overwritten.');
   if(present&&Object.hasOwn(passwords,row.username))reject('PASSWORD_RESET_FORBIDDEN','A password was supplied for an existing account; resets are not supported.');
   if(present&&row.role==='coach'){
    await c.query("SELECT set_config('request.actor',$1,true),set_config('request.workspace','',true)",[id]);
    const workspaces=(await c.query("SELECT w.id FROM app.workspaces w JOIN app.memberships m ON m.workspace_id=w.id WHERE w.created_by=$1 AND m.user_id=$1 AND m.role='owner' AND m.active",[id])).rows;
    if(workspaces.length!==1)reject('TEACHING_PROFILE_CONFLICT','An existing coach must retain exactly one active owned teaching profile; no repair or reset was attempted.');
   }
   report.accounts.push({...row,id,status:present?'existing':'would-create'});
  }
  report.existing=report.accounts.filter(row=>row.status==='existing').length;
  const pending=report.accounts.filter(row=>row.status==='would-create');
  if(!values.apply){await c.query('ROLLBACK');transaction=false;report.wouldCreate=pending.length;return report;}
  if(pending.length){
   delivery=await credentialsFile(values['credential-output']);const credentials=[];
   for(const row of pending){
    const value=Object.hasOwn(passwords,row.username)?passwords[row.username]:randomBytes(24).toString('base64url'),secret=await hashPassword(value);
    await c.query("INSERT INTO private.accounts(id,username,name,registration_role,login_kind,password_salt,password_hash) VALUES($1,$2,$3,$4,'password',$5,$6)",[row.id,row.username,row.name,row.role,secret.salt,secret.hash]);
    await c.query("SELECT set_config('request.actor',$1,true),set_config('request.workspace','',true)",[row.id]);
    if(row.role==='coach')await c.query('SELECT private.create_workspace($1,$2,$3)',[randomUUID(),row.name,row.name]);
    credentials.push({username:row.username,name:row.name,role:row.role,password:value});row.status='created';
   }
   // Durable delivery precedes COMMIT. If COMMIT loses its connection, preserve
   // this private file and use a dry-run to inspect the database before retrying.
   await delivery.file.writeFile(JSON.stringify({version:1,database,preparedAt:new Date().toISOString(),note:'Prepared before database commit. Verify the CLI success report or rerun dry-run before delivering.',accounts:credentials},null,2)+'\n');await delivery.file.sync();await delivery.file.close();delivery.file=null;
  }
  commitAttempted=true;await c.query('COMMIT');transaction=false;report.created=pending.length;report.credentialsWritten=!!delivery;return report;
 }catch(error){
  if(transaction)await c.query('ROLLBACK').catch(()=>{});
  if(delivery){await delivery.file?.close().catch(()=>{});if(!commitAttempted)await unlink(delivery.path).catch(()=>{});}
  throw error;
 }finally{await c.end().catch(()=>{});}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)main().then(report=>console.log(JSON.stringify(report))).catch(error=>{
 console.error(JSON.stringify({event:'trial_accounts_failed',code:error instanceof ProvisionError?error.code:'PROVISION_FAILED',message:error instanceof ProvisionError?error.message:'Provisioning failed. No credential contents were logged. If commit was interrupted, retain the private credential file and run dry-run before retrying.'}));process.exitCode=1;
});
