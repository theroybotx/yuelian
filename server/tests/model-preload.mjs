import {readFileSync,appendFileSync} from 'node:fs';
const realFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
 if(String(url)!=='https://api.deepseek.com/responses')return realFetch(url,options);
 const control=JSON.parse(readFileSync(process.env.ACCEPTANCE_CONTROL,'utf8'));
 const input=JSON.parse(options.body);
 appendFileSync(process.env.ACCEPTANCE_MODEL_LOG,JSON.stringify({at:new Date().toISOString(),input:JSON.parse(input.input),mode:control.live?'live':'stub'})+'\n');
 if(control.live){const start=Date.now();const response=await realFetch(url,options);const info={status:response.status,milliseconds:Date.now()-start};if(process.env.YUELIAN_CAPTURE_MODEL==='true'&&response.status===200){const body=await response.clone().json();info.providerStatus=body.status;info.incompleteDetails=body.incomplete_details;info.usage=body.usage;info.bodyMilliseconds=Date.now()-start;info.output=body.output?.filter(x=>x.type==='message').flatMap(x=>x.content?.filter(c=>c.type==='output_text').map(c=>c.text)||[]);}appendFileSync(process.env.ACCEPTANCE_MODEL_LOG,JSON.stringify({liveResponse:info})+'\n');return response;}
 if(control.delay)await new Promise(r=>setTimeout(r,control.delay));
 if(control.throw)throw Error('synthetic network timeout');
 if(control.raw!==undefined)return new Response(control.raw,{status:control.status||200});
 if(control.status)return new Response('synthetic upstream private detail',{status:control.status});
 if(control.refusal)return Response.json({status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'synthetic refusal'}]}]});
 return Response.json({status:control.incomplete?'incomplete':'completed',model:'acceptance-stub',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(control.plan)}]}]});
};
