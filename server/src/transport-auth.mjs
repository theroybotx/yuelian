import {createHmac,createHash,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {HttpError,uuid} from './policy.mjs';
import {sessionToken} from './auth-crypto.mjs';

export const STANDALONE_AUDIENCE='standalone:cloudflare-trial';
const hex=z.string().regex(/^[a-f0-9]{64}$/);
const fields={name:z.string().min(1).max(80),emailHash:hex,sessionToken:sessionToken.optional()};
const sitesIdentity=z.object({id:z.string().min(1).max(200).refine(id=>!id.startsWith('standalone:')),...fields}).strict();
const standaloneIdentity=z.object({id:z.literal(STANDALONE_AUDIENCE),...fields,clientKey:hex}).strict();
const denied=()=>new HttpError(401,'请重新登录。','AUTH_REQUIRED');
export const isStandalone=identity=>(identity.platformId||identity.id)===STANDALONE_AUDIENCE;
export const preauthKey=identity=>isStandalone(identity)?'standalone:'+identity.clientKey:'sites:'+identity.id;

export function createTransportAuthenticator({sitesSecret,standaloneSecret}){
 if(typeof sitesSecret!=='string'||sitesSecret.length<43)throw new Error('A dedicated Sites bridge secret of at least 32 random bytes is required.');
 if(standaloneSecret!==undefined&&(typeof standaloneSecret!=='string'||standaloneSecret.length<43||standaloneSecret===sitesSecret))throw new Error('The standalone bridge requires a separate secret of at least 32 random bytes.');
 return (req,raw)=>{
  const header=req.headers['x-yuelian-channel'],channel=header===undefined?'sites':header;
  if(channel!=='sites'&&channel!=='standalone')throw denied();
  const secret=channel==='standalone'?standaloneSecret:sitesSecret;
  if(!secret)throw denied();
  const stamp=req.headers['x-yuelian-time'],nonce=req.headers['x-yuelian-nonce'],encoded=req.headers['x-yuelian-identity'],signature=req.headers['x-yuelian-signature'];
  if(typeof stamp!=='string'||!/^\d{13}$/.test(stamp)||Math.abs(Date.now()-Number(stamp))>120000||typeof encoded!=='string'||encoded.length>4096||typeof signature!=='string'||! /^[a-f0-9]{64}$/.test(signature)||!uuid.safeParse(nonce).success)throw denied();
  // Preserve the Sites canonical payload. Distinct keys bind the optional
  // channel header cryptographically; a browser cannot select another trust root.
  const digest=createHash('sha256').update(raw).digest('hex');
  const expected=createHmac('sha256',secret).update([req.method,req.url,stamp,nonce,encoded,digest].join('\n')).digest();
  const given=Buffer.from(signature,'hex');
  if(given.length!==expected.length||!timingSafeEqual(expected,given))throw denied();
  let parsed;try{parsed=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));}catch{throw denied();}
  const result=(channel==='standalone'?standaloneIdentity:sitesIdentity).safeParse(parsed);
  if(!result.success)throw denied();
  return {...result.data,channel,requestId:nonce};
 };
}
