import {context,studentContext} from './dataset.mjs';

// Original synthetic cases added after the user's 2026-11-01 intent correction.
// This is a versioned regression supplement, not the original fixed holdout.
export const VERSION='yuelian-intent-v1.1-2026-11-01';
export const CURRENT_COACH_NAME='示例 · 周教练';
const activeStudent=(extra={})=>studentContext({currentCoachName:CURRENT_COACH_NAME,...extra});
const rows=[];
function add(n,group,text,expected,extra={}){
 rows.push({id:'INTENT-'+String(n).padStart(2,'0'),group,split:'regression-v1.1',style:'colloquial',source:'original-synthetic',input:{text,context:extra.context||activeStudent()},expected:{steps:[expected]},meaning:extra.meaning||'',...(group==='read-only-query'?{clarificationTopics:['查询','日程','时间','时段','开放'],forbidInventedSlots:true}:{}),...(group==='coach-target-boundary'?{clarificationTopics:['教练','对象','选择']}:{}),...(group==='context-boundary'?{clarificationTopics:['教练','学员','谁','对象','选择']}:{}),...(expected.intent==='booking'?{forbidUnrequestedEnd:true}:{})});
}
const booking=(fields={})=>({intent:'booking',studentId:'st-lin',date:'2026-11-02',start:null,duration:null,venueId:null,...fields});
const clarify={intent:'clarification'};
add(1,'booking-inquiry','明晚有空吗？',booking(),{meaning:'当前关联教练已明确，进入待确认预约补全，不伪造开始时间。'});
add(2,'booking-inquiry','明天下午方便上课吗？',booking());
add(3,'delegated-booking','帮我问周教练明晚能不能约课。',booking());
add(4,'delegated-booking','帮我问周教练明晚七点到八点能否在滨江上课。',booking({start:'19:00',duration:60,venueId:'v-river'}));
add(5,'delegated-booking','问一下周教练周三晚上八点能不能练一小时。',booking({date:'2026-11-04',start:'20:00',duration:60}));
add(6,'booking-inquiry','周教练，我明晚19:30想在青山练半小时，可以吗？',booking({start:'19:30',duration:30,venueId:'v-hill'}));
add(7,'missing-fields','明晚能练吗？',booking(),{context:activeStudent({selectedLesson:'l-today'}),meaning:'不能从选中旧课借用09:00、60分钟和旧场地。'});
add(8,'missing-fields','帮我问周教练能约一节课吗？',booking({date:null}),{meaning:'一节不等于明确60分钟；日期也未提供。'});
add(9,'booking-inquiry','我想明晚练正手，有空吗？',booking());
add(10,'delegated-booking','帮我问一下当前教练明晚可不可以上课。',booking());
add(11,'read-only-query','查一下明晚有哪些可约时间。',clarify,{meaning:'当前17类动作没有空闲查询；诚实说明限制，不生成预约或声称查出时段。'});
add(12,'read-only-query','明天能打不？先看看，别给我约。',clarify,{meaning:'明确只看及否定约课优先于问句触发。'});
add(13,'read-only-query','只查周教练明晚的开放时间，不发预约。',clarify);
add(14,'read-only-query','明晚有空吗？先别约，我只是想看看时间。',clarify);
add(15,'read-only-query','把周教练明晚的空档列出来。',clarify);
add(16,'coach-target-boundary','帮我问林教练明晚能不能约课。',clarify,{meaning:'页面当前为周教练，不能自动错投当前教练或跨教练切换。'});
add(17,'coach-target-boundary','帮我问某某教练明晚能否约课。',clarify,{meaning:'某某是占位，须先选定目标教练。'});
add(18,'coach-target-boundary','帮我问别的教练明晚有没有课。',clarify);
add(19,'coach-target-boundary','找其他教练约明晚七点，不用切页面。',clarify);
add(20,'context-boundary','明晚有空吗？',clarify,{context:context({currentCoachName:CURRENT_COACH_NAME}),meaning:'教练端没有明确对方学员；不能凭名单猜一个人。'});
add(21,'context-boundary','明晚有空吗？',clarify,{context:studentContext(),meaning:'旧上下文未提供当前教练，须先确认目标，不能声称已选中周教练。'});
add(22,'unsupported-boundary','今晚找个人随便拉拉，不是报教练课。',clarify);
add(23,'unsupported-boundary','我俩一起上，给我和小宇约明晚七点。',clarify,{meaning:'意图更积极不扩大为已支持双人课，不拆成两条单人预约。'});
add(24,'negation-boundary','朋友问我“明晚有空吗”，这只是转述，不要给我约课。',clarify);
// A coach's isolated inquiry may safely ask who or explain that availability
// lookup is not implemented. Neither interpretation authorizes a new booking.
rows.find(c=>c.id==='INTENT-20').clarificationTopics=['教练','学员','谁','对象','选择','查询','日程','时间','时段'];
export const cases=rows;
export function assertIntentDataset(){
 if(cases.length!==24||new Set(cases.map(c=>c.id)).size!==24)throw Error('Intent v1.1 must contain 24 unique cases');
 for(const c of cases)if(c.source!=='original-synthetic'||c.expected.steps.length!==1||!c.input.text)throw Error('Incomplete case '+c.id);
 return {version:VERSION,total:24,bookingDrafts:10,readOnlyClarifications:5,coachBoundaries:4,otherBoundaries:5,notOriginalHoldout:true};
}
