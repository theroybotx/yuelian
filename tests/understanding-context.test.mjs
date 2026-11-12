import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareUnderstanding} from '../server/src/understanding.mjs';

const student=(id,name,extra={})=>({id,name,goal:'正手稳定',next:'反手脚步',last:'2026-10-20',balance:10,...extra});
const venue=(id,name,extra={})=>({id,name,address:'测试地址',court:'1号',...extra});
const lesson=(id,students,extra={})=>({id,date:'2026-10-20',start:900,duration:60,students,venue:'v1',state:'done',note:'原课题',...extra});
function fixture(text,extra={}) {
 return {text,context:{today:'2026-11-01',role:'coach',month:'2026-11',selectedStudent:null,selectedLesson:null,messageId:null,
  students:[student('s1','小林'),student('s2','Roy'),student('s3','小宇')],venues:[venue('v1','滨江网球场'),venue('v2','弘金地')],
  lessons:[lesson('l1',['s1']),lesson('l2',['s2'],{date:'2026-10-25',venue:'v2'}),lesson('l3',['s3'],{state:'confirmed',date:'2026-11-03'})],
  messages:[{id:'m1',student:'s1',lesson:'l1',kind:'feedback',state:'pending',title:'小林反馈',text:'数据'},
   {id:'m2',student:'s2',lesson:'l2',kind:'booking',state:'pending',title:'Roy预约',text:'数据'}],
  rules:[{id:'r1',from:'2026-11-01',to:'2026-12-31',day:'一',start:'09:00',end:'20:00',gap:0,venue:'v1'}],
  practices:[{id:'p1',topic:'正手',date:'2026-10-30',shared:true}],followups:[{id:'f1',student:'s1',text:'最近还练球吗'}],followupIds:['s1'],
  settings:{days:['一'],start:'09:00',end:'20:00',travel:15},...extra}};
}
const prepare=(text,extra,options)=>prepareUnderstanding(fixture(text,extra),options);
test('literal short booking time ranges contribute booking alongside other requested tasks',()=>{
 const result=prepare('给小林登记已购买的2课时，另外给小宇明天在老地方约15点到16点');
 assert.ok(result.meta.tasks.includes('credit'));assert.ok(result.meta.tasks.includes('booking'));
 for(const text of ['大约15点到16点到达','约30课时'])assert.equal(prepare(text).meta.tasks.includes('booking'),false);
});
const ids=rows=>rows.map(row=>row.id);

test('understanding is pure and preserves original text and date semantics',()=>{
 const input=fixture('给小林明天下午约课'),before=structuredClone(input),r=prepareUnderstanding(input);
 assert.deepEqual(input,before);assert.notEqual(r.input,input);assert.equal(r.input.text,before.text);assert.equal(r.input.context.today,'2026-11-01');assert.equal(r.input.context.month,'2026-11');
 r.input.context.students[0].name='changed';assert.equal(input.context.students[0].name,'小林');
});
test('English case and NFKC width resolve a unique real name',()=>{
 for(const text of ['给 roy 约课','给 ＲＯＹ 约课','给 RoY 明天约课']) {
  const r=prepare(text);assert.equal(r.clarification,null);assert.equal(r.meta.resolved.studentId,'s2');assert.equal(r.meta.resolved.studentBasis,'explicit-name');
 }
});
test('English prefixes are not aliases or fuzzy matches',()=>{
 const r=prepare('给 Royce 约课',{selectedStudent:'s1'});assert.equal(r.meta.resolved.studentId,null);assert.deepEqual(r.meta.matches.students,[]);assert.deepEqual(r.meta.unknownStudentNames,['royce']);
});
test('an unknown longer Chinese name never selects its shorter namesake',()=>{
 const r=prepare('给小林子约课',{selectedStudent:'s1'});assert.deepEqual(r.meta.matches.students,[]);assert.equal(r.input.context.selectedStudent,null);assert.deepEqual(r.meta.unknownStudentNames,['小林子']);
});
test('longest explicit authorized name wins over its contained shorter name',()=>{
 const r=prepare('给小林子约课',{students:[student('s1','小林'),student('s4','小林子')]});assert.deepEqual(r.meta.matches.students,[{id:'s4',name:'小林子'}]);assert.equal(r.meta.resolved.studentId,'s4');
});
test('single-character names require explicit target syntax',()=>{
 const context={students:[student('s4','王')]};assert.equal(prepare('王者训练统计',context).meta.resolved.studentId,null);assert.equal(prepare('给王约课',context).meta.resolved.studentId,'s4');
});
test('explicit name overrides a stale page selection',()=>{
 const r=prepare('给Roy约课',{selectedStudent:'s1'});assert.equal(r.input.context.selectedStudent,'s2');assert.equal(r.meta.resolved.studentBasis,'explicit-name');
});
test('duplicate names require an explicit candidate rather than recency',()=>{
 const r=prepare('给小林约课',{students:[student('s1','小林'),student('s4','小林',{last:'2026-10-31'})]});
 assert.equal(r.clarification.kind,'student');assert.equal(r.clarification.field,'selectedStudent');assert.deepEqual(ids(r.clarification.choices),['s1','s4']);assert.notEqual(r.clarification.choices[0].label,r.clarification.choices[1].label);
});
test('validated selection disambiguates one duplicate-name group',()=>{
 const r=prepare('给小林约课',{selectedStudent:'s4',students:[student('s1','小林'),student('s4','小林')]});assert.equal(r.clarification,null);assert.equal(r.meta.resolved.studentId,'s4');
});
test('case-fold collisions also require a candidate choice',()=>{
 const r=prepare('给roy约课',{students:[student('s1','Roy'),student('s4','ROY')]});assert.equal(r.clarification.kind,'student');assert.equal(r.clarification.choices.length,2);
});
test('unauthorized current and previous anchors are discarded without reflection',()=>{
 const r=prepare('给他约课',{selectedStudent:'other-workspace',selectedLesson:'private-lesson',messageId:'private-message'},{previous:{selectedStudent:'secret',selectedLesson:'secret-lesson',messageId:'secret-message',venueId:'secret-venue'}});
 assert.equal(r.clarification.kind,'student');assert.deepEqual(ids(r.clarification.choices),['s1','s2','s3']);assert.equal(JSON.stringify(r).includes('secret'),false);assert.equal(JSON.stringify(r).includes('private-'),false);assert.equal(JSON.stringify(r).includes('other-workspace'),false);
});
test('a previous authorized selection supports a singular follow-up',()=>{
 const r=prepare('给他约课',{}, {previous:{selectedStudent:'s2'}});assert.equal(r.clarification,null);assert.equal(r.meta.resolved.studentId,'s2');assert.equal(r.meta.resolved.studentBasis,'previous-selection');
});
test('a selected inbox message grounds its real student',()=>{
 const r=prepare('同意他的预约',{messageId:'m2',selectedStudent:'s1'});assert.equal(r.clarification,null);assert.equal(r.meta.resolved.studentId,'s2');assert.equal(r.meta.resolved.studentBasis,'selected-message');
});
test('a one-to-one selected lesson grounds the student',()=>{
 const r=prepare('帮他查余额',{selectedLesson:'l2'});assert.equal(r.clarification,null);assert.equal(r.meta.resolved.studentId,'s2');assert.equal(r.meta.resolved.studentBasis,'selected-lesson');
});
test('a group lesson does not turn a singular pronoun into its first participant',()=>{
 const r=prepare('给他约课',{selectedLesson:'group',lessons:[lesson('group',['s1','s2'])]});assert.equal(r.clarification.kind,'student');assert.deepEqual(ids(r.clarification.choices),['s1','s2']);
});
test('a singular pronoun without anchors asks only authorized candidates',()=>{
 const r=prepare('帮她查余额');assert.equal(r.clarification.kind,'student');assert.equal(r.meta.resolved.studentId,null);assert.deepEqual(ids(r.clarification.choices),['s1','s2','s3']);
});
test('我俩 does not silently become one selected student',()=>{
 const r=prepare('我俩明天约课',{selectedStudent:'s1'});assert.equal(r.clarification.kind,'student');assert.match(r.clarification.question,/涉及哪些学员/u);
});
test('two explicit students remain separate task targets',()=>{
 const r=prepare('给小林约课，然后给Roy登记10课时');assert.equal(r.clarification,null);assert.equal(r.meta.resolved.studentId,null);assert.deepEqual(ids(r.meta.matches.students),['s1','s2']);assert.ok(r.meta.tasks.includes('booking'));assert.ok(r.meta.tasks.includes('credit'));assert.deepEqual(ids(r.input.context.students),['s1','s2']);
});
test('singular pronoun after multiple named people requires a choice',()=>{
 const r=prepare('给小林和Roy约课，给他登记课时');assert.equal(r.clarification.kind,'student');assert.deepEqual(ids(r.clarification.choices),['s1','s2']);
});
test('unknown target clears stale selection without automatic account creation',()=>{
 const r=prepare('给刘德华明天约课',{selectedStudent:'s2'});assert.equal(r.clarification,null);assert.equal(r.meta.resolved.studentId,null);assert.deepEqual(r.meta.unknownStudentNames,['刘德华']);assert.equal(r.input.context.students.some(s=>s.name==='刘德华'),false);
});
test('known and unknown targets do not collapse into the known person',()=>{
 const r=prepare('给小林约课，然后给刘德华登记课时');assert.equal(r.meta.resolved.studentId,null);assert.deepEqual(r.meta.unknownStudentNames,['刘德华']);assert.deepEqual(ids(r.meta.matches.students),['s1']);
});
test('student identity remains the authenticated self',()=>{
 const r=prepare('给我自己约课',{role:'student',selfStudentId:'s1',students:[student('s1','小林')],selectedStudent:'s2'});assert.equal(r.meta.resolved.studentId,'s1');assert.equal(r.meta.resolved.studentBasis,'authenticated-self');
});
test('老地方 uses only the latest completed past lesson of the selected student',()=>{
 const r=prepare('给小林在老地方约课',{lessons:[lesson('old',['s1']),lesson('latest',['s1'],{date:'2026-10-30',start:960,venue:'v2'}),lesson('pending',['s1'],{date:'2026-10-31',venue:'v1',state:'confirmed'}),lesson('future',['s1'],{date:'2026-11-05',venue:'v1'}),lesson('other',['s2'],{date:'2026-10-31',venue:'v1'})]});
 assert.equal(r.meta.resolved.venueId,'v2');assert.equal(r.meta.resolved.venueBasis,'latest-completed-lesson');assert.equal(r.meta.resolved.sourceLessonId,'latest');assert.equal(r.meta.resolved.start,null);
});
test('simultaneous latest completed lessons with different venues ask a choice',()=>{
 const r=prepare('给小林在老地方约课',{lessons:[lesson('a',['s1']),lesson('b',['s1'],{venue:'v2'})]});assert.equal(r.clarification.kind,'venue');assert.deepEqual(ids(r.clarification.choices),['v1','v2']);assert.equal(r.meta.resolved.venueId,null);
});
test('simultaneous records at one venue have a unique venue answer',()=>{
 const r=prepare('给小林在老地方约课',{lessons:[lesson('a',['s1']),lesson('b',['s1'])]});assert.equal(r.clarification,null);assert.equal(r.meta.resolved.venueId,'v1');
});
test('missing history does not infer another student venue',()=>{
 const r=prepare('给小林在老地方约课',{lessons:[lesson('other',['s2'],{venue:'v2'})]});assert.equal(r.clarification.kind,'venue');assert.equal(r.meta.resolved.venueId,null);assert.deepEqual(ids(r.clarification.choices),['v1','v2']);
});
test('explicitly chosen authorized venue answers missing old-place history',()=>{
 const r=prepare('给小林在老地方约课',{lessons:[]},{previous:{venueId:'v2'}});assert.equal(r.clarification,null);assert.equal(r.meta.resolved.venueId,'v2');assert.equal(r.meta.resolved.venueBasis,'explicit-choice');
});
test('an explicit venue takes priority over a historical old-place reference',()=>{
 const r=prepare('给小林约课，不去老地方了，改在弘金地');assert.equal(r.clarification,null);assert.equal(r.meta.resolved.venueId,'v2');assert.equal(r.meta.resolved.venueBasis,'explicit-name');
});
test('old time inherits only start, never a date or duration',()=>{
 const r=prepare('给小林明天老时间老地方约课');assert.equal(r.meta.resolved.start,'15:00');assert.equal(r.meta.resolved.startBasis,'latest-completed-lesson');assert.equal(r.meta.resolved.venueId,'v1');assert.equal('duration' in r.meta.resolved,false);assert.equal('date' in r.meta.resolved,false);assert.equal(r.input.text,'给小林明天老时间老地方约课');
});
test('原来那儿 has the same scoped historical evidence as 老地方',()=>{
 const r=prepare('给小林约课，还是原来那儿');assert.equal(r.meta.resolved.venueId,'v1');assert.equal(r.meta.resolved.sourceLessonId,'l1');
});
test('照上次 does not silently inherit time or training notes',()=>{
 const r=prepare('给小林约课，照上次');assert.equal(r.meta.resolved.venueId,'v1');assert.equal(r.meta.resolved.start,null);assert.equal('note' in r.meta.resolved,false);
});
test('old-place reference without a student asks rather than using latest global lesson',()=>{
 const r=prepare('老地方约一小时');assert.equal(r.clarification.kind,'student');assert.equal(r.meta.resolved.venueId,null);
});
test('duplicate venue names require a candidate and a chosen ID resolves it',()=>{
 const context={venues:[venue('v1','滨江'),venue('v2','滨江',{address:'另一地址'})]};
 const ambiguous=prepare('给小林在滨江约课',context);assert.equal(ambiguous.clarification.kind,'venue');assert.equal(ambiguous.clarification.choices.length,2);
 const selected=prepare('给小林在滨江约课',context,{previous:{venueId:'v2'}});assert.equal(selected.clarification,null);assert.equal(selected.meta.resolved.venueId,'v2');
});
test('pure availability question is not converted to an appointment or opening change',()=>{
 for(const text of ['明晚有空吗','明天晚上有时间吗','哪个时段有空','看看开放时间，有空档吗']) {
  const r=prepare(text);assert.equal(r.clarification.kind,'availability-query');assert.match(r.clarification.question,/不会生成预约或修改开放时间/u);assert.equal(r.meta.tasks.includes('booking'),false);
 }
});
const studentBookingContext={role:'student',selfStudentId:'s1',students:[student('s1','小林')],currentCoachName:'示例 · 周教练'};
test('student read-only balance language is not intercepted by booking coach selection',()=>{
 const phrases=['我还剩几节？只查当前教练这里的余额。','只查这位教练我的课时余额。','只看看我在目前这位教练这里还剩几节。','只查询我的剩余课时。'];
 for(const currentCoachName of [undefined,'','示例 · 周教练'])for(const text of phrases){
  const r=prepare(text,{...studentBookingContext,currentCoachName});assert.equal(r.clarification,null,text);assert.deepEqual(r.meta.tasks,['balance']);assert.equal(r.meta.studentBookingRequest,null);assert.equal(r.meta.resolved.studentId,'s1');assert.equal(r.input.text,text);
 }
});
test('student read-only statistics retain the current authorized relationship without booking metadata',()=>{
 for(const currentCoachName of [undefined,'示例 · 周教练'])for(const text of ['只看当前教练本月上了多少节课。','只查询我在这位教练这里本月课程情况。']){
  const r=prepare(text,{...studentBookingContext,currentCoachName});assert.equal(r.clarification,null,text);assert.ok(r.meta.tasks.includes('summary'));assert.equal(r.meta.tasks.includes('booking'),false);assert.equal(r.meta.studentBookingRequest,null);assert.equal(r.meta.resolved.studentId,'s1');assert.equal(r.input.text,text);
 }
});
test('student short availability question becomes a self booking request hint for the current coach',()=>{
 for(const text of ['明晚有空吗','明晚能练吗','方便上课吗','能约一节课吗','明晚有没有空']){const r=prepare(text,studentBookingContext);assert.equal(r.clarification,null,text);assert.ok(r.meta.tasks.includes('booking'),text);assert.equal(r.meta.resolved.studentId,'s1');assert.equal(r.meta.studentBookingRequest.kind,'booking-request');assert.equal(r.meta.studentBookingRequest.requiresConfirmation,true);assert.equal(r.input.text,text);assert.equal(r.meta.resolved.start,null);assert.equal(r.meta.resolved.venueId,null);assert.equal('duration' in r.meta.resolved,false);}
});
test('indirect named coach request never treats the recipient as an unknown student',()=>{
 for(const text of ['帮我问周教练明晚能否约课','帮我问问周教练明晚能不能上课','问一下我的教练明晚有空吗','帮我给周教练问问明晚有空吗','向周教练问一下明晚能不能约课','请问周教练明晚能练吗']){
  const r=prepare(text,studentBookingContext);assert.equal(r.clarification,null,text);assert.equal(r.meta.studentBookingRequest.kind,'booking-request');assert.deepEqual(r.meta.unknownStudentNames,[]);assert.equal(r.meta.resolved.studentId,'s1');assert.equal(r.input.text,text);
 }
});
test('only exact current-coach display decorations are normalized',()=>{
 for(const [currentCoachName,text] of [['周教练的网球课','帮我问周教练明晚能否约课'],['Roy的网球课','帮我问Roy教练明晚有空吗'],['示例 · Roy的网球课','帮我问roy明晚有空吗']]){
  const r=prepare(text,{...studentBookingContext,currentCoachName});assert.equal(r.clarification,null,text);assert.equal(r.meta.studentBookingRequest.coachName,currentCoachName);assert.deepEqual(r.meta.unknownStudentNames,[]);
 }
});
test('student explicitly read-only availability language never becomes a booking hint',()=>{
 for(const text of ['只查周教练明晚的空档','只看看明晚有空吗','帮我问周教练明晚能否约课，先不要申请','查看可约时段，不要预约','明晚有空吗，不要发送预约申请','查一下明晚有哪些可约时间，先不要发申请','查一下明晚有哪些可约时间','查看明天的可约时间','先不要发申请']){
  const r=prepare(text,studentBookingContext);assert.equal(r.clarification.kind,'availability-query',text);assert.notEqual(r.meta.studentBookingRequest?.kind,'booking-request');assert.match(r.clarification.question,/不会/u);
 }
});
test('explicitly postponing booking or only wanting to see times is read-only before inference',()=>{
 for(const text of ['明晚有空吗？先别约，我只是想看看时间。','先别约，我只是想看看时间','明晚有空吗？先别约。','明晚有空吗，暂时不约了','明晚有空吗，我只想看看时间']){
  const r=prepare(text,studentBookingContext);assert.equal(r.clarification.kind,'availability-query',text);assert.equal(r.meta.studentBookingRequest.kind,'read-only');assert.equal(r.meta.studentBookingRequest.requiresConfirmation,false);assert.equal(r.meta.tasks.includes('booking'),false);assert.equal(r.input.text,text);
 }
});
test('listing the current coach availability is read-only while another coach stays out of scope',()=>{
 for(const text of ['把周教练明晚的空档列出来。','请把周教练明晚的空档列一下','将周教练明晚的可约时间显示出来']){
  const r=prepare(text,studentBookingContext);assert.equal(r.clarification.kind,'availability-query',text);assert.equal(r.meta.studentBookingRequest.kind,'read-only');assert.deepEqual(r.meta.unknownStudentNames,[]);assert.equal(r.meta.tasks.includes('booking'),false);assert.equal(r.input.text,text);
 }
 const other=prepare('把林教练明晚的空档列出来',studentBookingContext);assert.equal(other.clarification.kind,'coach');assert.equal(other.meta.studentBookingRequest,null);
});
test('longest read-only coach prefix preserves current and different coach identity',()=>{
 const context={...studentBookingContext,currentCoachName:'示例 · 甲教练'};
 for(const prefix of ['只看看','只想看看','只是想看看','我只是想看看','只看一下','只查询']){
  const text=prefix+'甲教练明晚有没有空，不要预约',r=prepare(text,context);assert.equal(r.clarification.kind,'availability-query',text);assert.equal(r.meta.studentBookingRequest.kind,'read-only');assert.equal(r.meta.studentBookingRequest.requiresConfirmation,false);assert.deepEqual(r.meta.unknownStudentNames,[]);assert.equal(r.input.text,text);
  const other=prepare(prefix+'乙教练明晚有没有空，不要预约',context);assert.equal(other.clarification.kind,'coach',prefix);assert.equal(other.meta.studentBookingRequest,null);assert.deepEqual(other.meta.unknownStudentNames,[]);
 }
});
test('another unknown or multiple coach names require choosing the right coach rather than routing to the current one',()=>{
 for(const text of ['帮我问林教练明晚能否约课','帮我问某某教练明晚有空吗','帮我问周教练和林教练明晚能否约课','问一下其他教练明晚有空吗','帮我问小周教练明晚有空吗','问两位教练明晚有空吗']){
  const r=prepare(text,studentBookingContext);assert.equal(r.clarification.kind,'coach',text);assert.equal(r.clarification.field,null);assert.deepEqual(r.clarification.choices,[]);assert.equal(r.meta.studentBookingRequest,null);assert.deepEqual(r.meta.unknownStudentNames,[]);
 }
 const english=prepare('帮我问Royce明晚有空吗',{...studentBookingContext,currentCoachName:'Roy的网球课'});assert.equal(english.clarification.kind,'coach');
});
test('student inquiry requires a current associated coach and authenticated self',()=>{
 for(const patch of [{currentCoachName:undefined},{selfStudentId:'not-authorized'}]){
  const r=prepare('明晚有空吗',{...studentBookingContext,...patch});assert.equal(r.clarification.kind,'coach');assert.equal(r.meta.studentBookingRequest,null);
 }
});
test('explicit external messaging is not relabeled as a sent internal booking request',()=>{
 for(const text of ['帮我给周教练发微信问明晚能不能约课','用短信问周教练明晚有空吗']){
  const r=prepare(text,studentBookingContext);assert.equal(r.clarification.kind,'external-message');assert.match(r.clarification.question,/不支持代发微信或短信/u);assert.equal(r.meta.studentBookingRequest,null);
 }
 const r=prepare('不要发微信，帮我问周教练明晚能不能约课',studentBookingContext);assert.equal(r.clarification,null);assert.equal(r.meta.studentBookingRequest.kind,'booking-request');
});
test('ordinary coach availability inquiries remain read-only',()=>{
 const r=prepare('明晚有空吗',{currentCoachName:'周教练'});assert.equal(r.clarification.kind,'availability-query');assert.equal(r.meta.studentBookingRequest,null);assert.equal(r.meta.tasks.includes('booking'),false);
});
test('indirect student booking retains other tasks and the original description',()=>{
 const text='帮我问周教练明晚能否约课，然后查询我的余额。',r=prepare(text,studentBookingContext);assert.equal(r.clarification,null);assert.ok(r.meta.tasks.includes('booking'));assert.ok(r.meta.tasks.includes('balance'));assert.equal(r.meta.studentBookingRequest.kind,'booking-request');assert.equal(r.input.text,text);assert.equal(r.meta.resolved.studentId,'s1');
});
test('availability query mixed with an explicit task retains both for model interpretation',()=>{
 const r=prepare('明晚有空吗？然后给小林约课');assert.equal(r.clarification,null);assert.ok(r.meta.tasks.includes('availability-query'));assert.ok(r.meta.tasks.includes('booking'));assert.equal(r.input.text,'明晚有空吗？然后给小林约课');
});
test('selected message and explicitly different student require message disambiguation',()=>{
 const r=prepare('拒绝Roy的预约',{messageId:'m1'});assert.equal(r.clarification.kind,'message');assert.equal(r.clarification.field,'messageId');assert.deepEqual(ids(r.clarification.choices),['m1','m2']);
});
test('a new-venue plus booking plus credit request retains every intent and needed entity',()=>{
 const r=prepare('添加一个场地，然后给小林约课，同时给Roy登记10课时');assert.equal(r.clarification,null);assert.ok(['add-venue','booking','credit'].every(task=>r.meta.tasks.includes(task)));assert.deepEqual(ids(r.input.context.students),['s1','s2']);assert.deepEqual(ids(r.input.context.lessons),['l1','l2']);assert.deepEqual(ids(r.input.context.venues),['v1','v2']);
});
test('unknown clauses retain all authorized context instead of guessing task scope',()=>{
 const i=fixture('给小林约课；还有一件事情想处理'),r=prepareUnderstanding(i);assert.equal(r.meta.scope.mode,'authorized-full');assert.deepEqual(r.input.context.lessons,i.context.lessons);assert.deepEqual(r.input.context.students,i.context.students);
});
test('whole-coach statistics preserve global scope despite a page-selected student',()=>{
 const i=fixture('统计所有学员本月的课程',{selectedStudent:'s1'}),r=prepareUnderstanding(i);assert.equal(r.meta.scope.mode,'authorized-full');assert.deepEqual(r.input.context.lessons,i.context.lessons);assert.deepEqual(r.input.context.students,i.context.students);
});
test('reviewed multi-step plans retain existing referenced records for patch validation',()=>{
 const i=fixture('给小林约课',{reviewedPlan:JSON.stringify({steps:[{id:'s1',operation:{studentId:'s2',lessonId:'l2'}}]})}),r=prepareUnderstanding(i);assert.equal(r.meta.scope.mode,'authorized-full');assert.deepEqual(r.input.context.lessons,i.context.lessons);assert.equal(r.input.context.reviewedPlan,i.context.reviewedPlan);
});
test('pure balance projection drops unrelated history while retaining the relevant balance',()=>{
 const r=prepare('帮小林查余额');assert.equal(r.meta.scope.mode,'task-projection');assert.deepEqual(ids(r.input.context.students),['s1']);assert.equal(r.input.context.students[0].balance,10);assert.equal(r.input.context.students[0].goal,'');assert.deepEqual(r.input.context.lessons,[]);assert.deepEqual(r.input.context.messages,[]);assert.deepEqual(r.input.context.rules,[]);assert.deepEqual(r.input.context.practices,[]);
});
test('new-student creation is not misclassified as a booking',()=>{
 const r=prepare('添加一个学员，名字是新学员');assert.ok(r.meta.tasks.includes('add-student'));assert.equal(r.meta.tasks.includes('booking'),false);
});
test('profile editing keeps existing free text unchanged',()=>{
 const r=prepare('更新小林学员的目标');assert.equal(r.input.context.students.find(row=>row.id==='s1').goal,'正手稳定');assert.equal(r.input.context.students.find(row=>row.id==='s1').next,'反手脚步');
});
test('retained small-group lessons retain all participants rather than becoming one-to-one',()=>{
 const r=prepare('给小林约课',{lessons:[lesson('group',['s1','s2']),lesson('other',['s3'])]});assert.deepEqual(ids(r.input.context.lessons),['group']);assert.deepEqual(r.input.context.lessons[0].students,['s1','s2']);assert.deepEqual(ids(r.input.context.students),['s1','s2']);
});
test('pre-schema large authorized inputs can be narrowed without first truncating names',()=>{
 const students=Array.from({length:350},(_,i)=>student(`s${i}`,`测试学员${i}`));const lessons=Array.from({length:600},(_,i)=>lesson(`l${i}`,[`s${i%350}`]));
 const r=prepare('给测试学员349约课',{students,lessons});assert.equal(r.meta.resolved.studentId,'s349');assert.deepEqual(ids(r.input.context.students),['s349']);assert.deepEqual(ids(r.input.context.lessons),['l349']);assert.equal(r.meta.scope.before.students,350);assert.equal(r.meta.scope.after.students,1);
});
test('meta contains only relevant authorized evidence, not arbitrary private text',()=>{
 const r=prepare('帮小林查余额',{students:[student('s1','小林',{goal:'PRIVATE_CANARY'})]});assert.equal(JSON.stringify(r.meta).includes('PRIVATE_CANARY'),false);assert.deepEqual(r.meta.matches.students,[{id:'s1',name:'小林'}]);
});
test('text override is applied without rewriting the supplied original input',()=>{
 const i=fixture('旧句子'),r=prepareUnderstanding(i,{text:'给Roy约课'});assert.equal(i.text,'旧句子');assert.equal(r.input.text,'给Roy约课');assert.equal(r.meta.resolved.studentId,'s2');
});
test('negated old-place and old-time references never become inherited defaults',()=>{
 const r=prepare('给小林约课，不要老时间，不去老地方');assert.equal(r.clarification,null);assert.equal(r.meta.resolved.venueId,null);assert.equal(r.meta.resolved.start,null);assert.equal(r.meta.resolved.sourceLessonId,null);
});
test('old-time without history asks for a time, not an irrelevant venue choice',()=>{
 const r=prepare('给小林老时间约课',{lessons:[]});assert.equal(r.clarification.kind,'history');assert.equal(r.clarification.field,null);assert.deepEqual(r.clarification.choices,[]);assert.match(r.clarification.question,/几点开始/u);
});
test('new old-place wording overrides a previous unrelated venue choice',()=>{
 const r=prepare('给小林约课，还是老地方',{}, {previous:{venueId:'v2'}});assert.equal(r.meta.resolved.venueId,'v1');assert.equal(r.meta.resolved.venueBasis,'latest-completed-lesson');assert.equal(r.meta.resolved.sourceLessonId,'l1');
});
test('explicit choice resolves tied historical venue candidates without inventing history',()=>{
 const r=prepare('给小林在老地方约课',{lessons:[lesson('a',['s1']),lesson('b',['s1'],{venue:'v2'})]},{previous:{venueId:'v2'}});assert.equal(r.clarification,null);assert.equal(r.meta.resolved.venueId,'v2');assert.equal(r.meta.resolved.venueBasis,'explicit-choice');
});
test('two mentioned venues never collapse into a previous selection',()=>{
 const r=prepare('给小林约课，不去滨江网球场了，改在弘金地',{}, {previous:{venueId:'v1'}});assert.equal(r.meta.resolved.venueId,null);assert.deepEqual(ids(r.meta.matches.venues),['v1','v2']);
});
test('其他 and 他人 are not singular participant pronouns',()=>{
 for(const text of ['滨江网球场地址纠正为上海测试路18号，其他不改','滨江网球场地址改为上海测试路18号，其他不动','所有其他人按原安排','不读取他人资料']){
  const r=prepare(text);assert.equal(r.clarification,null,text);assert.equal(r.meta.resolved.studentId,null,text);
 }
});
test('multi-person historical candidate choice resolves history without merging participants',()=>{
 const text='给小宇登记10课时，然后给安安在老地方约课';
 const context={students:[student('s3','小宇'),student('s4','安安')],lessons:[lesson('yu',['s3']),lesson('an',['s4'],{venue:'v2'})]};
 const first=prepare(text,context);assert.equal(first.clarification.kind,'student');assert.deepEqual(ids(first.clarification.choices),['s3','s4']);
 const selected=prepare(text,{...context,selectedStudent:'s4'},{previous:{selectedStudent:'s4',explicitStudentChoice:'s4'}});
 assert.equal(selected.clarification,null);assert.equal(selected.input.context.selectedStudent,null);assert.equal(selected.meta.resolved.studentId,null);assert.equal(selected.meta.resolved.historyStudentId,'s4');assert.equal(selected.meta.resolved.historyStudentBasis,'explicit-history-choice');assert.equal(selected.meta.resolved.venueId,'v2');assert.equal(selected.meta.resolved.sourceLessonId,'an');assert.deepEqual(ids(selected.meta.matches.students),['s3','s4']);assert.deepEqual(ids(selected.input.context.students),['s3','s4']);assert.ok(selected.meta.tasks.includes('credit'));assert.ok(selected.meta.tasks.includes('booking'));
});
test('historical candidate must still belong to current authorized context',()=>{
 const r=prepare('给小林登记课时，然后给Roy老地方约课',{}, {previous:{explicitStudentChoice:'foreign-private-student'}});assert.equal(r.clarification.kind,'student');assert.equal(r.meta.resolved.historyStudentId,null);assert.equal(JSON.stringify(r).includes('foreign-private-student'),false);
});
test('explicit historical choice does not override a unique current named student',()=>{
 const r=prepare('给小林老地方约课',{}, {previous:{explicitStudentChoice:'s2'}});assert.equal(r.meta.resolved.studentId,'s1');assert.equal(r.meta.resolved.historyStudentId,'s1');assert.equal(r.meta.resolved.venueId,'v1');assert.equal(r.meta.resolved.sourceLessonId,'l1');
});
test('one newly named student and her purchased hours remain a dependent multi-step task',()=>{
 const text='新增学员小禾，然后登记她已购买5课时。',r=prepare(text,{selectedStudent:'s1'});assert.equal(r.clarification,null);assert.equal(r.input.context.selectedStudent,null);assert.equal(r.meta.resolved.studentBasis,'new-student-dependency');assert.equal(r.meta.scope.mode,'new-entity-dependencies');assert.ok(r.meta.tasks.includes('add-student'));assert.ok(r.meta.tasks.includes('credit'));assert.equal(r.input.text,text);
});
test('new student noun modifiers preserve a four-task dependent chain',()=>{
 for(const noun of ['新学员','新的学员','一名新学员','一个新的学员','一位新学生','个新学员']){
  const text=`添加${noun}小禾，登记她已购买10课时，备注已购买。然后给她在滨江网球场明天下午3点到4点安排正反手课，最后查询她的余额。`,r=prepare(text,{selectedStudent:'s2'});
  assert.equal(r.clarification,null,noun);assert.equal(r.meta.resolved.studentBasis,'new-student-dependency',noun);assert.equal(r.meta.scope.mode,'new-entity-dependencies');assert.equal(r.meta.resolved.studentId,null);assert.equal(r.input.context.selectedStudent,null);for(const task of ['add-student','credit','booking','balance'])assert.ok(r.meta.tasks.includes(task),noun+' '+task);assert.equal(r.input.text,text);assert.deepEqual(ids(r.input.context.students),['s1','s2','s3']);assert.deepEqual(ids(r.input.context.venues),['v1','v2']);
 }
});
test('new learner live-chain wording reaches the model without selecting an unrelated learner',()=>{
 const text='添加新学员小宇，登记他已购买10课时，备注已购买。然后给他在甲网球场2026-11-03下午3点到4点安排正反手课，最后查询他的余额。';
 const r=prepare(text,{students:[student('s1','小林')],venues:[venue('v1','甲网球场')]});assert.equal(r.clarification,null);assert.equal(r.meta.resolved.studentId,null);assert.equal(r.meta.resolved.studentBasis,'new-student-dependency');for(const task of ['add-student','credit','booking','balance'])assert.ok(r.meta.tasks.includes(task));assert.equal(r.input.text,text);assert.deepEqual(ids(r.input.context.students),['s1']);
});
test('new student profile plus pronoun booking and balance do not use the stale page student',()=>{
 const text='先建小禾档案，接着记她已购8课时，然后明天16点在滨江约一小时，最后查她余额。',r=prepare(text,{selectedStudent:'s2'});assert.equal(r.clarification,null);assert.equal(r.input.context.selectedStudent,null);assert.equal(r.meta.resolved.studentBasis,'new-student-dependency');assert.ok(r.meta.tasks.includes('add-student'));assert.equal(r.input.text,text);assert.equal(r.input.context.students.some(row=>row.name==='小禾'),false);
});
test('new student and new venue retain their forward references for model interpretation',()=>{
 const text='新建学员阿岳、新增晨光网球场，然后给他明天15点在这个新场地约60分钟。',r=prepare(text);assert.equal(r.clarification,null);assert.equal(r.meta.resolved.studentId,null);assert.equal(r.meta.resolved.venueId,null);assert.equal(r.meta.resolved.studentBasis,'new-student-dependency');assert.equal(r.input.text,text);assert.deepEqual(ids(r.input.context.venues),['v1','v2']);
});
test('a new venue followed by here booking keeps the explicit existing participant',()=>{
 const text='添加一个场地，然后给小林明天15点在这里约课',r=prepare(text);assert.equal(r.clarification,null);assert.equal(r.meta.resolved.studentId,'s1');assert.equal(r.meta.resolved.venueId,null);assert.ok(r.meta.tasks.includes('add-venue'));assert.ok(r.meta.tasks.includes('booking'));assert.equal(r.input.text,text);
});
test('a new-student phrase with another explicit participant does not force a new-person alias',()=>{
 const r=prepare('新增学员小禾，再给小林约课，然后查他余额');assert.notEqual(r.meta.resolved.studentBasis,'new-student-dependency');assert.equal(r.meta.resolved.studentId,'s1');
 const ambiguous=prepare('新增学员小禾，新增学员小夏，然后给她约课');assert.equal(ambiguous.clarification.kind,'student');assert.notEqual(ambiguous.meta.resolved.studentBasis,'new-student-dependency');
});
test('unique venue short names use shared bounded suffix matching',()=>{
 for(const [name,text] of [['松林网球场','给小林在松林约课'],['城西网球俱乐部','给小林去城西约课'],['山海网球训练中心','给小林在山海约一小时']]){
  const r=prepare(text,{venues:[venue('v1','滨江网球场'),venue('v2',name)],lessons:[],messages:[]});assert.equal(r.clarification,null);assert.equal(r.meta.resolved.venueId,'v2');assert.equal(r.meta.resolved.venueBasis,'explicit-name');assert.deepEqual(ids(r.meta.matches.venues),['v2']);assert.deepEqual(ids(r.input.context.venues),['v2']);
 }
});
test('venue short name beside a day and morning phrase still resolves uniquely',()=>{
 const r=prepare('小宇下周六青山早上九点，一小时私教，安排下。',{venues:[venue('v1','滨江网球场'),venue('v2','青山网球场')],lessons:[lesson('yu',['s3'],{venue:'v2'})],messages:[]});assert.equal(r.clarification,null);assert.equal(r.meta.resolved.venueId,'v2');assert.deepEqual(ids(r.input.context.venues),['v2']);assert.ok(r.meta.tasks.includes('booking'));
});
test('common venue prefix does not bind a different longer place',()=>{
 const context={venues:[venue('v1','青山网球场'),venue('v2','青山北场网球场')],lessons:[],messages:[]};
 const longer=prepare('给小林在青山北场约课',context);assert.equal(longer.meta.resolved.venueId,'v2');assert.deepEqual(ids(longer.meta.matches.venues),['v2']);
 const short=prepare('给小林在青山约课',context);assert.equal(short.meta.resolved.venueId,'v1');assert.deepEqual(ids(short.meta.matches.venues),['v1']);
 const absent=prepare('给小林在青山北场约课',{...context,venues:[venue('v1','青山网球场')]});assert.equal(absent.meta.resolved.venueId,null);assert.deepEqual(absent.meta.matches.venues,[]);
});
test('shared venue short name asks a choice and honors its authorized selected ID',()=>{
 const context={venues:[venue('v1','滨江网球场'),venue('v2','滨江网球俱乐部')],lessons:[],messages:[]};
 const first=prepare('给小林在滨江约课',context);assert.equal(first.clarification.kind,'venue');assert.deepEqual(ids(first.clarification.choices),['v1','v2']);
 const chosen=prepare('给小林在滨江约课',context,{previous:{venueId:'v2'}});assert.equal(chosen.clarification,null);assert.equal(chosen.meta.resolved.venueId,'v2');assert.deepEqual(ids(chosen.input.context.venues),['v2']);
});
test('fully named venues in two tasks do not become a short-name ambiguity',()=>{
 const r=prepare('给小林在滨江网球场约课，然后给Roy在滨江网球俱乐部约课',{venues:[venue('v1','滨江网球场'),venue('v2','滨江网球俱乐部')]});assert.equal(r.clarification,null);assert.equal(r.meta.resolved.venueId,null);assert.deepEqual(ids(r.meta.matches.venues),['v1','v2']);assert.deepEqual(ids(r.input.context.venues),['v1','v2']);
});
test('pure booking venue projection keeps venues required by retained lessons and messages',()=>{
 const r=prepare('给小林在青山约课',{venues:[venue('v1','滨江网球场'),venue('v2','青山网球场'),venue('v3','云海网球馆')],lessons:[lesson('l1',['s1'],{venue:'v1'}),lesson('l2',['s2'],{venue:'v3'})],messages:[{id:'m1',student:'s1',lesson:'l2',kind:'status',state:'pending',title:'关联课',text:'测试'}]});assert.equal(r.meta.resolved.venueId,'v2');assert.deepEqual(ids(r.input.context.venues),['v1','v2','v3']);assert.equal(r.meta.scope.mode,'booking-venue-projection');
});
test('mixed venue and profile tasks retain all authorized venue choices',()=>{
 const r=prepare('给小林在青山约课，同时修改Roy学员的目标',{venues:[venue('v1','滨江网球场'),venue('v2','青山网球场'),venue('v3','云海网球馆')],lessons:[],messages:[]});assert.equal(r.meta.resolved.venueId,'v2');assert.deepEqual(ids(r.input.context.venues),['v1','v2','v3']);assert.notEqual(r.meta.scope.mode,'booking-venue-projection');
});
test('separate booking tasks preserve all venue candidates when one place is unknown',()=>{
 const r=prepare('给小林在青山约课，然后给Roy在莫干山约课',{venues:[venue('v1','滨江网球场'),venue('v2','青山网球场'),venue('v3','云海网球馆')],lessons:[],messages:[]});assert.equal(r.clarification,null);assert.deepEqual(ids(r.input.context.venues),['v1','v2','v3']);assert.notEqual(r.meta.scope.mode,'booking-venue-projection');assert.deepEqual(ids(r.meta.matches.students),['s1','s2']);
});
