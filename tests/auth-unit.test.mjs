import test from 'node:test';
import assert from 'node:assert/strict';
import {username,password,sessionToken,reservedUsername,hashPassword,verifyPassword,newSessionToken,tokenHash,PASSWORD_PARAMETERS} from '../server/src/auth-crypto.mjs';

test('AUTH-14 UNIT-11 username normalization and boundary',()=>{
 assert.equal(username.parse('  Coach.One  '),'coach.one');
 for(const input of ['ab','a'.repeat(33),'中文账号','a b','a\nb','1coach','_coach'])assert.equal(username.safeParse(input).success,false,input);
 for(const input of ['abc','a'.repeat(32),'coach.one-2_x'])assert.equal(username.safeParse(input).success,true,input);
});
test('AUTH-15 UNIT-11 reserved names never overlap ordinary registration',()=>{
 for(const input of ['admin','root','system','support','yuelian','demo','demo-lin','mock_1','demo.test'])assert.equal(reservedUsername(input),true);
 for(const input of ['coach.liu','student-two','demonstration'])assert.equal(reservedUsername(input),false);
});
test('AUTH-16 AUTH-17 UNIT-11 salted scrypt and exact password handling',async()=>{
 const value=' password 23 ',a=await hashPassword(value),b=await hashPassword(value);
 assert.notEqual(a.salt,b.salt);assert.notEqual(a.hash,b.hash);
 assert.deepEqual(PASSWORD_PARAMETERS,{N:32768,r:8,p:1,maxmem:64*1024*1024});
 assert.equal(await verifyPassword(value,a.salt,a.hash),true);
 assert.equal(await verifyPassword(value.trim(),a.salt,a.hash),false);
 assert.equal(await verifyPassword('incorrect-password',a.salt,a.hash),false);
 assert.equal(await verifyPassword(value,'damaged',a.hash),false);
 assert.equal(await verifyPassword(value,a.salt,'plaintext-password'),false);
 assert.equal(await verifyPassword(value,undefined,undefined),false);
 const unicode='正手反手发球截击1234',c=await hashPassword(unicode);assert.equal(await verifyPassword(unicode,c.salt,c.hash),true);
});
test('AUTH-17 UNIT-11 password lengths reject excess before hashing',async()=>{
 for(const input of ['', 'a'.repeat(9),'a'.repeat(129)]){assert.equal(password.safeParse(input).success,false);await assert.rejects(()=>hashPassword(input));}
 for(const input of ['a'.repeat(10),'a'.repeat(128)])assert.equal(password.safeParse(input).success,true);
});
test('AUTH-11 UNIT-11 session tokens are random, fixed length and hashed separately',()=>{
 const values=new Set();for(let n=0;n<100;n++){const token=newSessionToken();assert.equal(sessionToken.safeParse(token).success,true);assert.equal(token.length,43);values.add(token);assert.match(tokenHash(token),/^[a-f0-9]{64}$/);assert.notEqual(tokenHash(token),token);}
 assert.equal(values.size,100);for(const value of ['','a'.repeat(42),'a'.repeat(44),'.'.repeat(43)])assert.equal(sessionToken.safeParse(value).success,false);
});
