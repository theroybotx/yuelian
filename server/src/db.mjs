import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {HttpError} from './policy.mjs';
import {assertBusinessSession} from './auth.mjs';
export const pool=new pg.Pool({max:10,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,statement_timeout:8000});
// pg removes broken idle clients itself. Handle the error event so a database
// restart cannot terminate the HTTP process; never log connection credentials.
export const isDatabaseUnavailable=e=>['57P01','57P02','57P03','53300','ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT'].includes(e?.code)||String(e?.code||'').startsWith('08')||/Connection terminated|connection timeout|timeout exceeded when trying to connect|not currently accepting connections/i.test(e?.message||'');
pool.on('error',()=>console.error(JSON.stringify({event:'database_connection_lost'})));
export async function assertRuntimeRole(){
 const r=await pool.query(`SELECT r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
 EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname IN ('app','private') AND c.relowner=r.oid) AS owns_tables
 FROM pg_roles r WHERE r.rolname=current_user`);
 if(!r.rows[0]||Object.values(r.rows[0]).some(Boolean))throw new Error('Backend requires a non-owner, non-privileged RLS role.');
}
export async function transaction(identity,workspace,fn){
 const c=await pool.connect();let discard=false,connectionError;
 const onError=error=>{discard=true;connectionError=error;};c.on('error',onError);
 try{
  await c.query('BEGIN');
  await assertBusinessSession(c,identity);
  // true means transaction-local. Context disappears on COMMIT and ROLLBACK;
  // pooled connections never keep a previous visitor/workspace identity.
  await c.query("SELECT set_config('request.actor',$1,true),set_config('request.workspace',$2,true),set_config('request.email_hash',$3,true)",[identity.id,workspace||'',identity.emailHash]);
  let member=null;
  if(workspace){
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[workspace]);
   member=(await c.query('SELECT * FROM app.memberships WHERE workspace_id=$1 AND user_id=$2 AND active',[workspace,identity.id])).rows[0];
   if(!member)throw new HttpError(404);
  }
  const value=await fn(c,member);if(connectionError)throw connectionError;await c.query('COMMIT');return value;
 }catch(error){discard=discard||isDatabaseUnavailable(error);try{await c.query('ROLLBACK');}catch{discard=true;}throw error;}
 finally{c.removeListener('error',onError);c.release(discard);}
}
export async function audit(c,identity,workspace,action,outcome,targets=[]){
 await c.query('INSERT INTO app.audit(workspace_id,id,actor_id,action,outcome,targets,request_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[workspace,randomUUID(),identity.id,action,outcome,targets,identity.requestId]);
}
export async function rejected(identity,workspace,action){
 // A revoked/nonmember actor cannot insert a workspace audit row. In that case
 // only opaque request id, outcome and action enter the infrastructure log.
 try{await transaction(identity,workspace,c=>audit(c,identity,workspace,action,'denied'));}catch{}
 console.info(JSON.stringify({event:'access_denied',requestId:identity.requestId,action}));
}
export async function getRecord(c,workspace,id,kind){
 const r=(await c.query('SELECT * FROM app.records WHERE workspace_id=$1 AND id=$2',[workspace,id])).rows[0];
 if(!r||kind&&r.kind!==kind)throw new HttpError(404);return r;
}
export async function insertRecord(c,identity,workspace,r){
 const row=(await c.query(`INSERT INTO app.records(workspace_id,id,kind,student_id,lesson_id,venue_id,owner_user_id,visibility,payload)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[workspace,r.id||randomUUID(),r.kind,r.studentId||null,r.lessonId||null,r.venueId||null,identity.id,r.visibility||'private',r.payload])).rows[0];return row;
}
export async function updateRecord(c,workspace,id,payload){
 const r=await c.query('UPDATE app.records SET payload=$3,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *',[workspace,id,payload]);
 if(r.rowCount!==1)throw new HttpError(404);return r.rows[0];
}
