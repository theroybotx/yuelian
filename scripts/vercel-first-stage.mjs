import {appendFileSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {repository,releasePolicy,currentRef,checkedDeployment,realTools} from './vercel-release.mjs';

const environment='yuelian-first-stage';
const teamId='team_BT8V0sLlNcPwLzQaoxU9B1g8';
const receiptsPath='/repos/'+repository+'/deployments';

export function checkedCiManifest(built,checked,sha){
 if(built.sourceCommit!==sha||checked.sourceCommit!==sha||!built.files||typeof built.files!=='object'||Array.isArray(built.files)||Object.keys(built.files).length===0||!isDeepStrictEqual(built.files,checked.files))throw Error('Production artifact differs from the same-run checked artifact; upload refused');
}

export async function runFirstStage({env,command,api,smoke}){
 const policy=releasePolicy(env,'production');
 if(env.YUELIAN_FIRST_STAGE_ENABLED!=='true')throw Error('First-stage gate is disabled');
 if(!env.YUELIAN_RELEASE_BRANCH||policy.ref!=='refs/heads/'+env.YUELIAN_RELEASE_BRANCH)throw Error('First stage requires the configured protected release branch');
 if(env.VERCEL_ORG_ID!==teamId)throw Error('Unexpected Vercel team');
 if(!/^[1-9]\d*$/.test(env.GITHUB_RUN_ID||''))throw Error('Missing CI run identity');
 const scope='?teamId='+encodeURIComponent(teamId);
 const projectScope=scope+'&projectId='+encodeURIComponent(env.VERCEL_PROJECT_ID);
 const isolation=async()=>{
  const project=await api('vercel','/v9/projects/'+encodeURIComponent(env.VERCEL_PROJECT_ID)+scope);
  if(project.id!==env.VERCEL_PROJECT_ID||project.accountId!==teamId||project.autoAssignCustomDomains!==false||!project.targets||project.targets.production!=null||project.ssoProtection?.deploymentType!=='all_except_custom_domains'||project.nodeVersion!=='24.x')throw Error('First-stage project isolation or protection is unverified');
  const aliases=await api('vercel','/v4/aliases'+projectScope+'&limit=100');
  if(!Array.isArray(aliases.aliases)||aliases.aliases.length||aliases.pagination?.next!==null)throw Error('Project aliases exist or alias pagination is unknown; reconcile before upload');
 };
 const noIntent=async()=>{
  const records=await api('github',receiptsPath+'?environment='+environment+'&per_page=1');
  if(!Array.isArray(records)||records.length)throw Error('Existing or unknown first-stage receipt; reconcile before retry');
 };
 await currentRef(env,api);
 await noIntent();
 await isolation();
 const listed=await api('vercel','/v6/deployments'+projectScope+'&limit=1');
 if(!Array.isArray(listed.deployments)||listed.deployments.length||listed.pagination?.next!==null)throw Error('Project deployments exist or pagination is unknown; reconcile before upload');
 await command(['pull','--yes','--environment=production']);
 await command(['build-artifact']);
 await command(['verify-artifact']);
 await currentRef(env,api);
 await isolation();
 await noIntent();
 let receiptId;
 try{
  const receipt=await api('github',receiptsPath,{method:'POST',body:{ref:policy.sha,auto_merge:false,required_contexts:[],environment,transient_environment:true,production_environment:false,payload:{version:1,projectId:env.VERCEL_PROJECT_ID,sourceCommit:policy.sha,phase:'uploading',ciRunId:env.GITHUB_RUN_ID}}});
  if(!Number.isSafeInteger(receipt.id)||receipt.id<=0)throw Error('Durable first-stage receipt ID is invalid; reconcile before retry');
  receiptId=receipt.id;
  const output=await command(['deploy','--yes','--prebuilt','--environment=production','--prod','--skip-domain','--meta','sourceCommit='+policy.sha,'--meta','githubCommitSha='+policy.sha,'--meta','githubCommitRef='+env.YUELIAN_RELEASE_BRANCH,'--meta','firstStageReceipt='+receiptId]);
  const urls=output.trim().split(/\s+/).filter(value=>/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(value));
  if(urls.length!==1)throw Error('First-stage upload URL unknown; reconcile before retry');
  const url=urls[0];
  const deployed=checkedDeployment(JSON.parse(await command(['inspect',url,'--wait','--timeout','5m','--json'])),env,'production');
  if(typeof deployed.id!=='string'||!/^dpl_[A-Za-z0-9]+$/.test(deployed.id)||deployed.url!==new URL(url).host||deployed.meta?.githubCommitSha!==policy.sha||deployed.meta?.githubCommitRef!==env.YUELIAN_RELEASE_BRANCH||deployed.meta?.firstStageReceipt!==String(receiptId))throw Error('First-stage deployment receipt binding mismatch');
  await isolation();
  await smoke(url,env);
  await currentRef(env,api);
  await isolation();
  await api('github',receiptsPath+'/'+receiptId+'/statuses',{method:'POST',body:{state:'success',environment_url:url,auto_inactive:false,description:'Isolated stage verified; not promoted'}});
  return {sourceCommit:policy.sha,url,deploymentId:deployed.id,receiptId,target:'production',promoted:false};
 }catch(error){
  if(receiptId){
   try{await api('github',receiptsPath+'/'+receiptId+'/statuses',{method:'POST',body:{state:'failure',auto_inactive:false,description:'First stage failed; reconcile before retry'}});}catch{}
  }
  throw error;
 }
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{
  const env=process.env;
  const tools=realTools(env);
  const command=async args=>{
   const output=await tools.command(args);
   if(args[0]==='verify-artifact')checkedCiManifest(JSON.parse(readFileSync('.vercel/output/build-manifest.json','utf8')),JSON.parse(readFileSync('.ci-output-manifest/build-manifest.json','utf8')),env.GITHUB_SHA);
   return output;
  };
  const result=await runFirstStage({env,...tools,command});
  console.log(JSON.stringify(result));
  if(env.GITHUB_STEP_SUMMARY)appendFileSync(env.GITHUB_STEP_SUMMARY,'\nFirst staged Production: '+result.url+'\n\nSource: `'+result.sourceCommit+'`; deployment: `'+result.deploymentId+'`; receipt: `'+result.receiptId+'`; promoted: false.\n');
 }catch(error){
  let message=String(error?.message||'First staged Production failed');
  for(const value of [process.env.VERCEL_TOKEN,process.env.GH_TOKEN,process.env.VERCEL_AUTOMATION_BYPASS_SECRET].filter(Boolean))message=message.replaceAll(value,'[REDACTED]');
  console.error(message+'. Reconcile native deployment receipts before retry.');
  process.exitCode=1;
 }
}
