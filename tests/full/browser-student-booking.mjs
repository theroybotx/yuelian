// Real two-sided booking buttons and real isolated PostgreSQL; no model response.
import {sourceState} from './source-state.mjs';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import pg from '../../server/node_modules/pg/lib/index.js';
const source=sourceState(),runId=new Date().toISOString();
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.YUELIAN_BROWSER_URL||'http://127.0.0.1:18898',out=path.resolve(process.env.YUELIAN_FULL_OUTPUT||'output/full-20261101','browser-student-booking');await mkdir(out,{recursive:true});
const fixture=await(await fetch(base+'/__test/fixture')).json(),W=fixture.workspaces.zhou,S=fixture.students.xiaolinA,V=fixture.venues[W];
const date=new Date(fixture.date+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+7);const lessonDate=date.toISOString().slice(0,10),note='学生传统预约验收'+randomBytes(4).toString('hex');
const admin=new pg.Client({host:'/tmp',user:'jarvisxiao',database:'yuelian_acceptance_browser_20261101'});await admin.connect();
const records=async()=> (await admin.query('SELECT * FROM app.records WHERE workspace_id=$1',[W])).rows;
const ledger=async()=> (await records()).filter(r=>r.kind==='ledger'&&r.student_id===S).map(r=>({id:r.id,delta:r.payload.delta})).sort((a,b)=>a.id.localeCompare(b.id));
const before=await ledger();
const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();page.setDefaultTimeout(45000);
let next=0,errors=[];await context.route('**/api/**',async route=>{const wait=Math.max(0,next-Date.now());next=Math.max(next,Date.now())+2100;if(wait)await new Promise(r=>setTimeout(r,wait));await route.continue();});page.on('pageerror',e=>errors.push(e.message));
const results=[];let lesson,message;
const run=async(id,fn)=>{try{await fn();results.push({id,status:'passed'});console.log('PASS '+id);}catch(error){results.push({id,status:'failed',error:error.message});await page.screenshot({path:path.join(out,id+'-failure.png'),fullPage:true});throw error;}};
const mock=async key=>{await page.goto(base+'/login');await page.locator('[data-persona="'+key+'"]').click();await page.waitForURL(base+'/');await page.locator('.composer-dock').waitFor();};
const signout=async()=>{await page.getByRole('button',{name:'个人中心',exact:true}).click();await page.getByRole('button',{name:'退出约练',exact:true}).click();await page.waitForURL(base+'/login');};
const acknowledge=async()=>{await page.locator('#operation-title').filter({hasText:'项操作已完成'}).waitFor();await page.getByRole('button',{name:'完成',exact:true}).click();await page.locator('#operation-dialog').waitFor({state:'hidden'});};
try{
 await run('OP-07-STUDENT-B',async()=>{await mock('xiaolin');if(await page.locator('#workspace-select').inputValue()!==W){await page.locator('#workspace-select').selectOption(W);await page.locator('.workspace-switch strong').filter({hasText:'周教练'}).waitFor({state:'attached'});}await page.goto(base+'/#schedule');await page.locator('[data-action=new-booking]').click();const f=page.locator('#result-form');for(const[name,value]of Object.entries({date:lessonDate,start:'19:00',duration:'60',note}))await f.locator('[name="'+name+'"]').fill(value);await f.locator('[name=venue]').selectOption(V);assert.equal(await f.locator('[name=student]').count(),0);await f.locator('[type=submit]').click();await acknowledge();const rows=await records();lesson=rows.find(r=>r.kind==='lesson'&&r.payload.topic===note);assert.ok(lesson);assert.equal(lesson.payload.state,'pending');assert.equal(lesson.student_id,S);message=rows.find(r=>r.kind==='message'&&r.lesson_id===lesson.id&&r.payload.kind==='booking');assert.ok(message);assert.deepEqual(await ledger(),before);await page.screenshot({path:path.join(out,'student-submitted-390.png'),fullPage:true});await signout();});
 await run('OP-13-COACH-REJECT-B',async()=>{await mock('zhou');await page.goto(base+'/#inbox');await page.locator('[data-message-card="'+message.id+'"] [data-action=direct-reject]').click();await acknowledge();const rows=await records();assert.equal(rows.find(r=>r.id===lesson.id).payload.state,'cancelled');assert.equal(rows.find(r=>r.id===message.id).payload.state,'declined');assert.ok(rows.some(r=>r.kind==='message'&&r.lesson_id===lesson.id&&r.payload.kind==='status'));assert.deepEqual(await ledger(),before);assert.deepEqual(errors,[]);await page.screenshot({path:path.join(out,'coach-rejected-390.png'),fullPage:true});await signout();});
}catch{}finally{const sourceAtReport=sourceState();await writeFile(path.join(out,'results.json'),JSON.stringify({runId,source,sourceAtReport,implementationChanged:source.implementationDigest!==sourceAtReport.implementationDigest,kind:'browser-real-postgresql',results},null,2));await browser.close();await admin.end();}
console.log(JSON.stringify({passed:results.filter(r=>r.status==='passed').length,failed:results.filter(r=>r.status!=='passed')}));if(results.some(r=>r.status!=='passed')||source.implementationDigest!==sourceState().implementationDigest)process.exitCode=1;
