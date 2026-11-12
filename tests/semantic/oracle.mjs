import {isDeepStrictEqual} from 'node:util';

// This evaluator never asks a model to grade its own answer. It compares the
// production result against independently authored, fixed expected values.
export function evaluate(testCase, result, error=null) {
 const checks=[],strictChecks=[];
 const check=(path,expected,actual,pass=isDeepStrictEqual(expected,actual))=>checks.push({path,expected,actual,passed:pass});
 if(error){
  check('response.error',testCase.allowRefusal?'REFUSED':null,error.code||error.name,testCase.allowRefusal===true&&error.code==='REFUSED');
  return {passed:checks.every(c=>c.passed),checks};
 }
 const plan=result?.plan, want=testCase.expected;
 if(!plan||!Array.isArray(plan.steps)){check('plan.steps','array',plan?.steps,false);return {passed:false,checks};}
 check('steps.length',want.steps.length,plan.steps.length);
 for(let index=0;index<want.steps.length;index++){
  const expected=want.steps[index],actual=plan.steps[index];
  if(!actual){check(`steps[${index}]`,'present',null,false);continue;}
  for(const [field,value] of Object.entries(expected)){
   if(field==='studentFrom'||field==='venueFrom'){
    const ref=field==='studentFrom'?'studentRef':'venueRef';
    check(`steps[${index}].${ref}`,plan.steps[value]?.id,actual[ref]);
   }else if(field==='dependsOnIndices'){
    for(const n of value)check(`steps[${index}].dependsOn contains ${n}`,true,actual.dependsOn?.includes(plan.steps[n]?.id));
   }else{
    const raw=actual.operation?.[field];let observed=raw;
    // Initial drafts have documented backend defaults. Score their effective
    // business meaning as well as raw shape; never apply defaults to a patch.
    if(!want.exactPlan){
     const op=actual.operation||{},c=testCase.input.context;
     if(field==='publish'&&op.intent==='record'&&raw===null)observed=false;
     if(field==='shared'&&op.intent==='practice'&&raw===null)observed=false;
     if(field==='studentName'&&op.intent==='add-student'&&!raw)observed=op.name;
     if(op.intent==='edit-student'&&['studentName','goal','next'].includes(field)&&raw===null){const student=c.students.find(s=>s.id===op.studentId);observed=student?.[field==='studentName'?'name':field];}
     if(op.intent==='edit-venue'&&['name','address','court'].includes(field)&&raw===null)observed=c.venues.find(v=>v.id===op.venueId)?.[field];
     if(op.intent==='edit-base'&&['days','start','end','travel'].includes(field)&&raw===null)observed=c.settings?.[field];
     if(op.intent==='edit-lesson'&&['duration','note'].includes(field)&&raw===null)observed=c.lessons.find(l=>l.id===op.lessonId)?.[field];
     if(op.intent==='edit-practice'&&['name','shared'].includes(field)&&raw===null){const practice=c.practices.find(p=>p.id===op.practiceId);observed=practice?.[field==='name'?'topic':field];}
    }
    const strictValue=field==='days'&&Array.isArray(raw)?raw.slice().sort():raw;
    const expectedValue=field==='days'&&Array.isArray(value)?value.slice().sort():value;
    strictChecks.push({path:`steps[${index}].operation.${field}`,expected:expectedValue,actual:strictValue,passed:isDeepStrictEqual(expectedValue,strictValue)});
    // Weekday order is not a business distinction, unlike multi-step ordering.
    check(`steps[${index}].operation.${field}`,field==='days'&&Array.isArray(value)?value.slice().sort():value,field==='days'&&Array.isArray(observed)?observed.slice().sort():observed);
   }
  }
 }
 if(want.exactPlan){
  // Display titles may change, but every business field and graph edge must be
  // preserved. This catches a seemingly correct edit that silently rewrites a note.
  for(let index=0;index<want.exactPlan.steps.length;index++){
   const expected=want.exactPlan.steps[index],actual=plan.steps[index];
   if(!actual)continue;
   for(const field of ['id','dependsOn','studentRef','venueRef'])check(`preserve.steps[${index}].${field}`,expected[field],actual[field]);
   for(const [field,value] of Object.entries(expected.operation)){
    if(['title','explanation'].includes(field))continue;
    check(`preserve.steps[${index}].operation.${field}`,value,actual.operation?.[field]);
   }
  }
  if(result.meta?.amendment)check('amendment.status','patched',result.meta.amendment.status);
 }
 // A clarification must contain an actionable explanation, not an empty valid schema.
 for(const [index,s] of plan.steps.entries())if(s.operation?.intent==='clarification')check(`clarification[${index}].question`,true,typeof s.operation.explanation==='string'&&s.operation.explanation.trim().length>=4);
 // Generation is not execution. No output should claim an operation was committed.
 check('noExecutionReceipt',false,Boolean(result.committed||result.results));
 const strictPassed=checks.every(c=>c.passed)&&strictChecks.every(c=>c.passed);
 return {passed:checks.every(c=>c.passed),strictPassed,checks,strictChecks};
}

export function summarize(results){
 const stats=rows=>({total:rows.length,passed:rows.filter(r=>r.status==='passed').length,failed:rows.filter(r=>r.status==='failed').length,strictPassed:rows.filter(r=>r.strictPassed===true).length,errors:rows.filter(r=>r.error).length});
 const by=(key)=>Object.fromEntries([...new Set(results.map(r=>r[key]))].map(v=>[v,stats(results.filter(r=>r[key]===v))]));
 const calls=results.flatMap(r=>r.calls||[]), finite=calls.filter(c=>Number.isFinite(c.usage?.input_tokens)&&Number.isFinite(c.usage?.output_tokens));
 const latencies=results.map(r=>r.durationMs).sort((a,b)=>a-b);
 return {...stats(results),byGroup:by('group'),bySplit:by('split'),byStyle:by('style'),actualModelCalls:calls.length,callsWithUsage:finite.length,
  usage:finite.reduce((sum,c)=>({inputTokens:sum.inputTokens+c.usage.input_tokens,outputTokens:sum.outputTokens+c.usage.output_tokens,totalTokens:sum.totalTokens+(c.usage.total_tokens??c.usage.input_tokens+c.usage.output_tokens)}),{inputTokens:0,outputTokens:0,totalTokens:0}),
  latencyMs:{median:latencies[Math.floor(latencies.length/2)]??null,p95:latencies[Math.min(latencies.length-1,Math.ceil(latencies.length*0.95)-1)]??null},
  deterministicWithoutModel:results.filter(r=>!r.calls?.length&&!r.error).length};
}
