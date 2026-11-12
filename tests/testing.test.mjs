import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'yuelian-testing-'));
const controller={id:'test-real-owner',name:'真正登录账号',emailHash:'a'.repeat(64),requestId:'request-1'};
const persona={key:'xiaolin',id:'mock:yuelian:v1:student-xiaolin',name:'小林（测试）',email:'xiaolin@mock.yuelian.invalid',role:'student',description:'测试学员'};
const config=join(dir,'access.json');writeFileSync(config,JSON.stringify({controllerId:controller.id,personas:[persona]}),{mode:0o600});
try{
 process.env.YUELIAN_TEST_ACCESS_FILE=config;process.env.YUELIAN_ENVIRONMENT='production';
 const prod=await import('../server/src/testing.mjs?production');
 test('production ignores test configuration and rejects persona routes',()=>{assert.equal(prod.testingStatus(controller).environment,'production');assert.equal(prod.testingStatus(controller).canSwitch,false);assert.throws(()=>prod.resolveTestIdentity('/v1/testing/personas/xiaolin/status',controller),e=>e.status===404);});
 process.env.YUELIAN_ENVIRONMENT='test';const mod=await import('../server/src/testing.mjs?test');
 test('ordinary routes preserve the real identity',()=>{assert.equal(mod.resolveTestIdentity('/v1/status',controller).identity,controller);});
 test('only configured owner gets the fixed mock catalogue',()=>{const other={...controller,id:'other'};assert.equal(mod.testingStatus(other).personas.length,0);assert.throws(()=>mod.resolveTestIdentity('/v1/testing/personas/xiaolin/status',other),e=>e.status===404);});
 test('fixed mock catalogue supports authenticated business login, never URL impersonation',()=>{assert.throws(()=>mod.resolveTestIdentity('/v1/testing/personas/xiaolin/status',controller),e=>e.status===404);const list=mod.mockCatalogue(controller);assert.deepEqual(list.map(p=>p.key),['zhou','xiaolin']);assert.equal(mod.mockAccount(controller,'zhou').id,controller.id);assert.equal(mod.mockAccount(controller,'xiaolin').id,persona.id);assert.equal(mod.mockAccount(controller,'xiaolin').username,'demo-xiaolin');assert.equal(mod.mockAccount({...controller,id:'other'},'xiaolin'),null);});
 test('unknown, real-account and nested impersonation targets are rejected',()=>{for(const path of ['/v1/testing/personas/unknown/status','/v1/testing/personas/test-real-owner/status','/v1/testing/personas/xiaolin/testing/personas/lin/status'])assert.throws(()=>mod.resolveTestIdentity(path,controller),e=>e.status===404);});
 test('mock actors cannot themselves acquire test switching rights',()=>{assert.throws(()=>mod.resolveTestIdentity('/v1/testing/personas/xiaolin/status',{...controller,id:persona.id}),e=>e.status===404);});
}finally{rmSync(dir,{recursive:true,force:true});}

test('duplicate persona keys reject the entire testing configuration',async()=>{
 const duplicateDir=mkdtempSync(join(tmpdir(),'yuelian-testing-duplicate-'));
 const duplicateFile=join(duplicateDir,'access.json');
 writeFileSync(duplicateFile,JSON.stringify({controllerId:controller.id,personas:[persona,{...persona,id:'mock:yuelian:v1:second-student'}]}),{mode:0o600});
 const previousFile=process.env.YUELIAN_TEST_ACCESS_FILE,previousEnvironment=process.env.YUELIAN_ENVIRONMENT;
 try{process.env.YUELIAN_TEST_ACCESS_FILE=duplicateFile;process.env.YUELIAN_ENVIRONMENT='test';await assert.rejects(()=>import('../server/src/testing.mjs?duplicate-persona-configuration'),/Duplicate test persona keys/);}
 finally{if(previousFile===undefined)delete process.env.YUELIAN_TEST_ACCESS_FILE;else process.env.YUELIAN_TEST_ACCESS_FILE=previousFile;if(previousEnvironment===undefined)delete process.env.YUELIAN_ENVIRONMENT;else process.env.YUELIAN_ENVIRONMENT=previousEnvironment;rmSync(duplicateDir,{recursive:true,force:true});}
});
