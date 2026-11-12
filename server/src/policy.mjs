import {z} from 'zod';
export class HttpError extends Error { constructor(status,message='无法访问或处理该资料。',code='UNAVAILABLE'){super(message);this.status=status;this.code=code;} }
export const uuid=z.string().uuid();
const short=z.string().trim().max(300),name=z.string().trim().min(1).max(80);
export const capabilities=['students.read','students.write','contacts.read','contacts.write','notes.read','notes.write','ledger.read','ledger.write','feedback.read','feedback.write','practice.read','schedule.read','schedule.write','venues.read','venues.write'];
export const permissions=z.array(z.enum(capabilities)).max(capabilities.length).refine(v=>new Set(v).size===v.length,'权限不能重复').refine(v=>v.every(p=>!p.endsWith('.write')||v.includes(p.replace('.write','.read'))),'写权限需要对应读权限');
export const staffDefaults=['students.read','schedule.read','schedule.write','venues.read'];
export const schemas={
 student:z.object({name:z.string().trim().min(1).max(20),goal:short.default(''),next:short.default('')}).strict(),
 contact:z.object({phone:z.string().max(32),email:z.string().email().max(254).or(z.literal('')).default('')}).strict(),
 'coach-note':z.object({text:z.string().min(1).max(800)}).strict(),
 venue:z.object({name,address:short,court:short,indoor:z.boolean()}).strict(),
 availability:z.object({from:z.string().date(),to:z.string().date(),day:z.enum(['一','二','三','四','五','六','日']),start:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),end:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),gap:z.number().int().min(0).max(120)}).strict(),
 lesson:z.object({date:z.string().date(),start:z.number().int().min(0).max(1439),duration:z.number().int().min(15).max(240),state:z.enum(['pending','pending_student','confirmed','done','cancelled']),topic:short}).strict(),
 participant:z.object({}).strict(),
 ledger:z.object({delta:z.number().min(-500).max(500).refine(n=>n!==0&&n*4===Math.trunc(n*4)),label:short}).strict(),
 feedback:z.object({text:z.string().max(800)}).strict(),
 practice:z.object({topic:name,text:z.string().max(800),date:z.string().date()}).strict(),
 message:z.object({kind:z.enum(['booking','proposal','status','feedback']),state:z.enum(['pending','accepted','declined','done']),title:name,text:z.string().max(800)}).strict(),
 settings:z.object({days:z.array(z.enum(['一','二','三','四','五','六','日'])).max(7),start:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),end:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),travel:z.number().int().min(0).max(180)}).strict(),
 followup:z.object({text:z.string().min(1).max(600),date:z.string().date()}).strict(),
};
export const resourceInput=z.object({kind:z.enum(Object.keys(schemas)),studentId:uuid.nullable().default(null),lessonId:uuid.nullable().default(null),venueId:uuid.nullable().default(null),visibility:z.enum(['private','shared']).default('private'),payload:z.record(z.unknown())}).strict();
const reads={student:'students.read',contact:'contacts.read','coach-note':'notes.read',ledger:'ledger.read',feedback:'feedback.read',practice:'practice.read',venue:'venues.read',availability:'schedule.read',lesson:'schedule.read',participant:'schedule.read',message:'schedule.read'};
export function can(member,permission){return !!member?.active&&(member.role==='owner'||member.role==='admin'||member.role==='assistant'&&member.permissions.includes(permission));}
export function requirePermission(member,permission){if(!can(member,permission))throw new HttpError(403);}
export function requireAction(member,intent){
 if(!member?.active)throw new HttpError(403);
 const student=['booking','practice','edit-practice','balance','summary','message-decision','resolve-message'];
 if(member.role==='student'){if(!student.includes(intent))throw new HttpError(403);return;}
 const needed={booking:'schedule.write',record:'ledger.write',availability:'schedule.write','add-student':'students.write','edit-student':'students.write',credit:'ledger.write',balance:'ledger.read',summary:'schedule.read','message-decision':'schedule.write','resolve-message':'schedule.write','add-venue':'venues.write','edit-venue':'venues.write','edit-base':'schedule.write','edit-lesson':'schedule.write',followup:'students.write'}[intent];
 if(!needed)throw new HttpError(400,'该操作尚未接入权限后台，请使用已支持的操作。','UNSUPPORTED_ACTION');
 requirePermission(member,needed);
 if(intent==='record'){requirePermission(member,'schedule.write');requirePermission(member,'notes.write');requirePermission(member,'feedback.write');requirePermission(member,'students.write');}
 if(intent==='followup'){requirePermission(member,'ledger.read');requirePermission(member,'schedule.read');}
}
export function validateResource(member,input){
 const r=resourceInput.parse(input);r.payload=schemas[r.kind].parse(r.payload);
 if(member.role==='student'){
  if(r.kind!=='practice'||r.studentId!==member.student_id)throw new HttpError(403);
 }else{
  if(['lesson','participant','ledger','message'].includes(r.kind))throw new HttpError(400,'请通过操作草稿提交课程、预约和课时变更。','USE_PLAN');
  requirePermission(member,reads[r.kind].replace('.read','.write'));
 }
 if(['contact','coach-note','student'].includes(r.kind)&&r.visibility!=='private')throw new HttpError(400,'该资料不能设置为共享。','PRIVATE_REQUIRED');
 if(r.kind==='availability'&&(r.payload.from>r.payload.to||r.payload.start>=r.payload.end||!r.venueId))throw new HttpError(400,'请检查开放时间与场地。','INVALID_SCHEDULE');
 return r;
}
export function projection(r){
 // Unknown stored fields are stripped again on output. No raw database objects,
 // owner identifiers or invitation hashes are returned to the browser/model.
 const payload=schemas[r.kind].parse(r.payload);
 return {id:r.id,kind:r.kind,studentId:r.student_id,lessonId:r.lesson_id,venueId:r.venue_id,visibility:r.visibility,revision:r.revision,createdAt:r.created_at,updatedAt:r.updated_at,payload};
}
