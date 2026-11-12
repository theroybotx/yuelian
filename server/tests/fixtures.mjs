// Keep the historical import usable without maintaining an authentication
// bypass or a second copy of the database fixture.
process.env.YUELIAN_TEST_DATABASE ||= 'yuelian_acceptance_recovery';
process.env.YUELIAN_TEST_PORT ||= '18901';
process.env.YUELIAN_TEST_OUTPUT ||= process.cwd()+'/output/recovery-tests';
process.env.YUELIAN_TEST_SUITE ||= 'recovery';
const fixture = await import('../../tests/full/base.mjs');
export const {ROOT,OUT,db,port,secret,provision,pool,transaction,assertRuntimeRole,
 modelContext,op,plan,control,sha,identity,account,date,addDate,signed,request,ok,
 denied,wpath,snapshot,draft,commit,generate,rec,seed,test,results,dbSnapshot,
 countModel,child,logs,stop} = fixture;
