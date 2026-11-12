export const dynamic='force-dynamic';
export async function GET(request:Request){
 return new Response(null,{status:302,headers:{Location:new URL('/review/security',request.url).href,'Cache-Control':'private, no-store'}});
}
