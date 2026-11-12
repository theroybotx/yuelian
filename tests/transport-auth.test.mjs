import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash,createHmac} from 'node:crypto';
import {createTransportAuthenticator,STANDALONE_AUDIENCE,preauthKey} from '../server/src/transport-auth.mjs';

const sitesSecret=randomBytes(36).toString('base64url'),standaloneSecret=randomBytes(36).toString('base64url');
const verify=createTransportAuthenticator({sitesSecret,standaloneSecret});
const sites={id:'sites:test-user',name:'教练',emailHash:'a'.repeat(64)};
const standalone={id:STANDALONE_AUDIENCE,name:'约练访客',emailHash:'b'.repeat(64),clientKey:'c'.repeat(64)};
const sha=value=>createHash('sha256').update(value).digest('hex');
function signed(identity,channel,secret=channel==='standalone'?standaloneSecret:sitesSecret,raw=''){
 const stamp=String(Date.now()),nonce=randomUUID(),encoded=Buffer.from(JSON.stringify(identity)).toString('base64url');
 return {method:'GET',url:'/v1/auth/session',headers:{'x-yuelian-time':stamp,'x-yuelian-nonce':nonce,'x-yuelian-identity':encoded,'x-yuelian-signature':createHmac('sha256',secret).update(['GET','/v1/auth/session',stamp,nonce,encoded,sha(raw)].join('\n')).digest('hex'),...(channel?{'x-yuelian-channel':channel}:{})}};
}
const denied=(req,raw='')=>assert.throws(()=>verify(req,raw),error=>error.status===401&&error.code==='AUTH_REQUIRED');

test('transport: unchanged Sites canonical signature works without channel',()=>{
 const identity=verify(signed(sites),'');assert.equal(identity.id,sites.id);assert.equal(identity.channel,'sites');
 assert.equal(verify(signed(sites,'sites'),'').id,sites.id);
});
test('transport: standalone signature strictly carries its deployment audience and client budget',()=>{
 const identity=verify(signed(standalone,'standalone'),'');assert.equal(identity.id,STANDALONE_AUDIENCE);assert.equal(identity.channel,'standalone');assert.equal(preauthKey(identity),'standalone:'+standalone.clientKey);
 assert.notEqual(preauthKey(identity),preauthKey({...identity,clientKey:'d'.repeat(64)}));
});
test('transport: channel header cannot cross the two trust roots',()=>{
 denied(signed(standalone,'standalone',sitesSecret));denied(signed(sites,'sites',standaloneSecret));
 const req=signed(standalone,'standalone');delete req.headers['x-yuelian-channel'];denied(req);
 const old=signed(sites);old.headers['x-yuelian-channel']='standalone';denied(old);
});
test('transport: standalone key never signs a Sites identity or another audience',()=>{
 for(const id of [sites.id,'standalone:another-deployment','account:arbitrary'])denied(signed({...standalone,id},'standalone'));
});
test('transport: Sites rejects the reserved audience namespace and clientKey',()=>{
 for(const id of [STANDALONE_AUDIENCE,'standalone:arbitrary'])denied(signed({...sites,id}));
 denied(signed({...sites,clientKey:standalone.clientKey}));
});
test('transport: missing, invalid or extra client identity fields are not trusted',()=>{
 for(const clientKey of [undefined,'','forged-ip','a'.repeat(63),'A'.repeat(64)])denied(signed({...standalone,clientKey},'standalone'));
 for(const extra of [{role:'owner'},{channel:'sites'},{permissions:['team.manage']}])denied(signed({...standalone,...extra},'standalone'));
});
test('transport: unknown, combined and array channel headers fail closed',()=>{
 for(const channel of ['','Standalone','sites, standalone',['standalone']]){const req=signed(standalone,'standalone');req.headers['x-yuelian-channel']=channel;denied(req);}
});
test('transport: spoofed forwarding IP headers cannot change the signed clientKey',()=>{
 const req=signed(standalone,'standalone');req.headers['cf-connecting-ip']='1.2.3.4';req.headers['x-forwarded-for']='8.8.8.8';req.headers['x-yuelian-client-key']='f'.repeat(64);
 assert.equal(verify(req,'').clientKey,standalone.clientKey);
});
test('transport: path, method and body remain authenticated',()=>{
 const path=signed(standalone,'standalone');path.url='/v1/workspaces';denied(path);
 const method=signed(standalone,'standalone');method.method='POST';denied(method);
 denied(signed(standalone,'standalone'),'changed body');
});
test('transport: stale timestamp, malformed signature, nonce and JSON fail closed',()=>{
 for(const [header,value] of [['x-yuelian-time','0'.repeat(13)],['x-yuelian-nonce','not-uuid'],['x-yuelian-signature','z'.repeat(64)],['x-yuelian-signature','0'.repeat(64)],['x-yuelian-identity','a'.repeat(4097)]]){const req=signed(standalone,'standalone');req.headers[header]=value;denied(req);}
});
test('transport: standalone is disabled unless a distinct strong secret is configured',()=>{
 const onlySites=createTransportAuthenticator({sitesSecret});assert.equal(onlySites(signed(sites),'').id,sites.id);
 assert.throws(()=>onlySites(signed(standalone,'standalone'),''),e=>e.status===401);
 for(const secret of ['', 'weak',sitesSecret])assert.throws(()=>createTransportAuthenticator({sitesSecret,standaloneSecret:secret}));
 assert.throws(()=>createTransportAuthenticator({sitesSecret:'weak',standaloneSecret}));
});
