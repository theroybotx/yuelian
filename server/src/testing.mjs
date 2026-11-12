import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {HttpError} from './policy.mjs';

// An explicit deployment setting, never a browser flag, enables test identities.
// Only the configured real Sites account may use this fixed mock-only catalogue.
const isTest=process.env.YUELIAN_ENVIRONMENT==='test';
const persona=z.object({key:z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),id:z.string().regex(/^mock:yuelian:v1:[a-z0-9-]+$/),name:z.string().min(1).max(80),email:z.string().email().endsWith('@mock.yuelian.invalid'),role:z.enum(['coach','student','assistant']),description:z.string().max(160)}).strict();
const schema=z.object({controllerId:z.string().min(1).max(200),personas:z.array(persona).min(1).max(12)}).strict();
const config=isTest&&process.env.YUELIAN_TEST_ACCESS_FILE?schema.parse(JSON.parse(readFileSync(process.env.YUELIAN_TEST_ACCESS_FILE,'utf8'))):null;
if(config&&new Set(config.personas.map(p=>p.key)).size!==config.personas.length)throw new Error('Duplicate test persona keys');
const controller=identity=>identity.controller||identity;
export function mockCatalogue(identity){
 const account=controller(identity);
 if(!config||account.id!==config.controllerId)return [];
 return [{key:'zhou',id:config.controllerId,name:'周教练',email:'zhou@mock.yuelian.invalid',role:'coach',description:'弘金地训练示例，负责小林和小宇'},...config.personas].map(p=>({...p,username:'demo-'+p.key}));
}
export function mockAccount(identity,key){return mockCatalogue(identity).find(p=>p.key===key)||null;}
export function testingStatus(identity){
 const account=controller(identity),list=mockCatalogue(identity);
 return {environment:isTest?'test':'production',canSwitch:list.length>0,canLogin:list.length>0,selected:identity.testPersona||'',account:{name:account.name},personas:list.map(({key,name,username,role,description})=>({key,name,username,role,description}))};
}
export function resolveTestIdentity(path,identity){
 if(!path.startsWith('/v1/testing/'))return {path,identity};
 // A URL may not impersonate an account. Mock identities now establish the
 // same revocable database session used by ordinary password accounts.
 throw new HttpError(404);
}
