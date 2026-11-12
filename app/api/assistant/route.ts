// Legacy browser-context AI endpoint is closed. All model requests now use the
// authenticated workspace backend, which builds context from RLS-authorized rows.
export const dynamic='force-dynamic';
const retired=()=>Response.json({code:'WORKSPACE_REQUIRED',error:'请刷新约练页面，使用页面底部的 AI 入口。'},{status:410,headers:{'Cache-Control':'private, no-store'}});
export const GET=retired;
export const POST=retired;
