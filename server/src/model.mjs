import {DEFAULT_RUNTIME} from '../shared/assistant.ts';
import {HttpError} from './policy.mjs';

// Provider selection belongs to the server, never to a browser/model payload.
// Keeping two explicit endpoints prevents a retained cloud key reaching Strata.
/** @param {Record<string, string | undefined>} env */
export function modelSettings(env=process.env){
 const provider=env.YUELIAN_MODEL_PROVIDER||'deepseek';
 if(provider==='deepseek')return {key:env.DEEPSEEK_API_KEY||'',configured:!!env.DEEPSEEK_API_KEY,runtime:DEFAULT_RUNTIME};
 if(provider!=='strata')throw new Error('Unknown YUELIAN_MODEL_PROVIDER');
 return {key:'',configured:true,runtime:{endpoint:'http://127.0.0.1:8080/v1/responses',temperature:0,config:{provider:'strata',model:'qwen3.8-flash-next-unsloth-ud-q4_k_xl',modelLabel:'千问 3.8 Flash Next · 本地 Q4',reasoning:'medium',effectiveReasoning:'medium',fastSupported:false}}};
}
export function requireModel(){
 const settings=modelSettings();
 if(!settings.configured)throw new HttpError(503,'模型尚未配置。','MODEL_NOT_CONFIGURED');
 return settings;
}

// One guard per Node process. This is not a shared-engine/global quota.
export function createModelRunner(){
 let localModelBusy=false;
 return async function runModel(snapshot,usage,generate){
  let acquired=false;
  try{
   const local=modelSettings().runtime.config.provider==='strata'&&!snapshot.clarification;
   if(local&&localModelBusy)throw new HttpError(429,'模型正在整理其他请求，请稍后重试。','MODEL_BUSY');
   if(local){localModelBusy=true;acquired=true;}
   return await generate(snapshot);
  }finally{usage.busy=false;if(acquired)localModelBusy=false;}
 };
}
