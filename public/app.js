import {TODAY,balanceOf,timeText,dateText,moneyless,emptyData,session,api,path,can,canAction,bootstrap,refresh,loadTeam,clearSession,onInvalidated,serverPlan,missingFields,testPersona,selectTestPersona,logout,refreshToday} from './workspace-client.js?v=16';
import {toPlan} from './ai-client.js?v=11';
const clone=value=>structuredClone(value);
let selfStudentId=null,submitting=false,loggingOut=false,teamNotice='',lastWorkspaceId=null,loadSequence=0;
let sheetState = null, inviteStudentId=null, inviteReceipt=null;
let aiState='checking', aiRequest=null, aiEpoch=0, lastAI=null;
const aiLabel=()=>aiState==='ready'?'DeepSeek V4.1 Flash · Medium':aiState==='missing'?'AI 待连接':'正在检查 AI 连接';
function cancelAI(){aiEpoch++;aiRequest?.abort();aiRequest=null;}
const useOperationSheet=()=>!!result;
let data=emptyData(),role='coach';
let view='home',selectedDate=TODAY,month=TODAY.slice(0,7),studentId=null,lessonId=null;
let homeFilter='pending', inboxFilter='all', contextInputs={};
let formDrafts=new Map(),suspendedView=null,suspending=false,skipFormCapture=false;
let result = null, profileOpen = false, menuOpen = false, undoState = null, inputValue = '', search = '', toastTimer;
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const draftEntity=(id,type)=>{const r=result?.type==='plan'?result.steps.find(s=>'plan:'+s.id===id&&s.type===type):null;return r?{id,...r.values,last:null,next:r.values.next||''}:null;};
const student = id => data.students.find(s => s.id === id)||draftEntity(id,'add-student');
const venue = id => data.venues.find(v => v.id === id)||draftEntity(id,'add-venue');
const names = lesson => lesson.students.map(id => student(id)?.name || '学员').join('、');
const weekdays = ['日','一','二','三','四','五','六'];
const dayOf = date => weekdays[new Date(date + 'T00:00:00Z').getUTCDay()];
const minutes = value => {const [h,m] = String(value).split(':').map(Number); return h*60+m;};
const visibleLessons = () => data.lessons.filter(l => l.state !== 'cancelled' && (role === 'coach' || l.students.includes(selfStudentId)));
const stateText = state => ({done:'已完成',confirmed:'已确认',pending:'待教练确认',pending_student:'待学员确认',cancelled:'已取消'}[state] || state);
const stateClass = state => state === 'done' ? 'done' : state.startsWith('pending') ? 'pending' : '';
function toast(text) { clearTimeout(toastTimer); const el=$('#toast'); el.textContent=text; el.classList.add('show'); toastTimer=setTimeout(()=>el.classList.remove('show'),4500); }
const paths = {
 home:'M3 10 12 3l9 7 M5 9v12h14V9 M9 21v-8h6v8',plus:'M12 5v14 M5 12h14',
 calendar:'M4 5h16v16H4z M8 3v4 M16 3v4 M4 10h16 M8 14h2 M14 14h2 M8 18h2',
 users:'M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2 M9.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M17 4a4 4 0 0 1 0 7 M21 21v-2a4 4 0 0 0-3-3.87',
 court:'M3 5h18v14H3z M12 5v14 M3 8h18 M3 16h18 M6 8v8 M18 8v8',
 chart:'M4 3v18h17 M8 16v-4 M13 16V7 M18 16V4',
 inbox:'M4 4h16l2 12v4H2v-4L4 4z M2 15h6l2 3h4l2-3h6',
 arrow:'M5 12h14 M13 6l6 6-6 6', left:'m14 6-6 6 6 6', right:'m10 6 6 6-6 6', down:'m6 9 6 6 6-6',
 close:'m6 6 12 12 M18 6 6 18', check:'m5 12 4 4L19 6', menu:'M4 6h16 M4 12h16 M4 18h16',
 edit:'m15 5 4 4 M4 20l4-1L20 7a2 2 0 0 0-4-4L4 15v5z',
 note:'M5 3h10l4 4v14H5z M14 3v5h5 M8 12h8 M8 16h6',
 help:'M12 17h.01 M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
 settings:'M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M5.6 18.4l2.1-2.1 M16.3 7.7l2.1-2.1 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
 command:'M5 5h4 M5 5v4 M19 5h-4 M19 5v4 M5 19h4 M5 19v-4 M19 19h-4 M19 19v-4 M9 12h6',
 clock:'M12 7v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
 mic:'M9 4a3 3 0 0 1 6 0v8a3 3 0 0 1-6 0V4z M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3 M8 22h8',
};
const icon = (name, cls='') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.note}"/></svg>`;
const actionPermission={'new-booking':'booking','new-student':'add-student','new-venue':'add-venue','new-rule':'availability','new-credit':'credit','new-record':'record','new-practice':'practice','edit-practice':'edit-practice','edit-student':'edit-student','edit-venue':'edit-venue','edit-rule':'availability','edit-base':'edit-base','edit-lesson':'edit-lesson','edit-followup':'followup','direct-accept':'message-decision','direct-reject':'message-decision','accept-booking':'message-decision','reject-booking':'message-decision','direct-resolve':'resolve-message','resolve-message':'resolve-message'};
const button=(label,action,cls='btn',extra='')=>actionPermission[action]&&!canAction(actionPermission[action])?'':`<button type="button" class="${cls}" data-action="${action}" ${extra}>${label}</button>`;
const navLink = (id,label,ico) => `<a href="#${id}" class="nav-link ${view === id ? 'active' : ''}" ${view===id?'aria-current="page"':''}>${icon(ico)}<span>${label}</span></a>`;
const lessonOptions = lesson => `<span class="pill ${stateClass(lesson.state)}">${stateText(lesson.state)}</span>`;
const selected = (a,b) => a===b ? ' selected' : '';
function navigate(target) { location.hash=target; if(location.hash.slice(1)===target) route(); }
function canView(target){
 if(['home','account','review'].includes(target))return true;
 if(role==='student')return ['schedule','progress','stats','inbox'].includes(target);
 return {schedule:can('schedule.read'),students:can('students.read'),availability:can('venues.read')||can('schedule.read'),stats:can('schedule.read')||can('ledger.read'),inbox:can('schedule.read')}[target]===true;
}
function route() {
 cancelAI();const target=location.hash.slice(1)||'home';view=canView(target)?target:'home';
 if(view!==target)history.replaceState(null,'',location.pathname+location.search+'#'+view);
 result=null;lessonId=null;profileOpen=false;menuOpen=false;render();$('#main')?.focus({preventScroll:true});
}
const formKey=form=>[form.dataset.accountForm,form.dataset.user||form.dataset.student||form.dataset.invitation||''].join(':');
function rememberForms(){
 for(const form of document.querySelectorAll('[data-account-form]')){
  const controls=[...form.querySelectorAll('input[name],textarea[name],select[name]')];
  formDrafts.set(formKey(form),controls.map(el=>({name:el.name,value:el.value,checked:el.checked,type:el.type})));
 }
}
function restoreForms(){
 for(const form of document.querySelectorAll('[data-account-form]')){
  const saved=formDrafts.get(formKey(form));if(!saved)continue;
  for(const el of form.querySelectorAll('input[name],textarea[name],select[name]')){
   const item=saved.find(x=>x.name===el.name&&(!['checkbox','radio'].includes(el.type)||x.value===el.value));
   if(item){if(['checkbox','radio'].includes(el.type))el.checked=item.checked;else el.value=item.value;}
  }
 }
 const inviteRole=$('#invite-role')?.value;if(inviteRole){$('#invite-student-field').hidden=inviteRole!=='student';$('#invite-permissions').hidden=inviteRole!=='assistant';}
}
function currentFocus(){
 const el=document.activeElement;if(!el||el===document.body||el.closest('#operation-dialog'))return null;
 const form=el.closest('[data-account-form]');
 return {id:el.id,form:form?formKey(form):null,name:el.name,value:el.value,action:el.dataset.action,href:el.getAttribute('href'),start:el.selectionStart,end:el.selectionEnd};
}
function restoreFocus(focus){
 if(!focus||result)return;let el=focus.id?document.getElementById(focus.id):null;
 if(!el&&focus.form){const form=[...document.querySelectorAll('[data-account-form]')].find(f=>formKey(f)===focus.form);el=[...(form?.querySelectorAll('[name]')||[])].find(e=>e.name===focus.name&&(!['checkbox','radio'].includes(e.type)||e.value===focus.value));}
 if(!el&&focus.action)el=[...document.querySelectorAll('[data-action]')].find(e=>e.dataset.action===focus.action);
 if(!el&&focus.href)el=[...document.querySelectorAll('a[href]')].find(e=>e.getAttribute('href')===focus.href);
 if(el&&!el.closest('[inert]')){el.focus({preventScroll:true});if(typeof focus.start==='number')try{el.setSelectionRange(focus.start,focus.end);}catch{}}
}
function syncToday(){const previous=TODAY;refreshToday();if(previous!==TODAY&&selectedDate===previous){selectedDate=TODAY;if(month===previous.slice(0,7))month=TODAY.slice(0,7);}}
function drawerState(){
 const open=menuOpen&&innerWidth<=700;
 for(const el of document.querySelectorAll('.demo-bar,.topbar,.main,.composer-dock,.profile-menu'))el.inert=open;
 const nav=$('.sidebar');if(nav){nav.inert=innerWidth<=700&&!menuOpen;if(open){nav.setAttribute('role','dialog');nav.setAttribute('aria-modal','true');nav.setAttribute('aria-label','主导航');}else{nav.removeAttribute('role');nav.removeAttribute('aria-modal');nav.removeAttribute('aria-label');}}
}

const pageNames = {home:['约练主页','HOME'],schedule:['日程','SCHEDULE'],students:['学员','ROSTER'],availability:['场地与开放时间','AVAILABILITY'],stats:['课时统计','INSIGHTS'],inbox:['收件箱','INBOX'],account:['个人中心','ACCOUNT'],review:['使用说明','PROTOTYPE'],progress:['我的训练','MY PRACTICE']};
const examples = {
 lesson:'记一下 学员姓名 今天这节课，90分钟，反手转肩更早了，下次加入移动练习',
 multi:'先添加弘金地网球场，再帮 学员姓名 约明天下午3点到4点在这里练正手和反手',
 booking:'帮 学员姓名 约下周三18点在滨江练一小时',
 availability:'下个月每周二在滨江，14:00到18:00，课间留15分钟',
 followup:'帮我找出很久没来、还有课时的学员，拟一条回访消息',
 stats:'这个月上了多少课？',
 balance:'学员姓名 还剩多少课时？',
 add:'新增学员张小宇，目标是学习正手',
 credit:'给 学员姓名 登记购买10课时',
 practice:'记一下今天的自主练习：反手挥拍20分钟，转肩比上次自然',
 request:'帮我约下周三18点在滨江练一小时'
};
function exampleText(key){return examples[key].replaceAll('学员姓名',student(role==='student'?selfStudentId:studentId)?.name||data.students[0]?.name||'学员').replaceAll('滨江',data.venues[0]?.name||'常用场地');}
function availableExamples(){const requirements={request:['booking'],practice:['practice'],balance:['balance'],availability:['availability'],booking:['booking'],stats:['summary'],followup:['followup'],add:['add-student'],credit:['credit'],multi:['add-venue','booking'],lesson:['record']};return exampleSet().filter(([key])=>requirements[key].every(canAction));}
function exampleSet() {
 if(role==='student') return [['request','约下一节课'],['practice','记自主练习'],['balance','核对剩余课时']];
 if(view==='availability') return [['availability','调整开放时间'],['booking','安排一节课'],['stats','查看场地使用']];
 if(view==='students') return [['followup','找需要回访的学员'],['add','录入新学员'],['credit','登记课时包']];
 if(view==='stats') return [['stats','查看本月统计'],['balance','核对学员课时'],['followup','找需要回访的学员']];
 if(view==='inbox')return [['multi','一次安排多件事'],['balance','核对学员课时'],['booking','安排下一节课']];
 return [['multi','一次安排多件事'],['lesson','记一下这节课'],['availability','调整开放时间'],['followup','找需要回访的学员'],['stats','看看本月课时']];
}
function render() {
  if(!session.ready){renderGate();return;}
  syncToday();if(skipFormCapture)skipFormCapture=false;else rememberForms();const focus=currentFocus();
  prepareOperationSheet();
  const [title,en]=pageNames[view];
  const inboxCount=pendingMessages().length;
  document.body.classList.toggle('home-view',view==='home');
  $('#app').innerHTML=`
    <div class="demo-bar"><span class="environment-label"><i class="demo-dot"></i><strong>${session.status?.testing?.environment==='test'?'测试环境':'约练'}</strong></span><div class="scope-controls">${testingPicker()}${coachPicker()}</div></div>
    <div class="scrim ${menuOpen?'open':''}" data-action="menu-close"></div>
    <aside id="main-navigation" class="sidebar ${menuOpen?'open':''}" ${innerWidth<=700&&!menuOpen?'inert':''}>
      ${button(icon('close'),'menu-close','icon-button menu-close','aria-label="关闭导航"')}
      <a href="#home" class="brand">${icon('court','brand-symbol')}<div><div class="brand-name">约练</div><div class="brand-en">YUELIAN TENNIS</div></div></a>
      <div class="workspace-switch flex"><span class="mini-avatar">${esc(session.identity.name[0])}</span><div><strong>${esc(session.workspace.name)}</strong><div class="sub">${esc(session.identity.name)} · ${roleLabels[session.workspace.role]}</div></div></div>
      <p class="nav-caption">我的约练</p><nav aria-label="主导航">
      ${navLink('home','主页','home')}${canView('schedule')?navLink('schedule',role==='coach'?'日程':'我的课程','calendar'):''}
      ${role==='coach'?(can('students.read')?navLink('students','学员','users'):'')+(canView('availability')?navLink('availability','场地与开放时间','court'):''):navLink('progress','我的训练','note')}
      ${canView('stats')?navLink('stats','课时统计','chart'):''}</nav>
      <div class="sidebar-bottom"><a href="#review">${icon('help')}使用说明</a><small>YUELIAN / COURTSIDE<br>多任务与直接操作</small></div>
    </aside>
    <header class="topbar"><div class="page-heading">${button(icon('menu'),'menu','icon-button mobile-menu','aria-label="打开导航" aria-controls="main-navigation" aria-expanded="'+menuOpen+'"')}<h1>${title}</h1><span class="overline">${en}</span></div>
      <div class="top-actions"><span class="date-label muted" style="font-size:12px">${TODAY.replaceAll('-',' / ')}　周${dayOf(TODAY)}</span>${canView('inbox')?`<a href="#inbox" class="icon-button" aria-label="收件箱${inboxCount?'，'+inboxCount+'条待处理':''}">${icon('inbox')}${inboxCount?'<i class="badge-dot"></i>':''}</a>`:''}${button(esc(session.identity.name[0]),'profile','profile','aria-label="个人中心" aria-controls="profile-menu" aria-expanded="'+profileOpen+'"')}</div>
    </header>${profileOpen?profileMenu():''}
    <main id="main" class="main" tabindex="-1"><div class="workspace-grid ${view==='account'?'account-view':''} ${result?'has-result':''}"><section class="view-content">${renderView()}</section><aside class="aside-column" aria-label="详情与处理结果">${renderAside()}</aside></div></main>
    <section class="composer-dock" aria-label="自然语言主入口"><div class="composer-wrap">${renderComposer(false)}</div></section>`;
  syncOperationSheet();
  updateComposerViewport();
  freezeSubmission();restoreForms();drawerState();restoreFocus(focus);
}
function renderComposer(prominent=false) {
 const context=lessonId?names(data.lessons.find(l=>l.id===lessonId)):view==='students'?student(studentId)?.name:'';
 return `${prominent?`<div class="compose-heading"><span class="overline">YUELIAN ASSISTANT</span><h2>${role==='coach'?'今天，想安排什么？':'下一次上场，从这里开始。'}</h2><p>说一句，整理成可以确认的操作。</p></div>`:'<div class="compact-heading"><span class="assistant-label">约练 AI</span><span>说一句，一起处理</span></div>'}
 <form class="composer ${prominent?'prominent-composer':''}" id="command-form">${icon('command','input-symbol')}<textarea id="command-input" aria-label="告诉约练你要做什么" placeholder="${!canAction('booking')?'例如：查看这个月的已完成课程':role==='coach'?'例如：帮 '+esc(student(studentId)?.name||data.students[0]?.name||'学员')+' 约下周三18点在常用场地练一小时':'例如：帮我约下周三18点在常用场地练一小时'}" rows="${prominent?'2':'1'}" maxlength="1600">${esc(inputValue)}</textarea><div class="composer-actions">${button(icon('mic'),'voice','icon-button','aria-label="填入语音示例（不录音）" title="不录音，仅填入示例"')}<button class="send" type="submit" aria-label="处理这句话">${prominent?'<span>生成操作</span>':'<span>生成操作</span>'}${icon('arrow')}</button></div></form>
 <div class="composer-examples">${availableExamples().slice(0,prominent?3:4).map(([id,label])=>button(label,'example','example',`data-example="${id}"`)).join('')}</div>
 <div class="composer-bottom"><span>${context?`<span class="composer-context">当前：${esc(context)}</span> · `:''}<span data-ai-status>${aiLabel()}</span> · 核对后执行</span>${undoState?button('撤销上次修改','undo','undo-link'):''}</div>`;
}
function pendingMessages() {return data.messages.filter(m=>m.state==='pending'&&(role==='coach'?['booking','balance','practice'].includes(m.kind):m.student===selfStudentId&&m.kind==='proposal'));}
function isActionable(m) {return canAction('message-decision')&&m?.state==='pending'&&((role==='coach'&&m.kind==='booking')||(role==='student'&&m.kind==='proposal'&&m.student===selfStudentId));}
function renderHome() {
 const pending=pendingMessages(), activity=data.activity.filter(a=>a.role===role);
 return `<div class="home-intro"><h2>今天的安排</h2><p>处理待办，或在下方一次安排多件事。</p></div>
 <div class="quick-actions"><span>也可以直接</span>${button(icon('plus')+(role==='coach'?'添加课程':'申请约课'),'new-booking','btn')}${role==='coach'?button(icon('plus')+'添加学员','new-student','btn'):button(icon('note')+'记录练习','new-practice','btn')}</div>
 ${result&&!result.context&&!useOperationSheet()?`<div class="home-result">${renderResult()}</div>`:''}
 <div class="feed-heading"><div class="feed-tabs" aria-label="工作事项筛选">${button(`待处理 <span>${pending.length}</span>`,'home-filter',homeFilter==='pending'?'active':'','data-filter="pending" aria-pressed="'+(homeFilter==='pending')+'"')}${button('已完成','home-filter',homeFilter==='completed'?'active':'','data-filter="completed" aria-pressed="'+(homeFilter==='completed')+'"')}</div>${canView('inbox')?`<a href="#inbox" class="text-button">查看收件箱 ${icon('right')}</a>`:''}</div>
 <div class="work-feed">${homeFilter==='pending'?(pending.length?pending.map(renderMessageCard).join(''):`<div class="panel empty">${icon('check')}<h3>待办都处理好了</h3><p>${canView('inbox')?'可以继续安排课程，或在收件箱查看历史消息。':'当前没有需要处理的事项。'}</p></div>`):(activity.length?activity.slice(0,8).map(a=>`<article class="panel activity-row"><span class="activity-check">${icon('check')}</span><div><h3>${esc(a.label)}</h3><p>${esc(a.request||'通过界面直接完成')} · ${dateText(a.date)}</p></div><span class="pill done">已完成</span></article>`).join(''):`<div class="panel empty">还没有已完成的操作<p>AI 生成和直接操作的结果都会记在这里。</p></div>`)}</div>`;
}
function renderMessageCard(m) {
 const l=data.lessons.find(l=>l.id===m.lesson), actionable=isActionable(m), pending=m.state==='pending';
 return `<article class="panel work-card" data-message-card="${m.id}"><div class="work-card-head"><div class="flex"><span class="mini-avatar">${role==='coach'?esc(student(m.student)?.initial||'学'):esc(session.workspace.name[0])}</span><div><strong>${role==='coach'?esc(student(m.student)?.name):esc(session.workspace.name)}</strong><p>${esc(m.date)} · ${{booking:'预约申请',proposal:'约课提案',balance:'课时核对',practice:'训练记录',feedback:'课后反馈',status:'预约状态'}[m.kind]||'消息'}</p></div></div><span class="pill ${pending?'pending':'gray'}">${pending?(m.kind==='booking'?'待教练确认':m.kind==='proposal'?'待学员确认':'待处理'):m.state==='declined'?'已拒绝':m.state==='accepted'?'已确认':'已记录'}</span></div>
 <div class="work-card-content"><h3>${esc(m.title)}</h3><blockquote>${esc(m.text)}</blockquote>${l?`<div class="extracted-fields"><span>${icon('calendar')}${dateText(l.date)}　${timeText(l.start)}</span><span>${icon('court')}${esc(venue(l.venue)?.name)}</span><span>${icon('clock')}${l.duration} 分钟</span></div>`:m.kind==='balance'?`<p class="balance-hint">账本余额 <strong>${moneyless(balanceOf(data,m.student))}</strong> 课时 · 可查看明细核对</p>`:''}</div>
 ${actionable?`<form class="message-command" data-message="${m.id}">${icon('command')}<input aria-label="处理${esc(student(m.student)?.name||'这条')}的预约" placeholder="例如：可以，帮我确认这节课" maxlength="300" value="${esc(contextInputs[m.id]||'')}"><button type="submit" aria-label="生成这条预约的操作">${icon('arrow')}</button></form>`:''}
 <div class="work-card-actions">${actionable?`${button('确认预约','direct-accept','btn primary',`data-id="${m.id}"`)}${button('拒绝预约','direct-reject','btn',`data-id="${m.id}"`)}`:pending&&!['booking','proposal'].includes(m.kind)?button('标记已处理','direct-resolve','btn',`data-id="${m.id}"`):''}${button('查看详情','message','text-button',`data-id="${m.id}"`)}</div>
 ${result?.context===m.id&&!useOperationSheet()?`<div class="context-result">${renderResult()}</div>`:''}</article>`;
}

function profileMenu() {return `<div class="profile-menu" id="profile-menu" aria-label="个人菜单"><div class="profile-info"><strong>${esc(session.identity.name)}</strong><p class="sub">${roleLabels[session.workspace.role]}</p></div><a href="#account">${icon('settings')}个人中心</a>${button('退出约练','logout','profile-logout')}</div>`;}
function renderView() {
 switch(view) {
  case 'home': return renderHome();
  case 'schedule': return renderCalendar();
  case 'students': return renderStudents();
  case 'availability': return renderVenues();
  case 'stats': return renderStats();
  case 'inbox': return renderInbox();
  case 'progress': return renderProgress();
  case 'account': return renderAccount();
  default: return renderReview();
 }
}
function renderCalendar() {
 const [year,m]=month.split('-').map(Number), first=new Date(Date.UTC(year,m-1,1)), start=new Date(first);
 start.setUTCDate(1-(first.getUTCDay()+6)%7);
 const cells=Array.from({length:42},(_,i)=>{const d=new Date(start);d.setUTCDate(start.getUTCDate()+i); const date=d.toISOString().slice(0,10), list=visibleLessons().filter(l=>l.date===date).sort((a,b)=>a.start-b.start);return `<button type="button" class="day ${date.slice(0,7)!==month?'outside':''} ${date===selectedDate?'selected':''} ${date===TODAY?'today':''}" data-action="day" data-date="${date}" aria-label="${dateText(date)}，${list.length}节课" aria-pressed="${date===selectedDate}"><span class="day-num">${d.getUTCDate()}</span>${list.slice(0,1).map(l=>`<span class="day-event ${l.state.startsWith('pending')?'pending':''}"><span class="day-event-label">${timeText(l.start)} ${esc(names(l))}</span></span>`).join('')}${list.length>1?`<span class="day-more">+${list.length-1} 节</span>`:''}</button>`;}).join('');
 const today=visibleLessons().filter(l=>l.date===selectedDate);
 return `<div class="page-actions"><p class="muted">点选日期，查看或安排课程。</p>${button(icon('plus')+(role==='coach'?'添加课程':'申请约课'),'new-booking','btn')}</div><div class="panel calendar"><div class="calendar-toolbar"><div><h2>${year} 年 ${m} 月</h2><p class="sub">${role==='coach'?'课程安排与预约':'你的课程与预约'}</p></div><div class="calendar-controls">${button(icon('left'),'month-prev','icon-button','aria-label="上个月"')}${button('今天','today','btn')}${button(icon('right'),'month-next','icon-button','aria-label="下个月"')}</div></div><div class="weekdays">${['一','二','三','四','五','六','日'].map(d=>`<span>周${d}</span>`).join('')}</div><div class="calendar-grid">${cells}</div><div class="calendar-legend"><span><i class="legend-dot"></i>课程</span><span><i class="legend-dot amber"></i>待确认</span><span style="margin-left:auto">点击日期查看</span></div></div><div class="week-summary"><strong>${dateText(selectedDate)} · ${today.length} 节课 / ${moneyless(today.reduce((n,l)=>n+l.duration,0)/60)} 小时</strong><span>点击日期查看，也可以直接添加课程。</span></div>`;
}
function renderAside() {
 if(result&&view!=='home'&&!result.context&&!useOperationSheet()) return renderResult();
 if(lessonId) return renderLesson();
 if(view==='home'||view==='schedule') return canView('schedule')?renderAgenda():'';
 if(view==='students') return renderStudent();
 if(view==='availability') return can('schedule.read')?renderRules():'';
 if(view==='stats') return role==='student'||can('schedule.read')?renderHeatmap():'';
 if(view==='progress') return renderStudent();
 if(view==='inbox') return `<div class="panel panel-pad"><span class="activity-label">消息记录</span><h2 style="margin-top:10px">每个确认，都有回音。</h2><p class="sub" style="line-height:1.8;margin-top:12px">预约、课后反馈与课时核对，都留在这里。确认预约后，另一方的日程会同步显示。</p><div class="notice">消息保存在对应教练的课程记录中；对方登录后可查看。暂不发送微信或短信通知。</div></div>`;
 return `<div class="panel panel-pad"><span class="overline">ONE INPUT</span><h2 style="margin-top:10px">说一句，然后核对。</h2><div class="detail-lines"><div class="detail-line"><span>01 / 输入</span><span>描述你想做的事</span></div><div class="detail-line"><span>02 / 核对</span><span>查看结果，修改误解</span></div><div class="detail-line"><span>03 / 确认</span><span>写入日程与记录</span></div></div><p class="sub">可以说一句生成草稿，也可以通过按钮、下拉菜单和表单直接完成。</p></div>`;
}
function renderAgenda() {
 const list=visibleLessons().filter(l=>l.date===selectedDate).sort((a,b)=>a.start-b.start);
 return `<div class="panel"><div class="panel-head"><div class="between"><h2 class="side-title"><span class="day-display">${Number(selectedDate.slice(8))}</span>周${dayOf(selectedDate)}</h2><span class="pill gray">${list.length} 节课</span></div><p class="sub">${dateText(selectedDate)}${selectedDate===TODAY?' · 今天':''}</p></div><div class="agenda-list">${list.length?list.map(l=>`<button class="lesson-item ${l.state==='done'?'completed':l.state.startsWith('pending')?'waiting':''}" data-action="lesson" data-id="${l.id}"><div class="between"><span class="lesson-time">${timeText(l.start)} – ${timeText(l.start+l.duration)}</span>${lessonOptions(l)}</div><div class="lesson-name">${esc(names(l))}</div><p class="lesson-meta">${l.type} · ${esc(venue(l.venue)?.name)}</p></button>`).join(''):`<div class="empty">${icon('calendar')}<h3>这一天还没有课程</h3><p>在下方输入框说一句，就能开始安排。</p></div>`}</div>${list.length?`<div class="agenda-next">${role==='coach'?'课间转场预留 '+data.settings.travel+' 分钟':'预约确认后会显示在这里'}</div>`:''}</div>`;
}
function renderLesson() {
 const l=data.lessons.find(x=>x.id===lessonId);
 if(!l) return renderAgenda();
 const note=data.notes.find(n=>n.lesson===l.id && (role==='coach'||n.published));
 return `<div class="panel panel-pad">${button(icon('left')+'当天课程','detail-close','back-button')}<div class="between"><h2>${esc(names(l))}</h2>${lessonOptions(l)}</div><p class="sub">${l.type} · ${dateText(l.date)}</p><div class="detail-lines"><div class="detail-line"><span>时间</span><span>${timeText(l.start)} – ${timeText(l.start+l.duration)}</span></div><div class="detail-line"><span>场地</span><span>${esc(venue(l.venue)?.name)}<br>${esc(venue(l.venue)?.court)}</span></div><div class="detail-line"><span>时长</span><span>${l.duration} 分钟</span></div></div><div class="note-block"><h3>${role==='coach'?'课程安排':'本节重点'}</h3><p>${esc(l.note)}</p></div>${note?`<div class="note-block"><h3>课后记录</h3><p>${esc(role==='coach'?note.observation:note.feedback)}</p></div>`:''}<div class="notice">${l.state==='done'?'记录已保存；账本可在课时统计中核对。':'上课完成后，记录实际时长并确认，才会扣减课时。'}</div>${role==='coach'?`<div class="detail-actions">${l.state==='confirmed'&&l.date<=TODAY&&l.students.length===1?button(icon('check')+'记录上课','new-record','btn primary','data-id="'+l.id+'"'):''}${button(icon('edit')+'编辑课程','edit-lesson','btn','data-id="'+l.id+'"')}</div>`:''}</div>`;
}
function renderStudents() {
 const list=data.students.filter(s=>(s.name+s.goal).toLowerCase().includes(search.toLowerCase()));
 return `<div class="page-actions"><p class="muted">名单、课时与训练记录。</p>${button(icon('plus')+'添加学员','new-student','btn')}</div><div class="panel"><div class="list-toolbar"><h2>全部学员 <span class="muted" style="font-weight:400;font-size:13px">${data.students.length}</span></h2><input class="search-field" id="student-search" aria-label="搜索已有学员" placeholder="搜索姓名或目标" value="${esc(search)}"></div><div class="table-head"><span>学员</span><span class="student-goal">练习目标</span><span class="right">余课时</span><span class="right">最近上课</span></div><div id="student-list">${list.length?list.map(s=>`<button class="student-row ${s.id===studentId?'selected':''}" data-action="student" data-id="${s.id}"><span class="student-name"><span class="mini-avatar">${esc(s.initial)}</span>${esc(s.name)}</span><span class="student-goal muted">${esc(s.goal)}</span><span class="balance num">${moneyless(balanceOf(data,s.id))}</span><span class="last-date">${s.last?s.last.slice(5).replace('-',' / '):'尚未上课'}</span></button>`).join(''):'<div class="empty">没有找到这个学员</div>'}</div><div class="panel-foot">1 课时 = 60 分钟 · 余额来自已确认的课时记录</div></div>`;
}
function renderStudent() {
 const s=student(role==='student'?selfStudentId:studentId);if(!s)return '<div class="panel empty">还没有可查看的学员，添加学员后即可管理课程和课时。</div>';const notes=data.notes.filter(n=>n.student===s.id&&(role==='coach'||n.published)).sort((a,b)=>b.date.localeCompare(a.date));
 return `<div class="panel"><div class="panel-pad"><div class="student-detail-head"><span class="mini-avatar">${esc(s.initial)}</span><div><h2>${esc(s.name)}</h2><p class="sub">${esc(s.goal)}</p></div>${role==='coach'?button(icon('edit'),'edit-student','icon-button','aria-label="纠正学员资料" style="margin-left:auto"'):''}</div><div class="student-balance"><span class="muted">剩余课时</span><span><strong>${moneyless(balanceOf(data,s.id))}</strong><small class="muted">　课时</small></span></div>${role==='coach'?`${studentConnection(s)}<div class="detail-actions">${button('安排课程','new-booking','btn')}${button('登记课时','new-credit','btn')}</div><div class="note-block"><h3>下次练什么</h3><p>${esc(s.next||'还没有训练安排。')}</p></div>`:''}</div>${notes.slice(0,3).map(n=>`<article class="note-history"><time>${dateText(n.date)}</time><h3>${esc(n.topic)}</h3><p>${esc(role==='coach'?n.observation:n.feedback)}</p>${role==='coach'?`<p style="margin-top:6px;color:var(--dim)">${n.published?'反馈已对学员可见':'仅教练可见'}</p>`:''}</article>`).join('')}${!notes.length?'<div class="empty">还没有训练记录</div>':''}${role==='coach'&&can('practice.read')?`<section class="shared-practice"><div class="panel-head"><h3>学员共享的练习</h3><p class="sub">学员主动共享后才会显示在这里。</p></div>${data.studentPractice.filter(p=>p.student===s.id&&p.shared).map(p=>`<article class="note-history"><time>${dateText(p.date)}</time><h3>${esc(p.topic)}</h3><p>${esc(p.text)}</p></article>`).join('')||'<p class="empty">这位学员还没有共享练习。</p>'}</section>`:''}${role==='coach'?data.followups.filter(f=>f.students.includes(s.id)).map(f=>`<article class="note-history"><div class="between"><h3>回访草稿</h3>${button('纠错','edit-followup','text-button',`data-id="${f.id}"`)}</div><time>${dateText(f.date)} · 未发送</time><p>${esc(f.text)}</p></article>`).join(''):''}</div>`;
}
function renderVenues() {
 if(!can('venues.read'))return '<div class="panel panel-pad"><h2>场地资料</h2><p class="sub">当前账号未获查看场地资料的权限；可在开放时间中查看已授权规则。</p></div>';
 return `<div class="page-actions"><p class="muted">管理常用场地与可约时段。</p>${button(icon('plus')+'添加场地','new-venue','btn')}</div><div class="panel"><div class="panel-head"><h2>常用场地</h2><p class="sub">课程与开放时间，使用同一份场地资料。</p></div>${data.venues.map(v=>`<article class="venue-row"><div class="court-drawing">${icon('court')}</div><div class="between"><h2>${esc(v.name)}</h2>${button(icon('edit'),'edit-venue','icon-button',`data-id="${v.id}" aria-label="纠正${esc(v.name)}资料"`)}</div><p class="sub">${esc(v.address)}</p><div class="flex" style="margin-top:12px"><span class="pill gray">${esc(v.court)}</span><span class="pill gray">${v.indoor?'室内':'室外'}</span></div></article>`).join('')}<div class="panel-foot">场地资料由这位教练及其授权团队管理。地图定位尚未接入此版本。</div></div>`;
}
function renderRules() {
 return `<div class="panel"><div class="panel-head between"><h2>开放时间</h2>${button(icon('plus'),'new-rule','icon-button','aria-label="添加开放时段"')}${button(icon('edit'),'edit-base','icon-button','aria-label="纠正常规开放时间"')}</div><div class="rule-row"><h3>常规可约时间</h3><div class="weekday-list">${['一','二','三','四','五','六','日'].map(d=>`<span class="${data.settings.days.includes(d)?'open':''}">${d}</span>`).join('')}</div><div class="between"><strong class="num">${data.settings.start} — ${data.settings.end}</strong><span class="muted">跨场地 ${data.settings.travel} 分钟</span></div></div>${data.availabilityRules.map(r=>`<div class="rule-row"><div class="between"><h3>每周${r.day} · ${esc(venue(r.venue)?.name)}</h3>${button(icon('edit'),'edit-rule','icon-button',`data-id="${r.id}" aria-label="纠正这条开放规则"`)}</div><p class="sub">${r.from} 至 ${r.to}</p><p style="margin-top:10px">${r.start} — ${r.end}　·　间隔 ${r.gap} 分钟</p><p class="sub">既有预约保留；新申请按此规则校验。</p></div>`).join('')}<div class="panel-foot">可以在下方说：“下个月每周二在滨江，14:00到18:00，课间留15分钟。”</div></div>`;
}
function statsData(period=month,filterStudent=null) {
 const list=visibleLessons().filter(l=>l.date.slice(0,7)===period&&(!filterStudent||l.students.includes(filterStudent)));
 const done=list.filter(l=>l.state==='done');
 return {list,done,hours:done.reduce((n,l)=>n+l.duration/60,0),planned:list.reduce((n,l)=>n+l.duration/60,0)};
}
function renderStats() {
 const {list,done,hours,planned}=statsData(), roster=role==='coach'?data.students:data.students.filter(s=>s.id===selfStudentId);
 const [year,m]=month.split('-').map(Number);
 const consumed=data.ledger.filter(e=>e.date.slice(0,7)===month&&e.delta<0&&(role==='coach'||e.student===selfStudentId)).reduce((n,e)=>n-e.delta,0);
 return `<div class="panel"><div class="panel-head between"><div><h2>${year} 年 ${m} 月</h2><p class="sub">${role==='coach'?'已记录课程与课时使用':'我的课程与课时使用'}</p></div><div class="flex">${button(icon('left'),'month-prev','icon-button','aria-label="统计上个月"')}${button(icon('right'),'month-next','icon-button','aria-label="统计下个月"')}</div></div><div class="metric-line"><div class="metric"><small>${role==='student'?'已完成上课':'已完成授课'}</small><strong>${moneyless(role==='student'||can('schedule.read')?hours:null)}<span class="unit">小时</span></strong><small>${role==='student'||can('schedule.read')?done.length+' 节有课程明细':'未获日程权限'}</small></div><div class="metric"><small>本月安排</small><strong>${moneyless(role==='student'||can('schedule.read')?planned:null)}<span class="unit">小时</span></strong><small>${role==='student'||can('schedule.read')?'共 '+list.length+' 节，含待确认':'未获日程权限'}</small></div><div class="metric"><small>账本已消课</small><strong>${moneyless(data.canReadLedger?consumed:null)}<span class="unit">课时</span></strong><small>按已记录消课</small></div></div><div class="bar-chart"><div class="between"><h3>${role==='coach'?'学员剩余课时':'我的课时余额'}</h3><small class="muted">按当前授权账本</small></div>${roster.map(s=>`<div class="bar-row"><span>${esc(s.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100,Math.max(0,balanceOf(data,s.id)/Math.max(10,...roster.map(s=>balanceOf(data,s.id)))*100))}%"></div></div><span class="bar-value num">${moneyless(balanceOf(data,s.id))}</span></div>`).join('')}</div><div class="panel-foot">统计只使用这位教练与你之间有权读取的课程和课时记录。</div></div>${role==='student'?`<div class="panel panel-pad" style="margin-top:16px"><h2>课时账本</h2>${renderLedger(selfStudentId)}</div>`:''}`;
}
function renderHeatmap() {
 const {done}=statsData(),count=new Date(Number(month.slice(0,4)),Number(month.slice(5)),0).getDate();
 return `<div class="panel panel-pad"><span class="overline">COURT TIME</span><h2 style="margin-top:8px">${role==='student'?'上课热力图':'授课热力图'}</h2><p class="sub">只统计已完成、且有明细的课程</p><div class="heatmap">${Array.from({length:count},(_,i)=>{const date=month+'-'+String(i+1).padStart(2,'0'),hrs=done.filter(l=>l.date===date).reduce((n,l)=>n+l.duration/60,0);return `<span class="heat-cell ${hrs>=2?'busy':hrs?'medium':''}" title="${date}：${hrs}小时" role="img" aria-label="${date}，已完成 ${hrs} 小时">${i+1}</span>`}).join('')}</div><div class="between" style="margin-top:14px;font-size:11px;color:var(--muted)"><span>无已完成课程</span><span>较多课时</span></div><div class="notice">数据不足时保留空白。没有记录的日期，不由 AI 补出课程。</div></div>`;
}
function renderInbox() {
 let list=data.messages.filter(m=>role==='coach'?m.kind!=='feedback'&&m.kind!=='proposal':m.student===selfStudentId&&(m.kind==='feedback'||m.kind==='proposal'||m.kind==='status'||m.kind==='booking')).slice().reverse();
 if(inboxFilter!=='all')list=list.filter(m=>inboxFilter==='pending'?m.state==='pending':m.state!=='pending');
 return `<div class="page-actions"><div><h2>预约与反馈</h2><p class="sub">直接处理，或写一句处理意见。</p></div><label class="filter-control">显示<select id="inbox-filter" aria-label="筛选消息"><option value="all"${selected(inboxFilter,'all')}>全部消息</option><option value="pending"${selected(inboxFilter,'pending')}>待处理</option><option value="done"${selected(inboxFilter,'done')}>已处理</option></select></label></div><div class="work-feed">${list.length?list.map(renderMessageCard).join(''):'<div class="panel empty">当前筛选下没有消息</div>'}</div>`;
}

function renderProgress() {return `<div class="page-actions"><p class="muted">查看反馈，记录自己的练习。</p>${button(icon('plus')+'记录练习','new-practice','btn')}</div><div class="panel"><div class="panel-head"><h2>自主练习</h2><p class="sub">记下自己的感觉，留给下一次上课。</p></div>${data.studentPractice.length?data.studentPractice.map(p=>`<article class="note-history"><time>${dateText(p.date)}</time><h3>${esc(p.topic)}</h3><p>${esc(p.text)}</p><p class="sub">${p.shared?'已与当前教练共享':'仅本人可见'}</p>${button('修改与共享设置','edit-practice','text-button',`data-id="${p.id}"`)}</article>`).join(''):`<div class="empty">${icon('note')}<h3>练习之后，留下两句话。</h3><p>试试下方“记自主练习”，再修改成自己的描述。</p></div>`}</div>`;}
function renderLedger(id){if(!data.canReadLedger)return '<p class="sub">当前账号未获课时账本权限。</p>';return data.ledger.filter(e=>e.student===id).slice().reverse().map(e=>`<div class="ledger-line"><span>${esc(e.label)}<small>${dateText(e.date)} · ${esc(e.detail)}</small></span><strong class="num ${e.delta>0?'positive':''}">${e.delta>0?'+':''}${moneyless(e.delta)}</strong></div>`).join('')||'<p class="sub">暂无课时记录。</p>';}
function renderAccount(){return accountContent();}
function renderReview(){return `<div class="panel panel-pad"><h2>说一句，或直接操作</h2><p class="sub">日程、学员、场地、收件箱和课时统计共用对应教练的课程资料。AI 先整理草稿，确认后才保存；所有读写均由后台校验权限。</p><div class="notice">身份来自登录账号与团队成员关系。只有已关联的教练与授权的团队会出现在你的账号中。</div><p>${role==='student'?'在个人中心接受教练邀请，查看已关联的教练。':can('team.manage')?'在个人中心关联账号、邀请学员和管理团队。':'在个人中心查看自己的资料和受邀的教学团队。'}自主练习默认仅本人可见，可单独共享。订阅支付、地图定位和微信／手机号登录尚未接入此网站版本。</p></div>`;}

function openManual(action,id) {
 if(role==='student'&&!['new-booking','new-practice'].includes(action))return;
 const base={manual:true,request:'',error:'',revisions:{...session.revisions}};
 switch(action){
 case 'new-booking': result={...base,type:'booking',title:role==='coach'?'添加课程':'申请约课',values:{student:role==='student'?selfStudentId:view==='students'?studentId:'',date:selectedDate,start:'18:30',duration:60,venue:data.venues[0]?.id||'',note:''}};break;
 case 'new-student':result={...base,type:'add-student',title:'添加学员',values:{name:'',goal:''}};break;
 case 'new-venue':result={...base,type:'add-venue',title:'添加常用场地',values:{name:'',address:'',court:'',indoor:false}};break;
 case 'new-rule':result={...base,type:'availability',title:'添加开放时段',values:{from:TODAY,to:TODAY.slice(0,7)+'-'+new Date(Number(TODAY.slice(0,4)),Number(TODAY.slice(5,7)),0).getDate(),day:'二',start:'14:00',end:'18:00',gap:15,venue:data.venues[0]?.id||'',preserve:false}};break;
 case 'new-credit':result={...base,type:'credit',title:'登记课时包',values:{student:studentId,amount:10,note:'教练登记课时购买'}};break;
 case 'new-practice':result={...base,type:'practice',title:'记录自主练习',values:{date:TODAY,topic:'',text:''}};break;
 case 'new-record':{const l=data.lessons.find(x=>x.id===id);if(!l||l.state!=='confirmed'||l.students.length!==1)return;result={...base,type:'record',title:'记录上课',lesson:id,values:{duration:l.duration,observation:'',next:student(l.students[0]).next,feedback:'',publish:false}};break;}
 }
 profileOpen=false;render();revealResult();
}
function followupCandidates() {
 return data.students.filter(s=>s.last&&(Date.parse(TODAY)-Date.parse(s.last))/86400000>=21&&balanceOf(data,s.id)>0&&!data.lessons.some(l=>l.students.includes(s.id)&&l.date>TODAY&&l.state!=='cancelled')).map(s=>s.id);
}
async function interpretCommand(text,context=null,reviewedPlan=null,continuation=null) {
 if(session.submission||result?.uncertain||result?.commitId){toast('请先核对上次提交结果。');return;}
 const q=text.trim();if(!q||aiRequest||submitting||!session.ready)return;if(q.length>1600){toast('这段描述较长，请缩短到 1600 字以内。');return;}
 if(context&&!isActionable(data.messages.find(m=>m.id===context))){toast('这条预约已处理，请重新打开。');return;}
 if(context)contextInputs[context]=q;else inputValue=q;
 const selection={month,...(view==='students'&&studentId?{selectedStudent:studentId}:{}),...(lessonId?{selectedLesson:lessonId}:{}),...(context?{messageId:context}:{})};const revision=session.workspace.revision,epoch=++aiEpoch,controller=new AbortController();aiRequest=controller;
 lastAI={text:q,context,reviewedPlan,continuation};result={type:'loading',title:'正在整理这句话',request:q,context};render();revealResult();
 const timeout=setTimeout(()=>controller.abort('timeout'),55000);
 try {
  const body=await api(path('plans/generate'),'POST',{text:q,selection,...(reviewedPlan?{reviewedPlan}:{}),...(continuation?.taskId?{taskId:continuation.taskId}:{}),...(continuation?.resolution?{resolution:continuation.resolution}:{})},controller.signal);
  if(epoch!==aiEpoch)return;
  if(!body.plan)throw Error('没有收到完整的操作草稿，请重试。');
  if(await refreshAuthorized(revision)){restoreSubmission();render();return;}if(epoch!==aiEpoch)return;
  result=toPlan(body.plan,{data,role,request:q,context,followupIds:body.followupIds||[],selfStudentId});
  result.aiMeta=body.meta;result.revisions=body.revisions;result.taskId=body.id;result.sourcePlan=clone(body.plan);if(continuation?.originalRequest)result.request=continuation.originalRequest;
  if(continuation?.fallback){const previous=continuation.fallback.type==='plan'?continuation.fallback.steps:[continuation.fallback];for(const step of result.type==='plan'?result.steps:[result]){const old=previous.find(p=>p.id===step.id);if(old?.values?.student==='__new__'&&step.unknownName===old.unknownName&&!step.values.student)step.values.student='__new__';}}
  if(result.type==='summary'&&result.month)month=result.month;
  aiState='ready';
 }catch(error){
  if(epoch!==aiEpoch)return;
  if(['AI_NOT_CONFIGURED','MODEL_NOT_CONFIGURED'].includes(error.code))aiState='missing';
  result={type:'ai-error',title:['AI_NOT_CONFIGURED','MODEL_NOT_CONFIGURED'].includes(error.code)?'AI 还未连接':'这次没有生成操作',request:q,context,code:error.code,message:controller.signal.aborted?'等待时间较长，你可以重试或使用直接操作。':error.message||'网络暂不可用，请稍后重试。'};
  if(continuation?.fallback||[403,404,409].includes(error.status)||['STALE_PLAN','TASK_NOT_FOUND'].includes(error.code)){
   // A failed model call can coincide with revoked access. Revalidate before
   // showing cached fields; an unreachable authorization service fails closed.
   try{if(await refreshAuthorized(revision)){restoreSubmission();render();return;}}
   catch(checkError){if(epoch!==aiEpoch)return;clearSession('暂时无法核对当前权限。没有执行这次调整，请重新连接。');render();return;}
   if(epoch!==aiEpoch||!session.ready)return;
   if([403,404,409].includes(error.status)||['STALE_PLAN','TASK_NOT_FOUND'].includes(error.code)){clearPermissionDrafts();result={type:'permission-changed',title:'请重新核对这次操作',message:'资料或权限已变化，旧草稿已清除。'};render();return;}
   if(continuation?.fallback){result=continuation.fallback;result.error='这次调整没有完成，原草稿已保留。'+(error.message||'请稍后重试。');result.amendmentText=q;}
  }
 }finally{clearTimeout(timeout);if(epoch===aiEpoch){aiRequest=null;render();}}
}
function prepareOperationSheet() {
 if(!useOperationSheet()||sheetState)return;
 const active=document.activeElement;
 const form=active?.closest('form');
 const source=form?.id==='command-form'?'#command-form [type=submit]':form?.classList.contains('message-command')?`[data-message="${form.dataset.message}"] [type=submit]`:active?.dataset.action?`[data-action="${active.dataset.action}"]${active.dataset.id?`[data-id="${active.dataset.id}"]`:''}`:null;
 sheetState={y:scrollY,source};
 active?.blur();
 document.body.style.position='fixed';document.body.style.top=`-${sheetState.y}px`;document.body.style.width='100%';
 document.body.classList.add('operation-open');
}
function syncOperationSheet() {
 const dialog=$('#operation-dialog');
 if(useOperationSheet()){
  const scroll=dialog.querySelector('.result-body')?.scrollTop||0,opening=!dialog.open;
  dialog.innerHTML=renderResult(true);
  updateSheetViewport();
  if(opening)dialog.showModal();
  dialog.querySelector('.result-body').scrollTop=scroll;
  if(opening)dialog.querySelector('#operation-title')?.focus({preventScroll:true});
  if(result.error)dialog.querySelector('[role=alert]')?.scrollIntoView({block:'nearest'});
 }else if(sheetState){
  const previous=sheetState;sheetState=null;
  dialog.close();dialog.innerHTML='';
  document.body.style.position='';document.body.style.top='';document.body.style.width='';document.body.classList.remove('operation-open');
  window.scrollTo({top:previous.y,behavior:'instant'});
  if(previous.source)$(previous.source)?.focus({preventScroll:true});
 }
}
function updateSheetViewport() {
 const viewport=window.visualViewport,dialog=$('#operation-dialog');
 if(!dialog)return;
 dialog.style.setProperty('--sheet-height',`${viewport?.height||innerHeight}px`);
 dialog.style.setProperty('--sheet-bottom',`${Math.max(0,innerHeight-(viewport?.height||innerHeight)-(viewport?.offsetTop||0))}px`);
}
function updateComposerViewport(){
 const dock=$('.composer-dock'),input=$('#command-input'),viewport=window.visualViewport;
 if(!dock)return;
 if(input){input.style.height='auto';input.style.height=`${Math.max(44,Math.min(96,input.scrollHeight))}px`;}
 dock.style.bottom=`${Math.max(0,innerHeight-(viewport?.height||innerHeight)-(viewport?.offsetTop||0))}px`;
 document.documentElement.style.setProperty('--composer-space',`${dock.getBoundingClientRect().height}px`);
}
function revealResult() {if(useOperationSheet())return;requestAnimationFrame(()=>{if(view==='home'||result?.context||window.innerWidth<=1050) $('.result-panel')?.scrollIntoView({block:'start',behavior:'smooth'});});}
function field(label,name,value,type='text',extra='') {return `<label class="field">${label}${type==='textarea'?`<textarea name="${name}" aria-label="${esc(label)}" ${extra}>${esc(value)}</textarea>`:`<input type="${type}" name="${name}" aria-label="${esc(label)}" value="${esc(value)}" ${extra}>`}</label>`;}
function selectField(label,name,value,options) {return `<label class="field">${label}<select name="${name}" aria-label="${esc(label)}" required>${options.map(([id,label])=>`<option value="${esc(id)}"${selected(value,id)}>${esc(label)}</option>`).join('')}</select></label>`;}
function entityOptions(type,r){
 const rows=type==='add-student'?data.students:data.venues;
 const prior=result?.type==='plan'?result.steps.slice(0,result.steps.indexOf(r)).filter(s=>s.type===type):[];
 return [...rows.map(s=>[s.id,s.name]),...prior.map(s=>['plan:'+s.id,(s.values.name||'待填写名称')+' · 本次新增'])];
}
const studentsField=(id,r)=>selectField('学员','student',id,[['','请选择学员'],...entityOptions('add-student',r)]);
const venuesField=(id,r)=>selectField('场地','venue',id,[['','请选择场地'],...entityOptions('add-venue',r)]);
function ruleImpact(v) {return data.lessons.filter(l=>l.state!=='cancelled'&&l.venue===v.venue&&l.date>=v.from&&l.date<=v.to&&dayOf(l.date)===v.day&&(l.start<minutes(v.start)||l.start+l.duration>minutes(v.end)));}
function resultBody(r) {
 const v=r.values||{};
 switch(r.type) {
 case 'plan':return renderPlan(r);
 case 'submission-recovery':{const s=r.submission,done=s.state==='committed';return `<p class="result-description">${esc(done?'上次操作已经完成。刷新或重试没有重复执行。':s.state==='pending'?'找到了上次确认的操作，尚未完成。可以继续原操作，或取消后重新填写。':s.state==='unavailable'?'权限已变化，不能查看或继续原操作。请关闭这次提交后重新核对资料。':s.state==='expired'?'上次草稿已过期，没有执行。请关闭后重新填写。':'上次操作已撤销或取消。')}</p>${s.actions.length?`<ul>${s.actions.map(a=>`<li>${esc(a)}</li>`).join('')}</ul>`:''}<div class="detail-actions">${s.state==='pending'?button('继续原操作','submission-retry','btn primary'):''}${button(s.state==='pending'?'取消未执行操作':'我已核对，完成','submission-dismiss','btn')}</div>`;}
 case 'plan-success':return `<ol class="plan-outcomes">${r.outcomes.map(o=>`<li>${icon('check')}<div><h3>${esc(o.title)}</h3><p>${esc(o.message)}</p></div></li>`).join('')}</ol><p class="sub">${undoState?'可撤销本次整组修改。':''}</p><div class="detail-actions">${button('完成','result-close','btn primary')}${undoState?button('撤销整组','undo','btn'):''}</div>`;
 case 'loading':return '<div class="ai-wait" role="status"><span class="ai-spinner" aria-hidden="true"></span><p>正在理解你的意思，整理成可以核对的草稿。</p></div><p class="sub">可以随时关闭；还没有修改任何数据。</p>';
 case 'permission-changed':return `<p class="result-description">${esc(r.message)}</p><div class="detail-actions">${button('返回当前页面','result-close','btn')}</div>`;
 case 'ai-error':return `<p class="result-description" role="alert">${esc(r.message)}</p><div class="detail-actions">${['SIGN_IN_REQUIRED','APP_SIGN_IN_REQUIRED'].includes(r.code)?'<a class="btn primary" href="/login">登录后继续</a>':button('重新尝试','ai-retry','btn')}${button('返回直接操作','result-close','btn')}</div>`;
 case 'clarification':return `<p class="result-description">${esc(r.message)}</p>${renderResolutionChoices(r)}${field('补充说明','clarification','','textarea','maxlength="500"')}<div class="detail-actions">${button('补充后继续','ai-clarify','btn primary')}</div>`;
 case 'resolve-message':return '<p class="result-description">将这条消息标记为已处理。</p>';
 case 'message-decision':{const m=data.messages.find(x=>x.id===r.message),l=data.lessons.find(x=>x.id===m.lesson);return `<p class="result-description">根据你的处理意见，整理为下列操作。请核对再执行。</p>${selectField('要执行的操作','decision',v.decision,[['accept','确认这条预约'],['reject','拒绝这条预约']])}<div class="detail-lines"><div class="detail-line"><span>学员</span><span>${esc(student(m.student).name)}</span></div><div class="detail-line"><span>课程</span><span>${dateText(l.date)} ${timeText(l.start)} · ${l.duration} 分钟</span></div><div class="detail-line"><span>场地</span><span>${esc(venue(l.venue).name)}</span></div></div><div class="notice">执行后会更新预约状态，并在对方的收件箱中留下结果；不会扣减课时。</div>`;}
 case 'record': {const l=data.lessons.find(l=>l.id===r.lesson);return `<p class="result-description">${esc(names(l))} · ${dateText(l.date)} ${timeText(l.start)} · ${esc(venue(l.venue).name)}</p>${field('实际上课时长（分钟）','duration',v.duration,'number','min="15" max="240" step="15" required')}${field('教练记录','observation',v.observation,'textarea','required maxlength="600"')}${field('下次重点','next',v.next,'text','maxlength="200"')}${field('给学员的反馈','feedback',v.feedback,'textarea','maxlength="600"')}<label class="check-field"><input type="checkbox" name="publish" ${v.publish?'checked':''}>确认后将反馈放入学员收件箱</label><div class="notice" id="record-impact">${recordImpact(v.duration,l)}</div>`;}
 case 'booking': return `${role==='student'?`<p class="booking-recipient">接收教练：<strong>${esc(session.workspace.name)}</strong></p>`:''}<p class="result-description">${role==='coach'?'先发送提案，学员确认后进入正式日程。':'提交后等待教练确认。'}预约不会扣减课时。</p>${r.missing?.length?`<div class="notice clarification"><strong>还需核对</strong><p>${r.missing.map(esc).join('<br>')}</p></div>`:''}${role==='coach'?selectField('学员','student',v.student,[['','请选择学员'],...entityOptions('add-student',r),...(r.unknownName?[['__new__','新建学员：'+r.unknownName]]:[])]):''}${r.unknownName?`<p class="new-student-hint" id="new-student-hint">${v.student==='__new__'?`确认提交时同时建立“${esc(r.unknownName)}”的档案，初始余额 0；不会绑定或邀请真实用户。`:'新学员只有在你选择新建并确认提交后才会建立档案。'}</p>`:''}${field('日期','date',v.date,'date','required min="'+TODAY+'"')}<div class="form-row">${field('开始时间','start',v.start,'time','required')}${field('时长（分钟）','duration',v.duration,'number','min="15" max="240" step="15" required')}</div>${venuesField(v.venue,r)}${field('练习内容','note',v.note,'textarea','maxlength="300"')}`;
 case 'availability': {const impacts=ruleImpact(v);return `<p class="result-description">确认日期、场地和课间间隔。规则只约束新预约。</p><div class="form-row">${field('生效日期','from',v.from,'date','required')}${field('结束日期','to',v.to,'date','required')}</div>${selectField('每周','day',v.day,['','一','二','三','四','五','六','日'].map(d=>[d,d?'周'+d:'请选择星期']))}${venuesField(v.venue,r)}<div class="form-row">${field('开放时间','start',v.start,'time','required')}${field('结束时间','end',v.end,'time','required')}</div>${field('同场地课间间隔（分钟）','gap',v.gap,'number','min="0" max="120" step="5" required')}<div class="notice warning" id="rule-impact">${impactText(impacts)}</div><label class="check-field"><input type="checkbox" name="preserve" ${v.preserve?'checked':''} required>保留既有预约，不自动改课或取消；新预约按这条规则检查。</label>`;}
 case 'followup': return r.eligible.length?`<p class="result-description">${r.eligible.length} 位学员：至少 21 天未上课、有剩余课时，且没有未来预约。</p>${r.eligible.map(id=>`<div class="detail-line" style="margin-bottom:14px"><span>${esc(student(id).name)} · ${Math.floor((Date.parse(TODAY)-Date.parse(student(id).last))/86400000)} 天未上课</span><span>${moneyless(balanceOf(data,id))} 课时</span></div>`).join('')}${field('回访内容（可修改）','text',v.text,'textarea','required maxlength="600"')}<div class="notice">这里只保存回访草稿，不会自动向学员发送消息。</div>`:'<p class="result-description">当前没有符合条件的学员。没有创建回访任务。</p>';
 case 'add-student': return `${field('姓名','name',v.name,'text','required maxlength="20"')}${field('训练目标','goal',v.goal,'text','maxlength="100"')}<div class="notice">初始余额为 0；没有上课记录。录入档案不会自动绑定或邀请真实用户。</div>`;
 case 'edit-student': return `${field('姓名','name',v.name,'text','required maxlength="20"')}${field('训练目标','goal',v.goal,'text','maxlength="100"')}${field('下次练习','next',v.next,'textarea','maxlength="300"')}`;
 case 'credit': return `${studentsField(v.student,r)}${field('增加课时','amount',v.amount,'number','required min="0.5" max="500" step="0.5"')}${field('登记备注','note',v.note,'text','required maxlength="200"')}<div class="notice">只登记已经发生的课时购买；不发起真实扣款。</div>`;
 case 'edit-practice':
 case 'practice': return `${field('练习日期','date',v.date||TODAY,'date',`required max="${TODAY}"`)}${field('练习主题','topic',v.topic,'text','required maxlength="60"')}${field('练习记录','text',v.text,'textarea','required maxlength="600"')}<label class="check-field"><input type="checkbox" name="shared" ${v.shared?'checked':''}>与当前教练共享这条练习</label><div class="notice">默认仅本人可见。取消共享后，教练后续读取不再包含这条练习。</div>`;
 case 'add-venue':
 case 'edit-venue': return `${field('场地名称','name',v.name,'text','required maxlength="60"')}${field('地址','address',v.address,'textarea','required maxlength="200"')}${field('球场','court',v.court,'text','required maxlength="30"')}${selectField('类型','indoor',String(v.indoor),[['','请选择类型'],['false','室外'],['true','室内']])}<div class="notice">此处保存场地文字资料；当前版本未接入地图定位。</div>`;
 case 'edit-base': return `<fieldset class="days-field"><legend>每周开放日</legend>${['一','二','三','四','五','六','日'].map(d=>`<label><input type="checkbox" name="open-day" value="${d}" ${v.days.includes(d)?'checked':''}>周${d}</label>`).join('')}</fieldset><div class="form-row">${field('开始','start',v.start,'time','required')}${field('结束','end',v.end,'time','required')}</div>${field('跨场地预留（分钟）','travel',v.travel,'number','required min="0" max="180" step="5"')}<div class="notice">已有预约保留，调整只用于后续新预约。</div>`;
 case 'edit-lesson': {const l=data.lessons.find(l=>l.id===r.lesson),linked=data.ledger.some(e=>e.lesson===l.id);return `<p class="result-description">${esc(names(l))} · ${dateText(l.date)} ${timeText(l.start)}</p>${l.state==='done'&&!linked?'<div class="notice">历史消课为合并记录；这节课仅支持纠正备注，避免改错账本。</div>':field('时长（分钟）','duration',v.duration,'number','min="15" max="240" step="15" required')}${field('课程记录','note',v.note,'textarea','required maxlength="600"')}${linked?'<div class="notice">时长变化会修正这节课原来的消课条目，不重复新增扣款。</div>':''}`;}
 case 'balance': return `<p class="result-description">${esc(student(r.student).name)} 的剩余课时，按已确认账本逐笔加总。</p><div class="answer-value">${moneyless(balanceOf(data,r.student))}<small>课时</small></div>${renderLedger(r.student)}`;
 case 'summary': {const period=r.month||month,{done,hours,planned}=statsData(period,r.student);return `<p class="result-description">按${r.student?esc(student(r.student).name):'这位教练'} ${period} 的授权课程明细计算。</p><div class="answer-value">${moneyless(hours)}<small>${role==='student'?'已上课小时':'已授课小时'}</small></div><div class="detail-lines"><div class="detail-line"><span>已完成课程</span><span>${done.length} 节</span></div><div class="detail-line"><span>全部安排（含待确认）</span><span>${moneyless(planned)} 小时</span></div></div><div class="notice">没有完整课程明细的历史消课不计入这里。已完成课程与课时账本分别统计。</div>`;}
 case 'message': {const m=data.messages.find(m=>m.id===r.message), l=data.lessons.find(l=>l.id===m.lesson);return `<p class="result-description">${esc(m.text)}</p>${l?`<div class="detail-lines"><div class="detail-line"><span>课程</span><span>${dateText(l.date)} ${timeText(l.start)}</span></div><div class="detail-line"><span>场地</span><span>${esc(venue(l.venue).name)}</span></div><div class="detail-line"><span>时长</span><span>${l.duration} 分钟</span></div><div class="detail-line"><span>当前状态</span><span>${stateText(l.state)}</span></div></div>`:''}${m.kind==='balance'?`<div class="answer-value">${moneyless(balanceOf(data,m.student))}<small>当前剩余课时</small></div>${renderLedger(m.student)}`:''}${m.state==='pending'&&(m.kind==='booking'||m.kind==='proposal')?'<div class="notice">确认后会更新双方日程，并在对方收件箱中留下确认结果。不会消课。</div>':''}`;}
 case 'success': return `<div class="success-icon">${icon('check')}</div><h2 class="result-title" id="operation-title" tabindex="-1">${esc(r.title)}</h2><p class="result-description">${esc(r.message)}</p>${r.link?`<a class="btn" href="#${r.link}">查看${pageNames[r.link][0]} ${icon('arrow')}</a>`:''}`;

 default: return `<p class="result-description">${esc(r.message)}</p>`;
 }
}
function recordImpact(duration,l) {const n=Number(duration)/60,b=balanceOf(data,l.students[0]);return `本次扣除 ${moneyless(n)} 课时 · 余额 ${moneyless(b)} → ${moneyless(b-n)}。仅在确认后记录，重复提交不会再次扣减。`;}
function impactText(list) {return list.length?`${list.length} 节既有预约与新规则不一致：${list.map(l=>`${names(l)} · ${dateText(l.date)} ${timeText(l.start)}`).join('；')}。保留这些预约，并单独处理。`:'没有发现与这条规则不一致的既有预约。';}
const operationNames={booking:'安排课程',record:'记录上课',availability:'开放时段','add-venue':'添加场地','add-student':'添加学员','edit-student':'更新学员',credit:'登记课时',practice:'记录练习','message-decision':'处理预约',balance:'核对课时',summary:'查看统计',followup:'回访草稿',clarification:'需要补充'};
function stepSummary(r){
 const v=r.values||{};
 if(r.type==='add-venue')return v.name||'待填写场地名称';
 if(r.type==='add-student')return v.name||'待填写姓名';
 if(r.type==='booking')return [student(v.student)?.name||r.unknownName||'待选学员',v.date?dateText(v.date):'待选日期',v.start||'待填时间',venue(v.venue)?.name||'待选场地'].join(' · ');
 if(r.type==='availability')return [`每周${v.day||'？'}`,v.start&&v.end?`${v.start}–${v.end}`:'待填时段',venue(v.venue)?.name||'待选场地'].join(' · ');
 if(r.type==='credit')return `${student(v.student)?.name||'待选学员'} · 增加 ${v.amount||'？'} 课时`;
 return r.title||operationNames[r.type]||'核对操作';
}
function stepStatus(r,index){return result.errorIndex===index?'请检查':r.type==='clarification'?'待补充':missingFields(r).length?`待补 ${missingFields(r).length} 项`:['balance','summary'].includes(r.type)?'查询':'待确认';}
function renderPlan(r){
 if(!r.steps.some(s=>s.open!==undefined)){
  const first=r.steps.findIndex(s=>missingFields(s).length||s.type==='clarification');
  r.steps.forEach((s,i)=>s.open=i===first);
 }
 return `<p class="plan-help">按下面的顺序一起处理。点开每一步可修改；全部通过检查后才保存。</p><ol class="operation-plan">${r.steps.map((s,i)=>{
  const dependencies=s.dependsOn.map(id=>r.steps.findIndex(x=>x.id===id)+1);
  const fields=(['balance','summary'].includes(s.type)?'<p class="result-description">执行到这一步时，会按前面操作更新后的记录重新计算，并在完成清单中展示结果。</p>':resultBody(s)).replace(/id="(record-impact|rule-impact|new-student-hint)"/g,'data-detail="$1"');
  return `<li><details class="plan-step" data-step-index="${i}" ${s.open?'open':''}><summary><span class="step-number">${i+1}</span><span class="step-heading"><strong>${operationNames[s.type]||'核对操作'}</strong><span class="step-summary">${esc(stepSummary(s))}</span></span><span class="step-status">${stepStatus(s,i)}</span>${icon('down')}</summary><div class="step-fields">${dependencies.length?`<p class="step-dependency">接第 ${dependencies.join('、')} 步${s.values?.venue?.startsWith('plan:')?' · 自动使用本次新增场地':''}${s.values?.student?.startsWith('plan:')?' · 自动使用本次新增学员':''}</p>`:''}${fields}</div></details></li>`;
 }).join('')}</ol><p class="plan-note">约课仍需对方确认，不会直接扣课时。可以取消整组。未发生后续修改时，可撤销本次整组操作。</p>`;
}
function readPlanValues(){
 if(result?.type!=='plan')return;
 document.querySelectorAll('#result-form [data-step-index]').forEach(block=>{
  const r=result.steps[Number(block.dataset.stepIndex)];r.open=block.open;if(!r.values)return;
  block.querySelectorAll('input[name],textarea[name],select[name]').forEach(el=>{r.values[el.name]=el.type==='checkbox'?el.checked:['duration','amount','gap','travel'].includes(el.name)&&el.value!==''?Number(el.value):el.value;});
  if(r.type==='edit-base')r.values.days=[...block.querySelectorAll('[name="open-day"]:checked')].map(el=>el.value);
  for(const key of ['student','venue'])if(r.values[key]?.startsWith('plan:')){const id=r.values[key].slice(5);if(!r.dependsOn.includes(id))r.dependsOn.push(id);}
 });
}
function updatePlanLabels(){
 if(result?.type!=='plan')return;
 result.error='';delete result.errorIndex;
 document.querySelector('#result-form [role=alert]')?.remove();
 document.querySelectorAll('#result-form [data-step-index]').forEach(block=>{
  const i=Number(block.dataset.stepIndex),r=result.steps[i];
  block.querySelector('.step-summary').textContent=stepSummary(r);block.querySelector('.step-status').textContent=stepStatus(r,i);
  block.querySelectorAll('option[value^="plan:"]').forEach(option=>{const item=student(option.value)||venue(option.value);if(item)option.textContent=(item.name||'待填写名称')+' · 本次新增';});
  if(r.type==='availability')block.querySelector('[data-detail="rule-impact"]').textContent=impactText(ruleImpact(r.values));
  if(r.type==='record')block.querySelector('[data-detail="record-impact"]').textContent=recordImpact(r.values.duration,data.lessons.find(l=>l.id===r.lesson));
  if(r.unknownName)block.querySelector('[data-detail="new-student-hint"]').textContent=r.values.student==='__new__'?`确认时会建立“${r.unknownName}”档案。`:'选择新建并确认后才会建立档案。';
 });
}
function canCommit(r) {if(r.type==='plan')return !r.steps.some(s=>s.type==='clarification');return ['message-decision','record','booking','availability','add-venue','add-student','edit-student','credit','practice','edit-venue','edit-base','edit-lesson','edit-practice','resolve-message','balance','summary'].includes(r.type)||(r.type==='followup'&&r.eligible.length);}
// Only editable form fields overlay the authoritative draft. Unrepresented fields
// (notes, explanations, identifiers) keep their exact server values across turns.
const editFields={booking:['studentId','date','start','duration','venueId','note'],record:['duration','observation','next','feedback','publish'],availability:['from','to','day','start','end','gap','venueId'],'add-student':['studentName','goal'],'edit-student':['studentName','goal','next'],credit:['studentId','amount','note'],practice:['date','name','text','shared'],'edit-practice':['date','name','text','shared'],'add-venue':['name','address','court','indoor'],'edit-venue':['name','address','court','indoor'],'edit-base':['days','start','end','travel'],'edit-lesson':['duration','note'],followup:['text'],'message-decision':['decision']};
function reviewedAIPlan(r){
 const form=clone(r);for(const step of form.type==='plan'?form.steps:[form])if(step.values?.student==='__new__')step.values.student='';
 const fromForm=serverPlan(form);if(!r.sourcePlan)return fromForm;
 const base=clone(r.sourcePlan);
 for(const step of base.steps){const edited=fromForm.steps.find(s=>s.id===step.id);if(!edited)continue;for(const key of editFields[step.operation.intent]||[])step.operation[key]=edited.operation[key];}
 return base;
}
function continueAI(text,resolution=null){
 if(!result?.taskId)return;
 if(result.type==='plan')readPlanValues();else if(result.values)result.values=readValues();
 const fallback=clone(result),reviewed=result.type==='clarification'?null:reviewedAIPlan(result);
 interpretCommand(text,result.context,reviewed,{taskId:result.taskId,resolution,originalRequest:result.request,fallback});
}
function renderResolutionChoices(r){
 const c=r.aiMeta?.understanding?.clarification;if(!c?.choices?.length)return '';
 return `<div class="resolution-choices" aria-label="选择对应资料">${c.choices.map(choice=>button(esc(choice.label),'ai-resolve','btn',`data-id="${esc(choice.id)}"`)).join('')}</div>`;
}
function renderAmendment(r){
 if(!r.taskId||r.manual||['clarification','loading','success','ai-error','submission-recovery'].includes(r.type))return '';
 const a=r.aiMeta?.amendment;
 return `<div class="draft-amendment"><label class="field">继续调整<textarea name="amendment" aria-label="继续调整" maxlength="500" placeholder="例如：第二项改成90分钟，其他不动">${esc(r.amendmentText||'')}</textarea></label>${a?.question?`<p class="amendment-status" role="status">${esc(a.question)} 原草稿已保留。</p>`:a?.status==='patched'?`<p class="amendment-status" role="status">${esc(a.explanation||'已更新你指定的内容，其余字段保留。')}</p>`:''}${button('更新草稿','ai-amend','btn')}</div>`;
}
function renderResult(inSheet=false) {
 if(useOperationSheet()&&!inSheet)return '';
 const r=result, mutable=canCommit(r), m=r.type==='message'?data.messages.find(x=>x.id===r.message):null;
 const actionable=m&&canAction('message-decision')&&m.state==='pending'&&((role==='coach'&&m.kind==='booking')||(role==='student'&&m.kind==='proposal'));
 return `<section class="panel result-panel" aria-label="处理结果"><div class="result-header"><span class="overline">${r.manual?'直接操作':mutable?'核对操作':r.type==='success'?'已完成':'处理结果'}</span>${button(icon('close'),'result-close','icon-button','aria-label="关闭处理结果" ')}</div><form id="result-form" ${r.type==='plan'?'novalidate':''}><div class="result-body">${r.request?(r.type==='plan'?`<details class="request-disclosure"><summary>查看原话</summary><p class="request-quote">${esc(r.request)}</p></details>`:`<p class="request-quote">${esc(r.request)}</p>`):''}${r.type!=='success'?`<h2 class="result-title" id="operation-title" tabindex="-1">${esc(r.title||({balance:'课时核对',summary:'本月课程',message:m?.title,unknown:'暂时没能整理这句话',reset:'不支持此操作'}[r.type]||'核对结果'))}</h2>`:''}${r.explanation&&!['clarification','ai-error'].includes(r.type)?`<p class="result-description">${esc(r.explanation)}</p>`:''}${resultBody(r)}${renderAmendment(r)}${r.aiMeta?`<p class="ai-attribution">DeepSeek V4.1 Flash · Medium（服务端 High）</p>`:''}${r.error?`<div class="error" role="alert">${esc(r.error)}</div>`:''}</div>${mutable?`<div class="result-footer">${button('取消','result-close','btn')}<button type="submit" class="btn primary">${r.type==='plan'?`确认执行 ${r.steps.length} 项`:r.type==='message-decision'?'执行这项操作':r.type==='followup'?'保存回访草稿':r.type==='booking'?(r.values.student==='__new__'?'建立档案并发送提案':role==='coach'?'发送约课提案':'提交预约申请'):r.type==='reset'?'确认重置':'确认保存'} ${icon('check')}</button></div>`:actionable?`<div class="result-footer">${button('拒绝预约','reject-booking','btn danger')}${button('确认预约','accept-booking','btn primary')}</div>`:m&&m.state==='pending'&&!['booking','proposal'].includes(m.kind)?`<div class="result-footer">${button('标记已处理','resolve-message','btn primary')}</div>`:''}</form></section>`;
}
function readValues() {
 if(!result?.values) return {};
 const values={...result.values}, form=$('#result-form');
 if(!form) return values;
 for(const [key,value] of new FormData(form).entries()) values[key]=value;
 for(const key of ['duration','amount','gap','travel']) if(key in values&&values[key]!=='') values[key]=Number(values[key]);
 for(const checkbox of form.querySelectorAll('input[type=checkbox]:not([name="open-day"])')) values[checkbox.name]=checkbox.checked;
 if(result.type==='edit-base')values.days=[...form.querySelectorAll('[name="open-day"]:checked')].map(el=>el.value);
 return values;
}
function fail(message) {result.values=readValues();result.error=message;render();revealResult();}
function success(title,message,link) {
 inputValue='';
 result=null;render();toast(title+'。'+message);
}
function restoreSubmission(){
 if(!session.submission)return false;
 result={type:'submission-recovery',title:'核对上次提交',submission:session.submission};return true;
}
function clearPermissionDrafts(){
 cancelAI();result=null;undoState=null;lastAI=null;inputValue='';contextInputs={};search='';
 formDrafts.clear();skipFormCapture=true;suspendedView=null;inviteReceipt=null;inviteStudentId=null;teamNotice='';
 session.members=[];session.invitations=[];profileOpen=false;menuOpen=false;clearTimeout(toastTimer);$('#toast').textContent='';$('#toast').classList.remove('show');
 if(!canView(view)){view='home';history.replaceState(null,'',location.pathname+location.search+'#home');}
}
async function refreshAuthorized(revision,message='旧草稿与输入已清除。请按最新权限重新操作。'){
 data=await refresh();syncIdentity();if(revision===session.workspace.revision)return false;
 clearPermissionDrafts();result={type:'permission-changed',title:'权限已更新',message};return true;
}
async function recoverSubmission(revision=session.workspace?.revision){
 const changed=await refreshAuthorized(revision);return restoreSubmission()||changed;
}
async function resolveSubmission(resume){
 if(submitting||!session.submission)return;
 const generation=session.generation,revision=session.workspace.revision,id=session.submission.id;submitting=true;render();
 try{
  if(resume){const response=await api(path(`plans/${id}/commit`),'POST',{});if(await refreshAuthorized(revision,'操作已完成，旧详情已清除。请按当前权限查看最新资料。')){restoreSubmission();return;}result={type:'plan-success',title:`${response.results.length} 项操作已完成`,outcomes:response.results,submissionId:id};if(response.undoable)undoState={id,workspace:session.workspace.id,label:'上次操作'};}
  else{const receipt=await api(path(`plans/${id}/acknowledge`),'POST',{});const message=receipt.status==='committed'?'已核对：操作已完成。':receipt.status==='cancelled'?'未执行的操作已取消。':'已关闭这次提交。';if(await refreshAuthorized(revision,message+'旧详情已清除，请按当前权限继续。')){restoreSubmission();return;}result=null;toast(message);}
 }catch(error){if(generation===session.generation){let recovered=false;try{recovered=await recoverSubmission(revision);}catch{}if(result&&(!recovered||result.type==='permission-changed'||result.submission?.state==='pending'))result.error=error.message;}}
 finally{if(generation===session.generation){submitting=false;render();}}
}
async function commitResult(){
 if(!result||!canCommit(result)||submitting)return;
 const generation=session.generation,revision=session.workspace.revision,r=result;if(r.uncertain){try{if(await recoverSubmission(revision)){render();return;}}catch(error){r.error=error.message;render();return;}}if(r.type==='plan')readPlanValues();else r.values=readValues();
 const operations=r.type==='plan'?r.steps:[r];
 const missing=operations.findIndex(o=>missingFields(o).length);if(missing>=0){r.error='请补充：'+missingFields(operations[missing]).join('、')+'。';if(r.type==='plan'){r.errorIndex=missing;r.steps[missing].open=true;}render();return;}
 submitting=true;freezeSubmission();
 try{
  if(!r.commitId){
   const draft=serverPlan(r);
   const referenced=new Set(draft.steps.flatMap(s=>['studentId','venueId','lessonId','messageId','ruleId','practiceId','followupId'].map(k=>s.operation[k]).filter(Boolean)));
   if(draft.steps.some(s=>s.operation.intent==='edit-base')&&session.settingsId)referenced.add(session.settingsId);
   const revisions=Object.fromEntries(Object.entries(r.revisions||session.revisions).filter(([id])=>referenced.has(id)));
   const saved=await api(path('plans'),'POST',{plan:draft,revisions,submission:true});r.commitId=saved.id;
  }
  const response=await api(path(`plans/${r.commitId}/commit`),'POST',{});
  if(generation!==session.generation)return;
  if(response.undoable)undoState={id:r.commitId,workspace:session.workspace.id,label:r.title||'上次操作'};
  if(await refreshAuthorized(revision,'操作已完成，旧详情已清除。请按当前权限查看最新资料。')){restoreSubmission();return;}if(generation!==session.generation)return;inputValue='';
  const booking=operations.filter(o=>o.type==='booking').at(-1);if(booking){selectedDate=booking.values.date;month=selectedDate.slice(0,7);}
  result={type:'plan-success',title:`${response.results.length} 项操作已完成`,outcomes:response.results,submissionId:r.commitId};
 }catch(error){
  if(generation!==session.generation||error.code==='CONTEXT_CHANGED')return;
  if(!session.ready){session.error=error.message;result=null;}
  else{r.uncertain=!!r.commitId||!error.status||error.status>=500||error.status===429||error.code==='SUBMISSION_PENDING';r.error=error.message+(r.uncertain?' 请核对原操作，避免重新填写。':' 整份清单尚未保存。');if(r.type==='plan'&&Number.isInteger(error.index)&&r.steps[error.index]){r.errorIndex=error.index;r.steps[error.index].open=true;}result=r;let recovered=false;try{recovered=await recoverSubmission(revision);}catch{}if(result&&(!recovered||result.type==='permission-changed'||result.submission?.state==='pending'))result.error=error.message;}
 }finally{if(generation===session.generation){submitting=false;render();freezeSubmission();}}
}
function freezeSubmission(){const form=$('#result-form');if(!form)return;for(const el of form.querySelectorAll('input,select,textarea'))el.disabled=submitting||!!result?.commitId||!!result?.uncertain;const submit=form.querySelector('[type=submit]');if(submit){submit.disabled=submitting;if((result?.commitId||result?.uncertain)&&!submitting)submit.textContent='重试原操作并核对结果';}}
function handleBooking(accept) {
 const original=result;
 result={...original,type:'message-decision',values:{decision:accept?'accept':'reject'}};
 commitResult();
}
function correction(type,values,extra={}) {result={type,values:clone(values),revisions:{...session.revisions},request:'',manual:true,title:'编辑资料',error:'',...extra};profileOpen=false;render();revealResult();}
async function onAction(target) {
 const action=target.dataset.action,id=target.dataset.id;
 if((result?.commitId||result?.uncertain||session.submission)&&!['logout','result-close','submission-retry','submission-dismiss','undo'].includes(action)){toast('请先重试原操作并核对提交结果。');return;}
 if(actionPermission[action]&&!canAction(actionPermission[action])){toast('当前账号没有这项权限。');return;}
 if(submitting&&!['logout','result-close'].includes(action))return;
 if(aiRequest&&action!=='ai-retry'){cancelAI();if(result?.type==='loading')result=null;}
 switch(action) {
 case 'ai-retry':if(lastAI)interpretCommand(lastAI.text,lastAI.context,lastAI.reviewedPlan,lastAI.continuation);break;
 case 'ai-amend':{const reply=$('#result-form [name=amendment]')?.value.trim();if(reply)continueAI(reply);else toast('请描述要调整的内容。');break;}
 case 'ai-resolve':{const c=result.aiMeta?.understanding?.clarification;const choice=c?.choices.find(c=>c.id===id);if(choice)continueAI(choice.label,{field:c.field,id});break;}
 case 'ai-clarify':{
 const block=target.closest('[data-step-index]'),reply=(block||$('#result-form'))?.querySelector('[name=clarification]')?.value.trim();
 if(reply&&lastAI){if(result.taskId)continueAI(reply);else{if(result.type==='plan')readPlanValues();const reviewed=result.type==='plan'?serverPlan(result):null;interpretCommand(lastAI.text+'\n补充：'+reply,lastAI.context,reviewed);}}else toast('请先补充说明。');break;}

 case 'new-booking':case 'new-student':case 'new-venue':case 'new-rule':case 'new-credit':case 'new-record':case 'new-practice': openManual(action,id);break;
 case 'home-filter':homeFilter=target.dataset.filter;result=null;render();break;
 case 'direct-accept':case 'direct-reject':{result={type:'message',message:id,manual:true};handleBooking(action==='direct-accept');break;}
 case 'direct-resolve':result={type:'resolve-message',message:id,manual:true,title:'处理消息'};await commitResult();break;
 case 'profile': profileOpen=!profileOpen;menuOpen=false;render();if(profileOpen)$('#profile-menu a')?.focus({preventScroll:true});else $('[data-action=profile]')?.focus({preventScroll:true});break;
 case 'logout':if(loggingOut)return;loggingOut=true;cancelAI();suspendedView=null;formDrafts.clear();try{await logout();}finally{loggingOut=false;if(session.logoutPending)renderGate();}break;
 case 'invite-student':inviteStudentId=id;render();document.querySelector('[data-account-form=invite-student] input')?.focus();break;
 case 'copy-invite':if(inviteReceipt){navigator.clipboard.writeText(inviteReceipt.token).then(()=>toast('邀请口令已复制。')).catch(()=>toast('请长按邀请口令复制。'));}break;

 case 'choose-workspace':await loadWorkspace(id);break;
 case 'menu':menuOpen=true;profileOpen=false;render();$('.sidebar [data-action=menu-close]')?.focus({preventScroll:true});break;
 case 'menu-close':menuOpen=false;render();$('[data-action=menu]')?.focus({preventScroll:true});break;
 case 'submission-retry':await resolveSubmission(true);break;
 case 'submission-dismiss':await resolveSubmission(false);break;
 case 'result-close':if(session.submission){if(result?.type==='plan-success'||session.submission.state!=='pending'){await resolveSubmission(false);}else toast('请继续原操作，或明确取消未执行操作。');return;}if(submitting||result?.commitId||result?.uncertain){toast('请先核对这次提交的结果。');return;}result=null;render();break;
 case 'detail-close':lessonId=null;render();break;
 case 'day':selectedDate=target.dataset.date;lessonId=null;result=null;render();break;
 case 'lesson':lessonId=id;result=null;render();if(innerWidth<=1050)requestAnimationFrame(()=>$('.aside-column').scrollIntoView({block:'start',behavior:'smooth'}));break;
 case 'student':studentId=id;result=null;render();if(innerWidth<=1050)requestAnimationFrame(()=>$('.aside-column').scrollIntoView({block:'start',behavior:'smooth'}));break;
 case 'today':month=TODAY.slice(0,7);selectedDate=TODAY;lessonId=null;result=null;render();break;
 case 'month-prev':case 'month-next': {const [y,m]=month.split('-').map(Number);const d=new Date(Date.UTC(y,m-1+(action==='month-next'?1:-1),1));month=d.toISOString().slice(0,7);result=null;render();break;}
 case 'example': inputValue=exampleText(target.dataset.example);render();$('#command-input').focus();break;
 case 'voice':inputValue=exampleText(availableExamples()[0]?.[0]||'stats');render();$('#command-input').focus();toast('已填入一段语音识别示例，可修改；本原型没有录音。');break;
 case 'undo':if(undoState&&undoState.workspace===session.workspace.id){const revision=session.workspace.revision;try{await api(path(`plans/${undoState.id}/undo`),'POST',{});if(session.submission?.id===undoState.id)await api(path(`plans/${undoState.id}/acknowledge`),'POST',{});undoState=null;if(await refreshAuthorized(revision,'整组操作已撤销，旧详情已清除。请按当前权限继续。')){restoreSubmission();render();break;}result=null;render();toast('整组操作已撤销。');}catch(error){toast(error.message);}}break;
 case 'edit-practice':{const p=data.studentPractice.find(p=>p.id===id);if(p)correction('edit-practice',{date:p.date,topic:p.topic,text:p.text,shared:p.shared},{practice:id,title:'修改自主练习'});break;}
 case 'edit-followup':if(role==='coach'){const f=data.followups.find(x=>x.id===id);correction('followup',{text:f.text},{followup:id,eligible:f.students,title:'纠正回访草稿'});}break;
 case 'edit-student':if(role==='coach')correction('edit-student',student(studentId),{student:studentId});break;
 case 'edit-venue':if(role==='coach')correction('edit-venue',venue(id),{venue:id});break;
 case 'edit-base':if(role==='coach')correction('edit-base',data.settings);break;
 case 'edit-rule':if(role==='coach')correction('availability',data.availabilityRules.find(r=>r.id===id),{rule:id,title:'纠正开放规则'});break;
 case 'edit-lesson':if(role==='coach'){const l=data.lessons.find(l=>l.id===id);correction('edit-lesson',{duration:l.duration,note:data.notes.find(n=>n.lesson===l.id)?.observation||l.note},{lesson:id,title:'纠正课程记录'});}break;
 case 'message':{const m=data.messages.find(x=>x.id===id);result={type:'message',message:id,revisions:{...session.revisions}};render();revealResult();break;}
 case 'accept-booking':handleBooking(true);break;
 case 'reject-booking':handleBooking(false);break;
 case 'resolve-message':result={...result,type:'resolve-message',title:'处理消息'};await commitResult();break;
 }
}
document.addEventListener('click',event=>{
 if(event.target.closest('.skip-link')){event.preventDefault();$('#main')?.focus({preventScroll:true});return;}
 const target=event.target.closest('[data-action]');if(target){onAction(target).catch(error=>toast(error.message));return;}
 if(profileOpen&&!event.target.closest('.profile-menu')){profileOpen=false;render();}
});
document.addEventListener('submit',event=>{
 if(event.target.matches('[data-account-form]')){event.preventDefault();handleAccount(event.target).catch(error=>{teamNotice=error.message;session.loading=false;render();});return;}
 if(event.target.id==='command-form'){event.preventDefault();interpretCommand($('#command-input').value);}
 if(event.target.id==='result-form'){event.preventDefault();commitResult();}
 if(event.target.classList.contains('message-command')){event.preventDefault();interpretCommand(event.target.querySelector('input').value,event.target.dataset.message);}
});
document.addEventListener('input',event=>{
 if(event.target.closest('[data-account-form]'))rememberForms();
 if(event.target.id==='command-input'){inputValue=event.target.value;updateComposerViewport();}
 if(event.target.closest('.message-command'))contextInputs[event.target.closest('.message-command').dataset.message]=event.target.value;
 if(event.target.id==='student-search'){search=event.target.value;const pos=event.target.selectionStart;render();$('#student-search').focus();$('#student-search').setSelectionRange(pos,pos);}
 if(event.target.closest('[data-step-index]')&&result?.type==='plan'){readPlanValues();updatePlanLabels();return;}
 if(event.target.closest('#result-form')&&result?.values){result.values=readValues();if(result.type==='record')$('#record-impact').textContent=recordImpact(result.values.duration,data.lessons.find(l=>l.id===result.lesson));if(result.type==='availability')$('#rule-impact').textContent=impactText(ruleImpact(result.values));}
});
document.addEventListener('toggle',event=>{if(event.target.matches?.('.plan-step')&&result?.type==='plan'){const step=result.steps[Number(event.target.dataset.stepIndex)];if(step)step.open=event.target.open;}},true);
document.addEventListener('change',event=>{
 if(event.target.closest('[data-account-form]'))rememberForms();
 if(event.target.closest('[data-step-index]')&&result?.type==='plan'){readPlanValues();updatePlanLabels();return;}
 if(event.target.matches('#result-form [name=student]')&&result?.unknownName){result.values=readValues();const fresh=result.values.student==='__new__';$('#new-student-hint').textContent=fresh?`确认提交时同时建立“${result.unknownName}”的档案，初始余额 0；不会绑定或邀请真实用户。`:'新学员只有在你选择新建并确认提交后才会建立档案。';$('#result-form [type=submit]').innerHTML=(fresh?'建立档案并发送提案':'发送约课提案')+icon('check');}
 if(event.target.id==='workspace-select'){if(submitting||result?.commitId||result?.uncertain||session.submission){event.target.value=session.workspace.id;toast('请先核对当前提交结果。');return;}loadWorkspace(event.target.value);return;}
 if(event.target.id==='inbox-filter'){inboxFilter=event.target.value;result=null;render();}});
document.addEventListener('keydown',event=>{
 if(event.key==='Tab'&&menuOpen&&innerWidth<=700){const items=[...$('.sidebar').querySelectorAll('button,a[href],select')].filter(el=>el.getClientRects().length);const first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first||!event.shiftKey&&document.activeElement===last||!$('.sidebar').contains(document.activeElement)){event.preventDefault();(event.shiftKey?last:first)?.focus();}}
 if(event.key==='Tab'&&$('#operation-dialog').open){
  const items=[...$('#operation-dialog').querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')].filter(el=>el.getClientRects().length);
  const first=items[0],last=items.at(-1),active=document.activeElement;
  if(items.length&&((event.shiftKey&&active===first)||(!event.shiftKey&&active===last)||!$('#operation-dialog').contains(active))){event.preventDefault();(event.shiftKey?last:first).focus({preventScroll:true});}
 }
 if(event.target.id==='command-input'&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();interpretCommand(event.target.value);}
 if(event.key==='Escape'&&!submitting&&!result?.commitId&&!result?.uncertain&&!session.submission&&(result||profileOpen||menuOpen)){event.preventDefault();const source=menuOpen?'menu':profileOpen?'profile':null;cancelAI();result=null;profileOpen=false;menuOpen=false;render();if(source)$('[data-action='+source+']')?.focus({preventScroll:true});}
});
window.addEventListener('hashchange',()=>{if(submitting||result?.commitId||result?.uncertain||session.submission){location.hash=view;return;}route();});
$('#operation-dialog').addEventListener('cancel',event=>{event.preventDefault();if(submitting||result?.commitId||result?.uncertain||session.submission)return;cancelAI();result=null;render();});
window.visualViewport?.addEventListener('resize',()=>{updateSheetViewport();updateComposerViewport();});
window.visualViewport?.addEventListener('scroll',()=>{updateSheetViewport();updateComposerViewport();});
window.addEventListener('resize',()=>{drawerState();if(result&&Boolean(sheetState)!==useOperationSheet())render();updateSheetViewport();updateComposerViewport();});
onInvalidated(()=>{skipFormCapture=false;formDrafts.clear();if(!suspending)suspendedView=null;inviteStudentId=null;inviteReceipt=null;submitting=false;cancelAI();data=emptyData();result=null;undoState=null;selfStudentId=null;studentId=null;lessonId=null;teamNotice='';contextInputs={};inputValue='';lastAI=null;search='';profileOpen=false;menuOpen=false;$('#toast').textContent='';renderGate();});
loadWorkspace();
function suspendDraft(){
 if(!session.ready)return null;rememberForms();
 return {account:session.identity.id,workspace:session.workspace.id,revision:session.workspace.revision,view,selectedDate,month,studentId,lessonId,inputValue,contextInputs:clone(contextInputs),forms:clone([...formDrafts]),result:result&&!submitting&&!result.commitId&&!result.uncertain&&!session.submission&&!['loading','plan-success'].includes(result.type)?clone(result):null};
}
function restoreDraft(draft){
 if(!draft||!session.ready||draft.account!==session.identity.id||draft.workspace!==session.workspace.id||draft.revision!==session.workspace.revision||session.submission)return;
 if(canView(draft.view)){view=draft.view;history.replaceState(null,'',location.pathname+location.search+'#'+view);}selectedDate=draft.selectedDate;month=draft.month;studentId=data.students.some(s=>s.id===draft.studentId)?draft.studentId:studentId;lessonId=data.lessons.some(l=>l.id===draft.lessonId)?draft.lessonId:null;inputValue=draft.inputValue;contextInputs=draft.contextInputs;formDrafts=new Map(draft.forms);skipFormCapture=true;result=draft.result;
}
document.addEventListener('visibilitychange',()=>{if(document.hidden){suspendedView=suspendDraft();lastWorkspaceId=session.workspace?.id||lastWorkspaceId;suspending=true;clearSession();suspending=false;render();}else{const draft=suspendedView;suspendedView=null;loadWorkspace(lastWorkspaceId,draft);}});
window.addEventListener('pagehide',()=>{clearSession();render();});
window.addEventListener('pageshow',event=>{if(event.persisted)loadWorkspace(lastWorkspaceId);});
setInterval(()=>{if(!document.hidden&&session.ready&&!result&&!submitting)refreshView();},30000);

const roleLabels={owner:'教练',admin:'管理员',assistant:'助教',student:'学员'};
const permissionLabels={'students.read':'查看学员','students.write':'管理学员','contacts.read':'查看联系方式','contacts.write':'修改联系方式','notes.read':'查看私人教练记录','notes.write':'填写私人教练记录','ledger.read':'查看课时账本','ledger.write':'登记与扣减课时','feedback.read':'查看教学反馈','feedback.write':'发布教学反馈','practice.read':'查看共享练习','schedule.read':'查看日程','schedule.write':'排课与处理预约','venues.read':'查看场地','venues.write':'管理场地'};
function syncIdentity(){
 role=session.workspace.role==='student'?'student':'coach';selfStudentId=session.workspace.studentId;aiState=session.status?.configured?'ready':'missing';
 if(!data.students.some(s=>s.id===studentId))studentId=selfStudentId||data.students[0]?.id||null;
 if(lessonId&&!data.lessons.some(l=>l.id===lessonId))lessonId=null;
}
async function loadWorkspace(id,draft=null){
 const run=++loadSequence;lastWorkspaceId=id||lastWorkspaceId;session.loading=true;session.error='';
 const pending=bootstrap(lastWorkspaceId),generation=session.generation;render();
 try{const loaded=await pending;if(run!==loadSequence||generation!==session.generation)return;data=loaded;if(session.ready){lastWorkspaceId=session.workspace.id;syncIdentity();if(can('team.manage'))await loadTeam();}if(run===loadSequence&&generation===session.generation){route();restoreDraft(draft);if(restoreSubmission()){render();revealResult();}else if(draft)render();}}
 catch(error){if(run!==loadSequence||generation!==session.generation||error.code==='CONTEXT_CHANGED')return;session.error=error.message;session.loading=false;render();}
}
async function refreshView(){
 if(document.querySelector('[data-account-form]:focus-within'))return;
 const previous=session.workspace?.revision,generation=session.generation;
 try{const loaded=await refresh();if(generation!==session.generation)return;data=loaded;syncIdentity();if(previous!==session.workspace.revision)clearPermissionDrafts();if(can('team.manage'))await loadTeam();if(!canView(view)){route();return;}if(session.submission&&!result)restoreSubmission();render();}
 catch(error){if(generation!==session.generation||error.code==='CONTEXT_CHANGED')return;clearSession(error.message);render();}
}
function onboardingForms(){
 const owns=session.workspaces.some(w=>w.role==='owner'),mayCoach=session.identity?.registrationRole==='coach'&&(!session.ready||role==='coach');
 return `<div class="account-forms">${owns||!mayCoach?'':`<form data-account-form="create"><h3>我是教练</h3><p class="sub">直接开始管理学员、场地和课程。你也可以同时跟其他教练学球。</p><button class="btn primary" type="submit">开始执教</button></form>`}<form data-account-form="join"><h3>${role==='student'||session.identity?.registrationRole==='student'?'接受教练邀请':'接受邀请'}</h3><label>邀请口令<input name="token" required minlength="43" maxlength="43" autocomplete="off" placeholder="粘贴教练给你的邀请口令"></label><p class="sub">使用收到邀请的约练账号接受口令。接受后关联已有档案。</p><button class="btn" type="submit">接受邀请</button></form></div>`;
}
function renderGate(){
 const dialog=$('#operation-dialog');if(dialog?.open)dialog.close();if(sheetState){document.body.style.position='';document.body.style.top='';document.body.style.width='';document.body.classList.remove('operation-open');sheetState=null;}
 const login=session.authRequired,logoutPending=session.logoutPending;
 $('#app').innerHTML=`<main class="account-gate"><div class="between"><a class="brand" href="/">约练</a>${session.identity||logoutPending?'':'<a class="text-button" href="/login">登录约练</a>'}</div><h1>${logoutPending?'退出约练':session.loading?'正在读取你的约练资料':login?'登录约练':session.error?'暂时无法打开约练':'开始使用约练'}</h1><p class="sub">${esc(logoutPending?(loggingOut?'正在结束约练账号会话。':'退出结果尚未确认，请重试退出。') :session.loading?'正在确认登录身份和可访问的资料。':login?'登录后查看课程、教练和训练记录。':session.error||`${session.identity?.name||''}，${session.identity?.registrationRole==='coach'?'开始管理你的课程，或接受已有教练的邀请。':'接受教练的邀请后，就能查看课程、课时和训练记录。'}`)}</p>${logoutPending?button(loggingOut?'正在退出…':'重试退出','logout','btn primary',loggingOut?'disabled':''):session.loading?'':login?'<a class="btn primary" href="/login">登录约练</a>':session.error?'<form data-account-form="retry"><button class="btn primary">重新连接</button></form>':onboardingForms()}${session.identity?`<div class="auth-actions">${button('退出约练','logout','text-button')}</div>`:''}${teamNotice?`<p class="notice" role="status">${esc(teamNotice)}</p>`:''}</main>`;
}
function testingPicker(){
 const t=session.status?.testing;if(!t?.canSwitch)return '';
 return `<label class="workspace-picker testing-picker">测试身份 <select id="test-persona-select" aria-label="切换测试身份">${t.personas.some(p=>p.key===testPersona)?'':`<option value="" disabled selected>${esc(session.identity.name)}</option>`}${t.personas.map(p=>`<option value="${esc(p.key)}"${selected(p.key,testPersona)}>${esc(p.name)}</option>`).join('')}</select></label>`;
}
function studentConnection(s){
 if(!can('team.manage'))return '';
 const member=session.members.find(m=>m.student_id===s.id),pending=session.invitations.find(i=>i.student_id===s.id&&!i.accepted_at&&!i.revoked_at&&new Date(i.expires_at)>new Date());
 return `<section class="student-connection"><div class="between"><h3>账号关联</h3><span class="connection-status">${member?(member.active?'已关联':'已停用'):pending?'待接受邀请':'未关联账号'}</span></div><p class="sub">${member?`${esc(member.display_name)} · ${member.active?'该账号可以查看自己的课程、课时和反馈。':'该账号目前不能访问这位教练的资料。'}`:'添加姓名只建立档案；对方用指定约练账号登录并接受邀请后，才会关联到这位学员。'}</p>${member?'<a class="text-button" href="#account">管理成员权限</a>':inviteStudentId===s.id?`<form data-account-form="invite-student" data-student="${s.id}"><label>学员约练用户名<input name="username" required minlength="3" maxlength="32" autocomplete="off" placeholder="管理员提供的约练用户名"></label><p class="sub">对方需要已有约练账号，再生成邀请。</p><button class="btn" type="submit">生成邀请口令</button><p class="sub">${pending?'生成新口令会撤回这个学员尚未接受的旧邀请。':'口令仅供这个约练账号使用，24 小时有效。'}</p></form>`:button(pending?'重新邀请':'邀请关联账号','invite-student','btn',`data-id="${s.id}"`)}${inviteReceipt?.studentId===s.id?`<div class="invite-receipt" role="status"><p>把口令发给 ${esc(inviteReceipt.username)}</p><code>${esc(inviteReceipt.token)}</code>${button('复制邀请口令','copy-invite','btn')}<p class="sub">对方在个人中心接受邀请。不会自动发送消息。</p></div>`:''}${teamNotice&&inviteStudentId===s.id?`<p class="sub" role="status">${esc(teamNotice)}</p>`:''}</section>`;
}
function coachPicker(){
 if(session.workspaces.length<2)return '';
 const label=role==='student'?'我的教练':'当前教练';
 return `<label class="workspace-picker">${label} <select id="workspace-select" aria-label="切换教练">${session.workspaces.map(w=>`<option value="${esc(w.id)}"${selected(w.id,session.workspace.id)}>${esc(w.name)}${w.role==='owner'?' · 我执教':''}</option>`).join('')}</select></label>`;
}
function workspaceConnections(){return `<section class="account-section"><h2>${role==='student'?'我的教练':'教学关联'}</h2><p class="sub">${role==='student'?'查看与你关联的教练。每位教练的课程和课时分别计算。':'按当前身份查看已经加入的教学关系。'}</p>${session.workspaces.filter(w=>role!=='student'||w.role==='student').map(w=>`<div class="account-member between"><div><strong>${esc(w.name)}</strong><p class="sub">${roleLabels[w.role]}${w.id===session.workspace.id?' · 当前查看':''}</p></div>${w.id===session.workspace.id?'':button('查看','choose-workspace','btn',`data-id="${w.id}"`)}</div>`).join('')}</section>`;}
function testingSection(){
 const t=session.status?.testing;if(t?.environment!=='test')return '';
 return `<section class="account-section"><h2>Mock 测试环境</h2><p class="sub">当前数据库用于开发测试。数据会在你确认验收后清空；现在可以自由体验业务流程。</p>${t.canSwitch?`<p class="sub">顶部“测试身份”可切换以下虚构账号；当前身份为 ${esc(session.identity.name)}。</p><div class="test-persona-list">${t.personas.map(p=>`<div><strong>${esc(p.name)}</strong><p class="sub">${esc(p.description)}</p><p class="sub">${esc(p.username||p.key)}</p></div>`).join('')}</div>`:''}</section>`;
}
function permissionChecks(chosen=[]){return Object.entries(permissionLabels).map(([key,label])=>`<label class="permission-check"><input type="checkbox" name="permission" value="${key}" ${chosen.includes(key)?'checked':''}>${label}</label>`).join('');}
function accountContent(){
 const member=session.workspace;
 return `<div class="panel panel-pad"><div class="student-detail-head"><span class="mini-avatar">${esc(session.identity.name[0])}</span><div><h2>${esc(session.identity.name)}</h2><p class="sub">${roleLabels[member.role]} · ${esc(member.name)}</p></div></div><div class="detail-line account-username"><span>约练用户名</span><strong>${esc(session.identity.username||'')}</strong></div><div class="notice">${role==='student'?'你的课程、课时和训练记录按教练分别管理。':'团队成员按教练授予的权限处理事务。'}</div>${workspaceConnections()}${testingSection()}${teamNotice?`<p class="notice account-notice" role="status">${esc(teamNotice)}</p>`:''}${can('team.manage')?`<section class="account-section"><h2>团队成员</h2>${session.members.map(m=>`<div class="account-member"><div class="between"><strong>${esc(m.display_name)}</strong><span>${roleLabels[m.role]} · ${m.active?'有效':'已停用'}</span></div>${m.role!=='owner'&&m.user_id!==session.identity.id&&(m.role!=='admin'||member.role==='owner')?`<form data-account-form="member" data-user="${esc(m.user_id)}"><label class="permission-check"><input type="checkbox" name="active" ${m.active?'checked':''}>允许访问团队资料</label>${m.role==='assistant'?`<details><summary>调整助教权限</summary><div class="permission-grid">${permissionChecks(m.permissions)}</div></details>`:''}<button class="btn">保存授权</button></form>`:''}</div>`).join('')}<h3>邀请学员或团队成员</h3><form data-account-form="invite"><div class="form-row"><label>对方约练用户名<input name="username" required minlength="3" maxlength="32" autocomplete="off"></label><label>加入身份<select name="role" id="invite-role"><option value="student">学员</option><option value="assistant">助教</option>${member.role==='owner'?'<option value="admin">管理员</option>':''}</select></label></div><label id="invite-student-field">关联学员档案<select name="studentId"><option value="">请选择学员</option>${data.students.filter(s=>!session.members.some(m=>m.student_id===s.id)).map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label><fieldset id="invite-permissions" hidden><legend>助教权限</legend><div class="permission-grid">${permissionChecks(['students.read','schedule.read','schedule.write','venues.read'])}</div></fieldset><p class="sub">对方需要已有约练账号。口令仅供指定用户名使用，24 小时有效；生成后自行发给对方。</p><button class="btn primary">生成邀请口令</button></form><h3>邀请记录</h3>${session.invitations.map(i=>`<div class="account-member between"><span>${esc(i.recipient_username||i.recipient_name||student(i.student_id)?.name||roleLabels[i.role])} · ${roleLabels[i.role]} · ${i.accepted_at?'已接受':i.revoked_at?'已撤回':new Date(i.expires_at)<new Date()?'已过期':'待接受'}</span>${!i.accepted_at&&!i.revoked_at?`<form data-account-form="revoke" data-invitation="${i.id}"><button class="btn">撤回</button></form>`:''}</div>`).join('')||'<p class="sub">暂无邀请。</p>'}</section>`:''}<section class="account-section">${onboardingForms()}</section></div>`;
}
async function handleAccount(form){
 if(submitting)return;submitting=true;const button=form.querySelector('[type=submit],button');if(button)button.disabled=true;
 const values=new FormData(form),kind=form.dataset.accountForm;teamNotice='';
 try{
  if(kind==='retry'){await loadWorkspace(lastWorkspaceId);return;}
  if(kind==='create'){const created=await api('workspaces','POST',{name:(session.identity.name+'的网球课').slice(0,80)});await loadWorkspace(created.id);return;}
  if(kind==='join'){const joined=await api('invitations/accept','POST',{token:String(values.get('token')).trim()});await loadWorkspace(joined.workspaceId);return;}
  if(kind==='invite'||kind==='invite-student'){const role=kind==='invite-student'?'student':values.get('role'),permissions=role==='assistant'?values.getAll('permission'):[];for(const p of [...permissions])if(p.endsWith('.write')&&!permissions.includes(p.replace('.write','.read')))permissions.push(p.replace('.write','.read'));const invitation=await api(path('invitations'),'POST',{username:values.get('username'),role,permissions,studentId:role==='student'?(kind==='invite-student'?form.dataset.student:values.get('studentId'))||null:null});if(kind==='invite-student')inviteReceipt={studentId:form.dataset.student,username:values.get('username'),token:invitation.token};teamNotice=`邀请口令：${invitation.token}\n请发给指定用户名的用户，让对方在个人中心粘贴接受。24 小时有效。`;}
  if(kind==='member'){const m=session.members.find(m=>m.user_id===form.dataset.user),permissions=values.getAll('permission');for(const p of [...permissions])if(p.endsWith('.write')&&!permissions.includes(p.replace('.write','.read')))permissions.push(p.replace('.write','.read'));await api(path('members'),'PATCH',{userId:m.user_id,revision:m.revision,active:values.has('active'),...(m.role==='assistant'?{permissions}:{})});teamNotice='成员授权已更新，下一次请求按新权限执行。';}
  if(kind==='revoke'){await api(path(`invitations/${form.dataset.invitation}/revoke`),'POST',{});teamNotice='邀请已撤回。';}
  formDrafts.delete(formKey(form));form.reset();await loadTeam();render();
 }finally{submitting=false;if(button)button.disabled=false;}
}
document.addEventListener('change',event=>{if(event.target.id==='invite-role'){const role=event.target.value;$('#invite-student-field').hidden=role!=='student';$('#invite-permissions').hidden=role!=='assistant';}});

// A mock persona is a server-authorized test context, never a global role switch.
document.addEventListener('change',async event=>{
 if(event.target.id!=='test-persona-select')return;
 if(submitting||result?.commitId||result?.uncertain||session.submission){event.target.value=testPersona;toast('请先核对当前提交结果。');return;}
 const value=event.target.value;cancelAI();suspendedView=null;formDrafts.clear();try{await selectTestPersona(value);}catch(error){event.target.value=testPersona;toast(error.message);}
});
