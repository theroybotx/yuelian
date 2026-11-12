import {writeFileSync} from 'node:fs';
import {cases,assertDataset} from './dataset.mjs';
const d=assertDataset(),escape=value=>String(value).replaceAll('|','\\|').replaceAll('\n','<br>');
const rows=cases.map(c=>{
 const ctx=c.input.context,anchors=[ctx.role==='student'?'学员本人':'教练',ctx.selectedStudent&&`已选学员 ${ctx.selectedStudent}`,ctx.selectedLesson&&`已选课程 ${ctx.selectedLesson}`,ctx.messageId&&`已选消息 ${ctx.messageId}`,c.expected.exactPlan&&`${c.expected.exactPlan.steps.length} 项已有草稿`].filter(Boolean).join('；');
 const expected=c.expected.exactPlan?`只修改 ${c.expected.patch.changes.map(([i,fields])=>`第${i+1}项 ${JSON.stringify(fields)}`).join('；')}；其余业务字段、自由文本、顺序和引用逐字段不变。`:c.expected.steps.map((s,i)=>`${i+1}. ${JSON.stringify(s)}`).join('；');
 return `| ${c.id} | ${c.split==='dev'?'开发':'保留'} | ${c.style==='colloquial'?'口语':'明确业务'} | ${escape(anchors)} | ${escape(c.input.text)} | ${escape(expected)} |`;
});
writeFileSync(new URL('./CASES.md',import.meta.url),`# AI 理解层固定验收用例明细\n\n由 dataset.mjs 生成。共 ${d.total} 条：开发 ${d.dev}、保留 ${d.holdout}；显式口语 ${d.colloquial} 条。所有人物和业务资料均为原创虚构。固定“今天”为 2026-11-01，中国时区；不是实际当前业务数据库。\n\nID 映射：st-lin=小林，st-yu=小宇，st-an=安安，v-river=滨江网球场，v-hill=青山网球场。课程与消息的具体日期、状态、所属学员见 dataset.mjs。保留集答案只供离线评测，不能进入生产提示。\n\n本表列出需要检查的结果，不代表已经通过；执行结论以对应报告为准。clarification 表示须澄清或说明暂不支持，不表示那个业务功能已经实现。初始草稿可按后台已存在的安全默认作业务等价评分，同时保留严格字段分数；局部修订仍严格检查未修改字段。\n\n| ID | 分组 | 表达 | 身份与前置状态 | 用户输入 | 独立期望 |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n`);
console.log('Rendered 150 independent acceptance cases.');
