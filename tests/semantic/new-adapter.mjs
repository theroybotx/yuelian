import {scopeInput} from '../../lib/assistant.ts';
import {prepareUnderstanding} from '../../server/src/understanding.mjs';
import {generateResponse,understandingHint} from '../../server/src/generation.mjs';

// The actual production generateResponse is used; no model stub or case-specific
// routing. The only omitted layer is database/session persistence, tested separately.
export async function run(input) {
 const raw=scopeInput(input),base=raw.context.reviewedPlan?JSON.parse(raw.context.reviewedPlan):null;
 delete raw.context.reviewedPlan;
 const prepared=prepareUnderstanding(raw,{text:raw.text,previous:null});
 const scoped=base?raw:prepared.input;
 scoped.context.understanding=understandingHint(prepared.meta);
 return generateResponse({input:scopeInput(scoped),base,clarification:base?null:prepared.clarification,meta:prepared.meta});
}
