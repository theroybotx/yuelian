import specification from '../../../public/security-cases.json';
import {getChatGPTUser,chatGPTSignInPath} from '../../chatgpt-auth';

export const dynamic='force-dynamic';
const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const list=(items:string[],ordered=false)=>`<${ordered?'ol':'ul'}>${items.map(item=>`<li>${esc(item)}</li>`).join('')}</${ordered?'ol':'ul'}>`;
const boundary='权限是约练后端的公共服务。日程、学员、场地、课时和 AI 操作都应经过服务端身份与权限校验；普通用户无需打开权限页面。教练只在个人中心管理团队成员及助教授权。';
const current='本次已将主站现有日程、学员、场地、开放时间、收件箱、课时、练习、回访及团队操作接入 Mac 后台。按钮与 AI 共用服务端授权和事务写入，旧浏览器 AI 接口已关闭。站点仍仅限 Roy 访问；业务写入按最新要求启用，已执行隔离环境验收与本轮修复回归，范围与未覆盖项如下。';
const status='原48项验收设计：31项通过、17项部分验证，当前无已复现而未修复的失败项。另增9组提交/断连恢复回归。部分验证不等于完整验收通过；真实Sites多账号、真机与完整故障矩阵尚未覆盖。';

function textDocument(){
 const lines=['约练 · 后端权限验收用例（审阅文档）',specification.version,'',boundary,'',current,'',status,'','测试准备',specification.scope,...specification.fixtures.map((item,i)=>`${i+1}. ${item}`),'','验收标准',specification.acceptance];
 for(const c of specification.cases){
  lines.push('','────────────────────────',`${c.id} · ${c.priority} · ${c.result.status}`,c.title,`分组：${c.group}`,`测试身份：${c.actor}`,`前置条件：${c.precondition}`,'操作步骤',...c.steps.map((s,i)=>`${i+1}. ${s}`),'预期结果',...c.expected.map((s,i)=>`${i+1}. ${s}`),`失败判定：${c.failure}`,`本次结果：${c.result.detail}`);
 }
 return lines.join('\n')+'\n';
}

function documentHtml(){
 const groups=[...new Set(specification.cases.map(c=>c.group))];
 return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>后端权限验收用例 · 约练审阅文档</title><link rel="icon" href="/mark.svg" type="image/svg+xml"><link rel="stylesheet" href="/style.css?v=8"><link rel="stylesheet" href="/security-review.css?v=9"></head>
 <body class="review-document"><a class="skip-link" href="#main">跳到正文</a><header class="document-header"><a href="/">返回约练</a><span>开发审阅文档</span><a href="/review/security?format=txt" download="yuelian-security-cases.txt">下载完整用例 TXT</a></header>
 <main id="main"><p class="document-label">约练 / 后端权限</p><h1>安全验收用例</h1><p class="document-status">${specification.cases.length} 项 · 31通过 / 17部分验证 · 2026-11-01</p>
 <section class="document-intro"><h2>这份文档的用途</h2><p>供你检查测试设计、结果和未覆盖项。这里没有排课、建档、团队管理或 AI 操作，也不会向业务后台发起请求。</p><p>${boundary}</p><h2>当前实现范围</h2><p>${current}</p><p>${status}</p></section>
 <section id="preparation"><h2>测试准备与验收标准</h2><p>${esc(specification.scope)}</p>${list(specification.fixtures,true)}<p><strong>验收标准：</strong>${esc(specification.acceptance)}</p></section>
 <nav class="document-index" aria-label="用例目录"><h2>用例目录</h2>${groups.map((group,i)=>`<a href="#group-${i}">${esc(group)} <span>${specification.cases.filter(c=>c.group===group).length} 项</span></a>`).join('')}</nav>
 ${groups.map((group,i)=>`<section id="group-${i}" class="case-group"><h2>${esc(group)}</h2>${specification.cases.filter(c=>c.group===group).map(c=>`<details class="review-case" id="${esc(c.id)}"><summary><span class="case-id">${esc(c.id)}</span><strong>${esc(c.title)}</strong><span class="case-status">${esc(c.priority)} · ${esc(c.result.status)}</span></summary><div class="case-detail"><h3>测试身份</h3><p>${esc(c.actor)}</p><h3>前置条件</h3><p>${esc(c.precondition)}</p><h3>操作步骤</h3>${list(c.steps,true)}<h3>预期结果</h3>${list(c.expected)}<h3>失败判定</h3><p>${esc(c.failure)}</p><h3>本次结果与验证边界</h3><p>${esc(c.result.detail)}</p></div></details>`).join('')}</section>`).join('')}
 <footer><p>本页仅用于审阅，未连接测试执行器。用例来源：public/security-cases.json。</p><a href="/review/security?format=txt" download="yuelian-security-cases.txt">下载全部用例</a></footer></main></body></html>`;
}

export async function GET(request:Request){
 const user=await getChatGPTUser();
 if(!user)return Response.redirect(new URL(chatGPTSignInPath('/review/security'),request.url));
 const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
 if(new URL(request.url).searchParams.get('format')==='txt')return new Response(textDocument(),{headers:{...headers,'Content-Type':'text/plain; charset=utf-8','Content-Disposition':'attachment; filename="yuelian-security-cases.txt"'}});
 return new Response(documentHtml(),{headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});
}
