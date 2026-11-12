import {context,plan,step} from './dataset.mjs';

// Added after the fixed 150 exposed the name/studentName contract defect.
// These are supplemental regression cases, never retroactively called holdout.
function make(id,text,initial,change){
 const prior=plan(step('edit-student',{studentId:'st-an',studentName:'安安',goal:'上旋',next:'步法\n保留标点  100%',...initial}));
 const exactPlan=structuredClone(prior);Object.assign(exactPlan.steps[0].operation,change);
 return {id,group:'rename-regression',split:'regression',style:'colloquial',source:'original-synthetic',input:{text,context:{...context(),reviewedPlan:JSON.stringify(prior)}},expected:{steps:[{intent:'edit-student'}],exactPlan}};
}
export const cases=[
 make('REN-P01','姓名改成小安，目标和下次重点都别动。',{}, {studentName:'小安'}),
 make('REN-P02','只把目标改成稳定发球，名字和下次重点不动。',{studentName:'小安'}, {goal:'稳定发球'})
];
