import {randomBytes,scrypt,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {z} from 'zod';

const derive=promisify(scrypt);
export const PASSWORD_PARAMETERS=Object.freeze({N:32768,r:8,p:1,maxmem:64*1024*1024});
export const username=z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9._-]{2,31}$/);
export const password=z.string().min(10).max(128).refine(value=>Buffer.byteLength(value,'utf8')<=512);
export const sessionToken=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const reservedUsername=value=>/^(?:demo[._-]|mock[._-])/.test(value)||['admin','administrator','root','system','support','yuelian','test','mock','demo'].includes(value);
export const tokenHash=value=>createHash('sha256').update(value).digest('hex');
export const newSessionToken=()=>randomBytes(32).toString('base64url');
export async function hashPassword(value){
 const parsed=password.parse(value),salt=randomBytes(16).toString('hex');
 const hash=await derive(parsed,Buffer.from(salt,'hex'),64,PASSWORD_PARAMETERS);
 return {salt,hash:hash.toString('hex')};
}
export async function verifyPassword(value,salt,stored){
 if(!password.safeParse(value).success)return false;
 const valid=typeof salt==='string'&&/^[a-f0-9]{32}$/.test(salt)&&typeof stored==='string'&&/^[a-f0-9]{128}$/.test(stored);
 // Unknown, inactive and damaged accounts receive the same expensive check.
 const derived=await derive(value,Buffer.from(valid?salt:'0'.repeat(32),'hex'),64,PASSWORD_PARAMETERS);
 return timingSafeEqual(derived,Buffer.from(valid?stored:'0'.repeat(128),'hex'))&&valid;
}
