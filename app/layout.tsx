import type { Metadata } from 'next';
export const metadata:Metadata={title:'约练 · 教练工作台',description:'自然语言与直接操作并行的网球教练工作台。',icons:{icon:'/mark.svg'}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>;}
