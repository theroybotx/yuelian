/*
 * Request-scoped grounding, after RLS + scopeInput and before model inference.
 * Design / acceptance contract:
 * - Only IDs and facts already in input may become evidence or candidates.
 * - Exact normalized names outrank UI anchors; duplicate names require a choice.
 * - UI / previous anchors are revalidated on every request. No persistent alias
 *   memory, fuzzy name match, guessed nickname or global lookup is performed.
 * - "老地方" means the selected student's unique latest completed lesson venue;
 *   it never silently inherits date, time, duration or training notes.
 * - Retrieval unions every recognized task. Unknown clauses, broad requests and
 *   reviewed plans keep full authorized context rather than truncate a task.
 * - This is evidence preparation, not authorization, execution or an intent
 *   router. The model and existing plan / transaction validation still run.
 */
import {matchingVenues,venueNames} from '../shared/assistant.ts';
const normalize = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
const unique = values => [...new Set(values)];
const rules = [
 ['booking', /约课|预约|排课|安排.{0,12}(?:课|训练)|(?:私教|一对一|陪练).{0,6}(?:安排|排|约)|(?:添加|加|开)(?:(?:一个|一节|一堂|个|节|堂)?(?:课程|课(?!时))|[一二三四五六七八九十\d]+(?:节|堂)课)|约(?:一下|一节|一小时|两小时|个课)|(?<!大)约\s*(?:[01]?\d|2[0-3])(?:点|[:：][0-5]\d)\s*(?:到|至|[-—])\s*(?:[01]?\d|2[0-3])(?:点|[:：][0-5]\d)/u],
 ['availability-query', /有没有(?:空|时间)|有空(?:吗|么|不|没)|有时间(?:吗|么|不|没)|(?:什么时候|哪天|哪个时段).{0,12}(?:有空|可以约|能约)|空闲时段|空档|可约(?:时间|时段)|能(?:约|练|上课).{0,6}(?:吗|么|不|没)|方便(?:上课|约课|练球)(?:吗|么|不)/u],
 ['record', /课后记录|上课记录|记录.{0,8}(?:课|上课)|记(?:一下|下|一笔|这节|上次|今天).{0,8}课|消课|扣课时|上完/u],
 ['availability', /开放(?:时间|时段|规则)|可预约|放开.{0,12}(?:时间|时段)|每(?:周|星期)/u],
 ['add-student', /(?:添加|新增|新建|建立|建)(?:一?(?:个|位|名))?(?:新的?)?(?:学员|学生|档案)|(?:学员|学生).{0,12}建档/u],
 ['edit-student', /(?:修改|更新|调整|改).{0,12}(?:学员|学生|目标|训练计划|下次重点)|(?:学员|学生|目标|下次重点).{0,12}(?:修改|更新|改成)/u],
 ['credit', /购课|买(?:了|的)?(?:[一二三四五六七八九十\d]+)?(?:节|小时|课时)|购买|充值|登记.{0,12}(?:课时|购买|节)|加.{0,8}(?:课时|余额)/u],
 ['balance', /余额|剩余|还剩|剩下|查.{0,8}课时|还有.{0,8}(?:课时|节课)/u],
 ['summary', /统计|热力图|上了多少|上课情况|课程情况|(?:本月|这个月|上月).{0,12}(?:多少|几节|汇总)|(?:汇总|总计|合计)/u],
 ['followup', /回访|没来|未到课/u],
 ['add-venue', /(?:添加|新增|新建|加)(?:一个|个|一处|处)?(?:场地|球场)|(?:场地|球场).{0,20}(?:添加|新增|收藏)/u],
 ['edit-venue', /(?:修改|更新|调整|改).{0,16}(?:场地|球场|地址|室内)|(?:场地|球场|地址).{0,16}(?:改成|修改|更新)/u],
 ['edit-base', /(?:常规|基础|默认)开放|通勤|转场|开放日|营业/u],
 ['edit-lesson', /(?:修改|调整|改).{0,20}(?:课程|这节课|那节课|时长|分钟|训练内容)|(?:课程|这节课|那节课|时长).{0,20}(?:改成|修改|调整)/u],
 ['message-decision', /确认|同意|接受|拒绝|驳回/u],
 ['resolve-message', /(?:消息|反馈|通知).{0,14}(?:已处理|处理完|完成)|标记.{0,10}(?:处理|消息)/u],
 ['practice', /练习|自主训练|训练日记/u],
 ['edit-practice', /(?:修改|更新|调整|改|共享|分享|公开).{0,12}(?:练习|训练日记)|(?:练习|训练日记).{0,12}(?:修改|改成|共享|分享|公开)/u],
];
const tasksIn = text => rules.filter(([, pattern]) => pattern.test(text)).map(([task]) => task);
const singularPronoun = /(?:给|帮|替|为)?(?<!其)(?:他|她)(?!们|俩|两|人)|这位学员|这个学员|该学员|这名学员|本人|我自己/u;
const oldVenue = /老地方|老场地|上次(?:的)?(?:场地|球场|地方)|原来那(?:儿|里|个场地|个球场)|照上次|跟上次一样|和上次一样/u;
const oldTime = /老时间|原来(?:的)?时间|上次(?:的)?(?:时间|几点)|还是那个点/u;
const groupPronoun = /我俩|我们俩|咱俩|他俩|她俩|我们两个|咱们两个/u;
const broadRequest = /所有|全部|大家|每(?:个|位)|各(?:个|位)|其他|其它|分别|对比|比较|整体|全体/u;
const affirmativeReference = (pattern,text) => [...text.matchAll(new RegExp(pattern.source,'gu'))].some(match => !/(?:不|别|不要|不用|不去|不在|不是|不按)(?:再)?(?:去|在|用|按)?$/u.test(text.slice(Math.max(0,match.index-8),match.index).trimEnd()));
const coachPrefix=/^(?:(?:请问|请|麻烦|帮忙|帮我|替我|给我|给|向|把|将|我想|我要|我的|我|先|再|然后|顺便|也|跟|和|找|联系|预约|约|问问|问一下|问下|问|一下|当前|这位|现在这位|目前这位|只(?:是)?想?(?:看看|看一下|查询|查一下|查下|看|查)|查询|查看|看看|看一下|查一下|查下)\s*)+/u;
function coachReferences(text,displayName) {
 const full=normalize(displayName),label=full.replace(/^示例\s*[·・•：:]\s*/u,'').replace(/的网球课$/u,'').trim();
 const aliases=unique([full,label,...(label&&!label.endsWith('教练')?[label+'教练']:[])]).filter(Boolean),mentions=[];
 for(const match of text.matchAll(/[\p{Script=Han}a-z0-9 .'’-]{0,40}?教练/gu)){
  const raw=match[0],trimmed=raw.trim();let name=trimmed.replace(coachPrefix,'');
  // Prefer the full authorized label, including names beginning with a word
  // which can also be a sentence prefix. Never reduce a name to its surname.
  const exact=aliases.find(alias=>trimmed.endsWith(alias)&&!trimmed.slice(0,-alias.length).replace(coachPrefix,'').trim());if(exact)name=exact;
  mentions.push({name,start:match.index+raw.lastIndexOf(name),end:match.index+raw.length});
 }
 // A named recipient after "问" may omit the 教练 title (e.g. Roy). It still
 // must match the complete current label; an unknown recipient is not routed.
 for(const match of text.matchAll(/(?:问问|问一下|问下|问)\s*([^，,。；;？！!?\n]{1,30}?)(?=明晚|今晚|明天|后天|下周|这周|能否|是否|有空|有没有空|能不能|可不可以|可以)/gu)){
  const name=match[1].trim(),recipient=name.replace(coachPrefix,'').trim();
  if(name.includes('教练')||!name||!aliases.includes(name)&&(!recipient||/^(?:今天|明天|后天|今晚|明晚|下周|这周|周末|上午|下午|晚上|能否|是否|有没有|能不能|可不可以|可以)/u.test(recipient)))continue;
  mentions.push({name,start:match.index+match[0].lastIndexOf(match[1]),end:match.index+match[0].length});
 }
 const named=mentions.filter(m=>m.name!=='教练'),unknown=named.some(m=>!aliases.includes(m.name));
 const multiple=unique(named.map(m=>m.name)).length>1||/(?:两|几|多)(?:位|个)?教练|教练们/u.test(text);
 return {displayName:typeof displayName==='string'?displayName.trim():'',aliases,mentions,unknown,multiple};
}
const readOnlyAvailability = (text,schedulingContext) => schedulingContext&&/只(?:是)?想?(?:查|查询|看|看看)/u.test(text)||/(?:查看|查询|查一下|查下|看一下|看看|列出|列一下|展示|显示).{0,16}(?:空档|空闲时段|可约(?:时间|时段)|开放时间)|(?:空档|空闲时段|可约(?:时间|时段)|开放时间).{0,12}(?:列出|列一下|展示|显示)|(?:先|暂时)?(?:不要|不用|别|不)(?:发(?:送|起)?|提交|创建)?(?:预约)?申请|(?:先|暂时)?(?:不要|不用|别|不)(?:再)?(?:预约|约课|约球|约(?=$|[，,。；;？！!?\s]|了|吧|呢))/u.test(text);

// Recognize only explicit target syntax, not arbitrary noun phrases. Unknown
// names suppress a stale selectedStudent; they are never mapped to a near name.
function namedTargets(text) {
 const pattern = /(?:给|替|为|帮)\s*(?:学员|学生)?\s*([a-z][a-z0-9 .'’-]{0,19}|[\p{Script=Han}]{1,12}?)(?=\s*(?:在|到|约|安排|登记|查|查询|添加|加|更新|修改|记录|记|充值|确认|拒绝|老时间|老地方|照上次|按上次|明天|今天|后天|明晚|今晚|上午|下午|晚上|早上|下周|这周|周末|周[一二三四五六日天]))/giu;
 return [...text.matchAll(pattern)].filter(match => !/^(?:我|我们|他|她|他们|她们|大家|学员|学生|所有人|每个人|自己)$/u.test(match[1])).map(match => ({name:normalize(match[1]),start:match.index + match[0].lastIndexOf(match[1]),end:match.index + match[0].length}));
}
function nameMatches(text, rows, targets = []) {
 const value = normalize(text), matches = [];
 const names = unique(rows.map(row => normalize(row.name))).filter(Boolean).sort((a,b) => b.length - a.length);
 const spans = [];
 for (const name of names) {
  if (name.length === 1 && !targets.some(target => target.name === name)) continue;
  for (let from = 0, start; (start = value.indexOf(name, from)) >= 0; from = start + name.length) {
   const end = start + name.length;
   if (/^[a-z0-9]/u.test(name) && /[a-z0-9]/u.test(value[start - 1] || '')) continue;
   if (/[a-z0-9]$/u.test(name) && /[a-z0-9]/u.test(value[end] || '')) continue;
   if (spans.some(span => start >= span.start && end <= span.end)) continue;
   // The normalized text normally keeps positions; target-name comparison is
   // sufficient even when NFKC expands a Unicode character before the target.
   if (targets.some(target => target.name !== name && target.name.includes(name) && value.includes(target.name))) continue;
   spans.push({start,end});
   matches.push(...rows.filter(row => normalize(row.name) === name));
  }
 }
 const matchedIds = new Set(matches.map(row => row.id));
 return rows.filter(row => matchedIds.has(row.id));
}
function newStudentNames(text) {
 const named=/(?:新增|新建|添加|建立)(?:一?(?:个|位|名))?(?:新的?)?(?:学员|学生)(?:档案)?\s*(?:叫|名叫|名字是|：|:)?\s*([\p{Script=Han}a-z][\p{Script=Han}a-z0-9 .'-]{0,19}?)(?=[，,、。；;\n]|然后|接着|再|$)/gu;
 const profile=/(?:建|建立|新建|添加)\s*([\p{Script=Han}a-z][\p{Script=Han}a-z0-9 .'-]{0,19}?)\s*(?:的)?档案/gu;
 return unique([...text.matchAll(named),...text.matchAll(profile)].map(match=>normalize(match[1])).filter(name=>name&&!/^(?:一个|一位|一名|新|新的)?(?:学员|学生)$/u.test(name)));
}
const compactCounts = c => Object.fromEntries(['students','venues','lessons','messages','rules','practices','followups'].map(key => [key,(c[key] || []).length]));
const choicesFor = (rows, kind) => rows.map((row,index) => ({id:row.id,label:kind === 'student' ? `${row.name}${rows.filter(item => normalize(item.name) === normalize(row.name)).length > 1 ? `（${index + 1}，最近上课：${row.last || '暂无'}）` : ''}` : `${row.name || row.title || '待处理消息'}${row.address ? ` · ${row.address}` : ''}`}));
const question = (kind, field, prompt, rows) => ({kind,field,question:prompt,choices:choicesFor(rows,kind)});

export function prepareUnderstanding(original, {text = original.text, previous = null} = {}) {
 const input = structuredClone(original), c = input.context;
 input.text = text;
 const current = {selectedStudent:c.selectedStudent,selectedLesson:c.selectedLesson,messageId:c.messageId};
 const exists = (key,id) => typeof id === 'string' && (c[key] || []).some(row => row.id === id);
 const anchor = (field,key) => exists(key,current[field]) ? current[field] : exists(key,previous?.[field]) ? previous[field] : null;
 c.selectedStudent = anchor('selectedStudent','students');
 c.selectedLesson = anchor('selectedLesson','lessons');
 c.messageId = anchor('messageId','messages');
 const selectedVenue = exists('venues',previous?.venueId) ? previous.venueId : null;
 const normalizedText = normalize(text),coach=coachReferences(normalizedText,c.currentCoachName);
 const targets = namedTargets(normalizedText).filter(target=>!coach.mentions.some(mention=>target.start<mention.end&&target.end>mention.start));
 let entityText=normalizedText;for(const span of [...coach.mentions].sort((a,b)=>b.start-a.start))entityText=entityText.slice(0,span.start)+' '.repeat(span.end-span.start)+entityText.slice(span.end);
 let students = nameMatches(entityText,c.students,targets), venues = matchingVenues(normalizedText,c.venues);
 const unknownStudentNames = unique(targets.filter(target => !c.students.some(student => normalize(student.name) === target.name)).map(target => target.name));
 const tasks = tasksIn(normalizedText), before = compactCounts(c);
 const createdStudentNames=newStudentNames(normalizedText);
 const newStudentDependency=createdStudentNames.length===1&&!students.length&&unknownStudentNames.every(name=>name===createdStudentNames[0])&&!c.students.some(student=>normalize(student.name)===createdStudentNames[0]);
 if(createdStudentNames.length&&!tasks.includes('add-student'))tasks.push('add-student');
 const meta = {version:1,tasks,matches:{students:[],venues:[]},unknownStudentNames,studentBookingRequest:null,resolved:{studentId:null,studentBasis:null,historyStudentId:null,historyStudentBasis:null,venueId:null,venueBasis:null,start:null,startBasis:null,sourceLessonId:null},scope:{mode:'authorized-full',before,after:before}};
 const result = clarification => {
  meta.matches = {students:students.map(({id,name}) => ({id,name})),venues:venues.map(({id,name}) => ({id,name}))};
  meta.scope.after = compactCounts(c);
  return {input,clarification,meta};
 };
 const bookingQuestion=tasks.includes('availability-query')||/(?:能否|能不能|可不可以|可以).{0,8}(?:约|上课|练球)/u.test(normalizedText);
 // “只查/只看” also introduces balance and statistics requests. Apply the
 // booking-specific coach/negation guard only when scheduling is mentioned;
 // ordinary reads must keep their existing authorized business context.
 const readOnly=readOnlyAvailability(normalizedText,bookingQuestion||tasks.includes('booking')||tasks.includes('availability'));
 if(c.role==='student'&&(bookingQuestion||tasks.includes('booking')||readOnly)){
  if(affirmativeReference(/发(?:送|个|条)?(?:微信|短信)|(?:通过|用|在)(?:微信|短信)|(?:微信|短信)(?:发|问)/u,normalizedText))return result(question('external-message',null,'本版不支持代发微信或短信，不会发送这条消息。你可以在约练中填写并确认预约申请，或自行联系教练。',[]));
  if(coach.unknown||coach.multiple||coach.mentions.length&&!coach.displayName)return result(question('coach',null,'请先选择你要预约的已关联教练，再重新提出申请；不会自动发送给当前教练。',[]));
  if(readOnly){
   meta.studentBookingRequest={kind:'read-only',coachName:coach.displayName,basis:'explicit-read-only',requiresConfirmation:false};
   if(!tasks.some(task=>!['availability-query','availability','booking'].includes(task)))return result(question('availability-query',null,'这是只查看空档的请求。本版可在日程查看已有安排；不会生成预约申请或修改开放时间。',[]));
  }else if(bookingQuestion){
   if(!coach.displayName||!exists('students',c.selfStudentId))return result(question('coach',null,'请先选择已关联的教练，再为自己提出预约申请。',[]));
   if(!tasks.includes('booking'))tasks.push('booking');
   meta.studentBookingRequest={kind:'booking-request',coachName:coach.displayName,basis:'student-current-coach-question',requiresConfirmation:true};
  }
 }
 if (tasks.includes('availability-query') && !tasks.some(task => task !== 'availability-query' && task !== 'availability')) return result(question('availability-query',null,'这是在询问空闲时段，可以先在日程查看；不会生成预约或修改开放时间。',[]));
 // A same-name candidate selected by a real UI control disambiguates only that
 // name. Merely being the most recent student never disambiguates duplicates.
 for (const name of unique(students.map(student => normalize(student.name)))) {
  const same = students.filter(student => normalize(student.name) === name);
  if (same.length < 2) continue;
  if (same.some(student => student.id === c.selectedStudent)) students = students.filter(student => normalize(student.name) !== name || student.id === c.selectedStudent);
  else return result(question('student','selectedStudent',`有多位学员叫“${same[0].name}”，这次指哪一位？`,same));
 }
 for (const name of unique(venues.map(venue => normalize(venue.name)))) {
  const same = venues.filter(venue => normalize(venue.name) === name);
  if (same.length < 2) continue;
  if (same.some(venue => venue.id === selectedVenue)) venues = venues.filter(venue => normalize(venue.name) !== name || venue.id === selectedVenue);
  else return result(question('venue','venueId',`有多个场地叫“${same[0].name}”，这次使用哪一个？`,same));
 }
 // The same spoken short name may stand for several full venue names. Reuse
 // the shared bounded suffix rules, never invent or permanently store aliases.
 for (const name of unique(venues.flatMap(venue=>venueNames(venue.name)))) {
  const same=venues.filter(venue=>venueNames(venue.name).includes(name));
  if(same.length<2||same.every(venue=>normalizedText.includes(normalize(venue.name))))continue;
  if(same.some(venue=>venue.id===selectedVenue))venues=venues.filter(venue=>!venueNames(venue.name).includes(name)||venue.id===selectedVenue);
  else return result(question('venue','venueId',`“${name}”对应多个场地，这次使用哪一个？`,same));
 }
 const message = c.messages.find(row => row.id === c.messageId);
 const lesson = c.lessons.find(row => row.id === (message?.lesson || c.selectedLesson));
 let source = null;
 if (students.length === 1 && !unknownStudentNames.length) { c.selectedStudent = students[0].id; source = 'explicit-name'; }
 else if (students.length > 1 || unknownStudentNames.length) c.selectedStudent = null;
 else if (message && exists('students',message.student)) { c.selectedStudent = message.student; source = 'selected-message'; }
 else if (lesson && lesson.students.length === 1 && exists('students',lesson.students[0])) { c.selectedStudent = lesson.students[0]; source = 'selected-lesson'; }
 else if (c.selectedStudent) source = current.selectedStudent === c.selectedStudent ? 'selected-student' : 'previous-selection';
 if(newStudentDependency){c.selectedStudent=null;source='new-student-dependency';}
 if (c.role === 'student' && exists('students',c.selfStudentId)) {c.selectedStudent = c.selfStudentId;source = 'authenticated-self';}
 meta.resolved.studentId = c.selectedStudent;
 meta.resolved.studentBasis = source;
 if (groupPronoun.test(normalizedText) && students.length < 2) return result(question('student','selectedStudent','“我俩／他俩”涉及哪些学员？请说明姓名；目前约课草稿需要明确对应的学员。',c.students));
 if (message && students.length && !students.some(student => student.id === message.student) && tasks.includes('message-decision')) {
  const candidates = c.messages.filter(row => row.id === message.id || row.state === 'pending' && students.some(student => student.id === row.student));
  return result(question('message','messageId','你提到的学员与当前消息不一致，请选择要处理的消息。',candidates));
 }
 if (singularPronoun.test(normalizedText) && !c.selectedStudent && !unknownStudentNames.length && !newStudentDependency) {
  const candidates = students.length ? students : lesson?.students.length ? c.students.filter(student => lesson.students.includes(student.id)) : c.students;
  return result(question('student','selectedStudent','这句话中的学员指哪一位？',candidates));
 }
 const useOldVenue=affirmativeReference(oldVenue,normalizedText),useOldTime=affirmativeReference(oldTime,normalizedText);
 if (venues.length === 1) {meta.resolved.venueId=venues[0].id;meta.resolved.venueBasis='explicit-name';}
 else if (!venues.length && selectedVenue && !useOldVenue) {meta.resolved.venueId=selectedVenue;meta.resolved.venueBasis='explicit-choice';}
 if (useOldVenue && !venues.length || useOldTime) {
  // A reviewed candidate may identify only the historical reference in a
  // multi-person request. Do not replace other tasks' explicit participants.
  const historyStudentId=c.selectedStudent || (exists('students',previous?.explicitStudentChoice) ? previous.explicitStudentChoice : null);
  if (!historyStudentId) return result(question('student','selectedStudent','需要先确定哪位学员，才能核对上次课程的场地和时间。',students.length ? students : c.students));
  meta.resolved.historyStudentId=historyStudentId;meta.resolved.historyStudentBasis=c.selectedStudent?source:'explicit-history-choice';
  const done = c.lessons.filter(row => row.students.includes(historyStudentId) && row.state === 'done' && row.date <= c.today && exists('venues',row.venue)).sort((a,b) => b.date.localeCompare(a.date) || b.start - a.start);
  if (!done.length) {
   if (useOldVenue && selectedVenue && !venues.length) {meta.resolved.venueId=selectedVenue;meta.resolved.venueBasis='explicit-choice';}
   if (useOldTime) return result(question('history',null,'没有找到这位学员已完成课程的时间记录，请直接说明这次几点开始。',[]));
   return result(meta.resolved.venueId ? null : question('venue','venueId','没有找到这位学员已完成课程的场地和时间记录，请补充这次的安排。',c.venues));
  }
  const latest = done.filter(row => row.date === done[0].date && row.start === done[0].start), latestVenues = unique(latest.map(row => row.venue));
  if (useOldVenue && !venues.length) {
   if (latestVenues.length !== 1) {
    if (latestVenues.includes(selectedVenue)) {meta.resolved.venueId=selectedVenue;meta.resolved.venueBasis='explicit-choice';}
    else return result(question('venue','venueId','最近一次已完成课程有多个场地记录，请确认这次使用哪个。',c.venues.filter(row => latestVenues.includes(row.id))));
   } else {meta.resolved.venueId=latestVenues[0];meta.resolved.venueBasis='latest-completed-lesson';}
  }
  meta.resolved.sourceLessonId=done[0].id;
  if (useOldTime) {meta.resolved.start=`${String(Math.floor(done[0].start/60)).padStart(2,'0')}:${String(done[0].start%60).padStart(2,'0')}`;meta.resolved.startBasis='latest-completed-lesson';}
 }
 // Keep a union across clauses; a clause we cannot classify prevents narrowing.
 // These hints never force the model to choose one intent or to omit a task.
 const clauses = normalizedText.split(/[。；;\n]|然后|另外|同时|顺便/u).map(value => value.trim()).filter(value => value.length > 2);
 const unknownClause = clauses.some(clause => !tasksIn(clause).length);
 const broad = broadRequest.test(normalizedText) || tasks.includes('summary') || tasks.includes('followup');
 if(newStudentDependency){meta.scope.mode='new-entity-dependencies';return result(null);}
 if (!tasks.length || unknownClause || broad || c.reviewedPlan) return result(null);
 const studentIds = new Set([...students.map(student => student.id),...(c.selectedStudent ? [c.selectedStudent] : [])]);
 const selectedLessons = new Set([c.selectedLesson,message?.lesson,meta.resolved.sourceLessonId].filter(Boolean));
 if (studentIds.size) {
  c.lessons = c.lessons.filter(row => selectedLessons.has(row.id) || row.students.some(id => studentIds.has(id)));
  // Keep every participant of a retained small-group lesson so its identity is
  // never mistaken for a one-to-one lesson by subsequent validation.
  for (const row of c.lessons) for (const id of row.students) studentIds.add(id);
  c.students = c.students.filter(row => studentIds.has(row.id));
  c.messages = c.messages.filter(row => row.id === c.messageId || studentIds.has(row.student));
  c.followups = (c.followups || []).filter(row => studentIds.has(row.student));
  c.followupIds = (c.followupIds || []).filter(id => studentIds.has(id));
  meta.scope.mode = 'related-entities';
 }
 const only = allowed => tasks.every(task => allowed.includes(task));
 if(only(['booking'])&&students.length<=1&&!/(?:然后|另外|同时|顺便|再给|再帮|接着|最后)/u.test(normalizedText)&&venues.length===1&&meta.resolved.venueBasis==='explicit-name'&&!useOldVenue&&!useOldTime){
  const needed=new Set([venues[0].id,...c.lessons.map(lesson=>lesson.venue)]);
  for(const message of c.messages){const linked=original.context.lessons.find(lesson=>lesson.id===message.lesson);if(linked)needed.add(linked.venue);}
  c.venues=c.venues.filter(venue=>needed.has(venue.id));
  c.rules=(c.rules||[]).filter(rule=>needed.has(rule.venue));
  meta.scope.mode='booking-venue-projection';
 }
 // A pure read / purchase / create request does not need historical lesson
 // text. Mixed requests retain the union; selected records always survive.
 if (only(['balance','credit','add-student','add-venue'])) {
  c.lessons=c.lessons.filter(row => selectedLessons.has(row.id));
  c.messages=c.messages.filter(row => row.id === c.messageId);
  c.rules=[];c.practices=[];c.followups=[];c.followupIds=[];
  meta.scope.mode = 'task-projection';
 }
 if (only(['booking','balance','credit','add-student','add-venue'])) c.students = c.students.map(row => ({...row,goal:'',next:'',balance:tasks.includes('balance') ? row.balance : null}));
 return result(null);
}
