import { z } from 'zod';
import type { AssistantInput, OperationDraft, OperationPlan } from './assistant.ts';

// A revision can change values in an existing operation, never its action,
// dependency graph or authorization identity. The server revalidates the merged
// plan against current membership and records before saving or executing it.
export const amendmentFields = [
 'studentId','studentName','venueId','days','travel','shared','date','start','end','duration',
 'from','to','day','gap','goal','next','observation','feedback','publish','text','amount',
 'note','decision','month','name','address','court','indoor',
] as const;
const value = z.union([z.string().max(800),z.number().finite(),z.boolean(),z.array(z.string().max(20)).max(7),z.null()]);
export const Amendment = z.object({
 status:z.enum(['patched','clarification']),explanation:z.string().max(800),question:z.string().max(300).nullable(),
 patches:z.array(z.object({
  stepId:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/),
  changes:z.array(z.object({field:z.enum(amendmentFields),value,evidence:z.string().trim().min(1).max(300)}).strict()).min(1).max(amendmentFields.length),
 }).strict()).max(8),
}).strict();
export type PlanAmendment = z.infer<typeof Amendment>;
export const amendmentOutputSchema = {type:'object',properties:{
 status:{type:'string',enum:['patched','clarification']},explanation:{type:'string'},question:{type:['string','null']},
 patches:{type:'array',items:{type:'object',properties:{
  stepId:{type:'string'},changes:{type:'array',items:{type:'object',properties:{
   field:{type:'string',enum:amendmentFields},
   value:{anyOf:[{type:'string'},{type:'number'},{type:'boolean'},{type:'array',items:{type:'string'}},{type:'null'}]},
   evidence:{type:'string'},
  },required:['field','value','evidence'],additionalProperties:false}},
 },required:['stepId','changes'],additionalProperties:false}},
},required:['status','explanation','question','patches'],additionalProperties:false};

const editable:Record<OperationDraft['intent'],readonly typeof amendmentFields[number][]> = {
 booking:['studentId','studentName','venueId','date','start','duration','note'],
 record:['duration','observation','next','feedback','publish'],
 availability:['from','to','day','start','end','gap','venueId'],
 'add-student':['studentName','name','goal'],
 'edit-student':['studentName','goal','next'],
 credit:['studentId','amount','note'],
 practice:['name','text','shared','date'],
 'message-decision':['decision'],
 balance:['studentId'],summary:['month'],followup:['text'],
 'add-venue':['name','address','court','indoor'],
 'edit-venue':['name','address','court','indoor'],
 'edit-base':['days','start','end','travel'],
 'edit-lesson':['duration','note'],'resolve-message':[],
 'edit-practice':['name','text','shared','date'],clarification:[],
};
export class AmendmentError extends Error {
 code='INVALID_AMENDMENT';status=422;
 constructor(message='这次补充没有明确对应原草稿，原有内容已保留。请说明要修改哪一项、哪个内容。'){super(message);}
}
const normalize=(text:string)=>text.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
function containsName(text:string,name:string){
 const hay=normalize(text),needle=normalize(name);if(!needle)return false;
 if(/^[\p{Script=Latin}\p{Number} _.-]+$/u.test(needle))return new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}($|[^a-z0-9])`,'u').test(hay);
 // A visible short name is not an alias for an unseen longer name. For Chinese
 // names, accept the ordinary clause boundaries around a literal known name;
 // unfamiliar concatenations require an explicit selection instead of guessing.
 for(let from=0,index;(index=hay.indexOf(needle,from))>=0;from=index+needle.length){
  const before=hay.slice(0,index),after=hay.slice(index+needle.length);
  const left=!/[\p{Script=Han}\p{Script=Latin}\p{Number}]$/u.test(before)||/(?:给|替|为|帮|换|换成|改为|改到|换到|成|到|是|选|用|和|与|及|在|去|于|明天|今天|后天|周[一二三四五六日天]|星期[一二三四五六日天]|上午|下午|晚上|早上|中午|\d{1,2}[:：]\d{2}|[一二三四五六七八九十\d]点半?)$/u.test(before);
  const right=!/^[\p{Script=Han}\p{Script=Latin}\p{Number}]/u.test(after)||/^(?:的|约|排|明天|今天|后天|下周|这周|周[一二三四五六日天]|早上|上午|下午|晚上|中午|\d{1,2}[:：]\d{2}|[一二三四五六七八九十\d]{1,3}点|练|上课|登记|查|在|去|吧|啊|呀|呢|了|就|即可|其他|其它|不变|不用|别)/u.test(after);
  if(left&&right)return true;
 }
 return false;
}
function explicitSteps(text:string,plan:OperationPlan){
 const chinese:Record<string,number>={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8};
 const result=new Set<string>();
 for(const match of text.matchAll(/第\s*([1-8一二两三四五六七八])\s*(?:项|步|条)/g)){
  const index=(chinese[match[1]]||Number(match[1]))-1;
  if(!plan.steps[index])throw new AmendmentError('原草稿没有这一步。请按当前清单说明要修改哪一项。');
  result.add(plan.steps[index].id);
 }
 return result;
}
function historicalVenue(next:string,evidence:string,step:OperationPlan['steps'][number],input:AssistantInput){
 if(!/(?:老地方|老场地|原来(?:那儿|那里|的地方)|上次(?:那儿|那里|的场地))/.test(evidence)||step.studentRef)return false;
 let understanding:{resolved?:{studentId?:string|null;venueId?:string|null;venueBasis?:string|null;sourceLessonId?:string|null}|null}|null;try{understanding=JSON.parse(input.context.understanding||'');}catch{return false;}
 const resolved=understanding?.resolved,studentId=step.operation.studentId||input.context.selfStudentId;
 if(!studentId||resolved?.studentId!==studentId||resolved?.venueId!==next||resolved?.venueBasis!=='latest-completed-lesson')return false;
 const completed=input.context.lessons.filter(row=>row.state==='done'&&row.date<=input.context.today&&row.students.includes(studentId)).sort((a,b)=>b.date.localeCompare(a.date)||b.start-a.start);
 const latest=completed[0];if(!latest)return false;
 const tied=completed.filter(row=>row.date===latest.date&&row.start===latest.start);
 return tied.some(row=>row.id===resolved.sourceLessonId)&&tied.every(row=>row.venue===next);
}
export function venueNames(name:string){
 const full=normalize(name),undecorated=full.replace(/^示例\s*·\s*/u,'').trim();
 // The seeded display prefix is not part of the venue's name. Preserve the
 // stored label and strip only this explicit decoration, never arbitrary words.
 return [...new Set([full,...(undecorated&&undecorated!==full?[undecorated]:[])].flatMap(label=>{
  const short=label.replace(/(?:网球训练中心|网球俱乐部|网球中心|网球场|网球馆)$/u,'').trim();
  return short!==label&&[...short].length>=2?[label,short]:[label];
 }))];
}
export function matchingVenues<T extends {name:string}>(text:string,rows:readonly T[]):T[]{
 return rows.filter(row=>venueNames(row.name).some(name=>containsName(text,name)));
}
function explicitVenueClear(text:string,evidence:string){
 // Missing/ambiguous place descriptions alone do not authorize erasing an
 // existing choice. Require an unconditional, explicit clear instruction.
 return !/(?:如果|假如|要是|只要|除非|等到)/u.test(text)&&/(?:清空|清除|取消|去掉|移除|删除)(?:已选的?|原来的?|这个|此)?(?:场地|球场)(?:选择|选项)?/u.test(evidence);
}
function explicitBookingNoteReplacement(text:string){
 // Detect only an unconditional field replacement, not its value. The model
 // still resolves free text and ambiguity; omission cannot look like success.
 if(/(?:如果|假如|要是|只要|除非|等到)/u.test(text))return false;
 return text.split(/[，,。；;\n]/u).some(clause=>!/(?:不要|不用|不必|无需|别|暂不)/u.test(clause)&&/(?:备注|训练内容|练习内容)\s*(?:改成|改为|修改为|调整为|换成|设为|填成|补充为|写成)\s*\S/u.test(clause));
}
const clock=(minutes:number)=>`${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
function providerClock(value:number,evidence:string){
 // Some model patches copy the integer-minute representation from lesson
 // context. Accept it only when an explicit clock in its evidence agrees;
 // 19 with “19点” must never silently become 00:19.
 if(!Number.isInteger(value)||value<0||value>=1440)throw new AmendmentError();
 const times=[...evidence.matchAll(/(?<![\d:：])(?:(下午|晚上|傍晚|今晚|明晚|上午|早上|凌晨))?(\d{1,2})(?:[:：](\d{2})|点(?:(\d{1,2})分?)?)(?![\d零一二两三四五六七八九十百半秒:：])/gu)].map(match=>{
  let hour=Number(match[2]);const minute=Number(match[3]||match[4]||0);
  if(hour>23||minute>59)return null;
  if(match[1]&&/下午|晚上|傍晚|今晚|明晚/u.test(match[1])&&hour>=1&&hour<=11)hour+=12;
  return hour*60+minute;
 });
 if(times.length!==1||times[0]!==value)throw new AmendmentError('开始或结束时间的数值与原文不一致，原草稿已保留。请明确填写几点几分。');
 return clock(value);
}
function relativeBookingStarts(text:string,base:OperationPlan){
 const starts=new Map<string,{start:string,evidence:string}>();
 for(const clause of text.split(/[，,。；;\n]/u).map(part=>part.trim()).filter(Boolean)){
  const strip=(value:string)=>value.replace(/^(?:(?:请|帮我|麻烦|只|仅|再|把|将)\s*)+/u,'');
  const phrase=strip(strip(clause).replace(/^第\s*[1-8一二两三四五六七八]\s*(?:项|步|条)\s*/u,''));
  const match=phrase.match(/^(?:(?:开始|上课|开课)时间)?(往后|向后|往前|向前|提前|推后|延后)(?:挪|推|移|调整)?\s*(半小时|(\d{1,3})\s*分钟)(?:吧|即可)?$/u);
  if(!match)continue;
  if(/(?:如果|假如|要是|只要|除非|等到)/u.test(text))throw new AmendmentError('调整时间的条件尚未确定，原草稿已保留。');
  const addressed=explicitSteps(clause,base),targets=base.steps.filter(step=>step.operation.intent==='booking'&&(!addressed.size||addressed.has(step.id)));
  if(targets.length!==1||!targets[0].operation.start)throw new AmendmentError('请明确要调整哪一节课和原开始时间；原草稿已保留。');
  const target=targets[0],amount=match[2]==='半小时'?30:Number(match[3]);
  if(!amount||starts.has(target.id))throw new AmendmentError();
  const [hour,minute]=target.operation.start!.split(':').map(Number),next=hour*60+minute+(/往前|向前|提前/u.test(match[1])?-amount:amount);
  if(next<0||next>=1440)throw new AmendmentError('这次调整会跨日，请明确日期和开始时间；原草稿已保留。');
  starts.set(target.id,{start:clock(next),evidence:match[0].replace(/^(?:开始|上课|开课)时间/u,'')});
 }
 return starts;
}

export function mergeAmendment(raw:unknown,basePlan:OperationPlan,input:AssistantInput){
 const parsed=Amendment.safeParse(raw);if(!parsed.success)throw new AmendmentError();
 const amendment=parsed.data,plan=structuredClone(basePlan),changedFields:Array<{stepId:string,fields:string[]}>=[];
 if(amendment.status==='clarification'){
  if(amendment.patches.length||!amendment.question?.trim())throw new AmendmentError();
  return {plan,amendment:{status:'clarification' as const,question:amendment.question,explanation:amendment.explanation,changedFields}};
 }
 if(amendment.question!==null||!amendment.patches.length)throw new AmendmentError();
 const addressed=explicitSteps(input.text,basePlan),seen=new Set<string>(),relativeStarts=relativeBookingStarts(input.text,basePlan);
 for(const patch of amendment.patches){
  const step=plan.steps.find(s=>s.id===patch.stepId);
  if(!step||seen.has(patch.stepId)||addressed.size&&!addressed.has(patch.stepId))throw new AmendmentError();
  seen.add(patch.stepId);const fields=new Set<string>();
  for(const change of patch.changes){
   const {field,evidence}=change;let next=change.value;
   if(fields.has(field)||!editable[step.operation.intent].includes(field)||!input.text.includes(evidence))throw new AmendmentError();
   fields.add(field);
   if(field==='start'&&relativeStarts.size){
    const relative=relativeStarts.get(step.id);
    if(!relative||!evidence.includes(relative.evidence))throw new AmendmentError();
    next=relative.start;
   }else if((field==='start'||field==='end')&&typeof next==='number')next=providerClock(next,evidence);
   if(field==='studentId'||field==='venueId'){
    if(field==='studentId'&&step.studentRef||field==='venueId'&&step.venueRef)throw new AmendmentError('这一步引用了前面的新增资料，不能单独替换关联。请在原步骤修改资料，或重新整理任务。');
    // A replacement is accepted only for a uniquely named, currently visible
    // entity. Blank IDs and unrecognized/repeated names cannot silently rebind it.
    if(next===null&&field==='venueId'&&explicitVenueClear(input.text,evidence)){
     step.operation.venueId=null;continue;
    }
    if(typeof next!=='string')throw new AmendmentError();
    const rows=field==='studentId'?input.context.students:input.context.venues;
    const candidates=rows as Array<(typeof rows)[number]>;
    const fullMatches=field==='venueId'?new Set(matchingVenues(input.text,candidates).map(row=>row.id)):null;
    const matches=field==='venueId'?matchingVenues(evidence,candidates).filter(row=>fullMatches!.has(row.id)):candidates.filter(row=>containsName(evidence,row.name)&&containsName(input.text,row.name));
    const self=field==='studentId'&&input.context.role==='student'&&next===input.context.selfStudentId&&/我|本人|自己/.test(evidence);
    const historical=field==='venueId'&&historicalVenue(next,evidence,step,input);
    if(!self&&!historical&&(matches.length!==1||matches[0].id!==next))throw new AmendmentError('请明确选择要使用的学员或场地；原有对象没有变更。');
    if(!rows.some(row=>row.id===next))throw new AmendmentError();
   }
   // Assignment touches only the explicit field. It cannot normalize, rephrase
   // or rebuild any untouched text, array, null, false or zero in the base plan.
   (step.operation as Record<string,unknown>)[field]=structuredClone(next);
  }
  changedFields.push({stepId:step.id,fields:[...fields]});
 }
 for(const [stepId] of relativeStarts)if(!changedFields.some(change=>change.stepId===stepId&&change.fields.includes('start')))throw new AmendmentError('本次修订遗漏了开始时间调整，原草稿已保留。');
 if(relativeStarts.size)amendment.explanation=[...relativeStarts].map(([id,{start}])=>`第${basePlan.steps.findIndex(step=>step.id===id)+1}项开始时间调整为 ${start}`).join('；')+'。请核对各项变更后确认。';
 if(explicitBookingNoteReplacement(input.text)){
  const targets=basePlan.steps.filter(step=>step.operation.intent==='booking'&&(!addressed.size||addressed.has(step.id)));
  if(targets.length===1){
   const target=targets[0],previous=target.operation.note,next=plan.steps.find(step=>step.id===target.id)!.operation.note;
   const repeatsPrevious=typeof previous==='string'&&previous.length>0&&input.text.includes(previous);
   if(!changedFields.some(change=>change.stepId===target.id&&change.fields.includes('note'))||next===previous&&!repeatsPrevious)
    throw new AmendmentError('本次修订遗漏了你要求修改的训练内容，原草稿已保留。请重试，或直接修改课程备注。');
  }
 }
 return {plan,amendment:{status:'patched' as const,question:null,explanation:amendment.explanation,changedFields}};
}
