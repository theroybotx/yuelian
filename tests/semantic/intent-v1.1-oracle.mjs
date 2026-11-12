import {evaluate} from './oracle.mjs';

// Additional intent-v1.1 semantics. The original 150-case oracle is unchanged.
export function evaluateIntent(testCase,response,error=null){
 const verdict=evaluate(testCase,response,error);
 if(error||!response?.plan?.steps)return verdict;
 const checks=[...verdict.checks];
 const check=(path,expected,actual,passed)=>checks.push({path,expected,actual,passed});
 const explanations=[response.plan.explanation,...response.plan.steps.map(s=>s.operation.explanation)].filter(Boolean).join('\n');
 if(testCase.clarificationTopics)check('clarification.topic',testCase.clarificationTopics,explanations,testCase.clarificationTopics.some(s=>explanations.includes(s)));
 if(testCase.forbidInventedSlots)check('readOnly.noInventedSlots','No invented HH:MM slots',explanations,!/\d{1,2}[:：]\d{2}/u.test(explanations));
 if(testCase.forbidUnrequestedEnd){
  const expected=testCase.expected.steps[0],actual=response.plan.steps[0]?.operation;
  if(expected.start===null||expected.duration===null)check('booking.unknownEnd',null,actual?.end,actual?.end===null);
  else{
   const [h,m]=expected.start.split(':').map(Number),minutes=h*60+m+expected.duration;
   const derived=String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');
   check('booking.endConsistency',[null,derived],actual?.end,actual?.end===null||actual?.end===derived);
  }
 }
 check('draft.noClaimOfSubmission','No claimed completed booking',explanations,!/(?:已经|已成功|已)(?:为你)?(?:提交|发送|确认).{0,8}(?:预约|约课)/u.test(explanations));
 return {...verdict,checks,passed:checks.every(c=>c.passed),strictPassed:verdict.strictPassed===true&&checks.every(c=>c.passed)};
}
