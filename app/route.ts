import html from "../frontend/index.html?raw";
import {getChatGPTUser} from './chatgpt-auth';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 const user=await getChatGPTUser();
 if(!user)return Response.redirect(new URL('/login',request.url));
 return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'}});
}
