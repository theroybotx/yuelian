约练 · 独立账号与全量验收

独立试用：https://yuelian-trial.theroybotx.workers.dev
私有预览：https://yuelian-assistant-prototype.itsroyx.chatgpt.site
项目：appgprj_6ae5d29d3b48819187e44e1d854d9801
更新：2026-11-02。Roy 另行授权个人 Cloudflare 封闭试用；原 Sites 私有预览继续保留。
独立入口及部署维护：docs/cloudflare-trial.txt。实际发布版本与公网验收以本轮交付报告为准。

账号与关联
约练使用 PostgreSQL 内的独立用户名/密码账号。密码用随机盐 scrypt 验证；浏览器使用
Secure、HttpOnly、SameSite=Lax 的 __Host-yuelian_session，服务端只保存会话 token 的哈希。
Sites/ChatGPT 仅作为当前私有预览站的外层访问门禁。头像中的“退出约练”只撤销业务会话，
不会退出 GPT。个人菜单只保留个人中心与退出；学员没有执教、学员管理或团队管理入口。
本轮关闭公开注册，由管理员创建用户名/密码账号；教练账号自动建立教学资料，
学员通过指定已有约练用户名的24小时邀请关联既有档案。
邀请不会自动发送邮件或微信；已关联档案不能改绑另一账号。成员权限由服务端决定。
前台不要求用户理解或创建“工作空间”；后台仍按教练资料边界隔离数据。

测试资料
运行库 yuelian_security 已由 Roy 明确指定为开发测试库，验收后是否清空由 Roy 再决定。
保留七个固定 Mock 业务账号：周/林/陈教练，小林/小宇/安安学员，小周助教。
另新增8个普通试用账号：3教练、5学员。初始没有课程或学员关系；密码交付单放在Mac私有目录。
开通工具、幂等与后续追加方式：docs/trial-accounts.md。
只有私有控制配置中的真实 Sites 账号能使用 Mock 快捷登录；它也建立可撤销数据库会话。
保留三个教练边界、五份学员档案及既有测试课程。误建谢导空间和 Roy 学员关系不保留。
不能通过 URL、前端角色字段或任意用户 ID 冒充账号。production 设置禁用 Mock 登录。
独立 Cloudflare 入口即使运行库仍为test也固定禁止Mock，使用独立签名密钥及数据库业务会话。
它不要求GPT登录；两入口的会话不能交叉使用，客户端IP不作为业务用户身份。

业务与界面
现有日程、学员、场地文字资料、开放时间、收件箱、课时、反馈、练习、回访及团队操作
统一通过 /api/workspace 调用后台。传统按钮和 AI 共用授权、版本校验、事务、幂等和审计。
所有主页面使用底部 AI 输入；手机从底部弹出确认面板，内部滚动，确认按钮保持可达。
自然语言支持1–8步及新场地/学员依赖，逐步人工纠错后统一确认。模型不能直接执行、
扩大权限或读取未授权资料。学员练习默认私人，反馈由教练主动发布后学员才可见。
约课须对方确认且不消课；实际到课登记才扣课时；记录纠错更新原消课条目。
提交响应丢失由服务端回执恢复，不自动重复写入；撤销检查后续修改、关联、余额及冲突。
旧 /api/assistant 和通用 records 写入返回410，浏览器不保存业务快照或用假数据兜底。

模型与后台
DeepSeek V4.1 Flash；请求 Medium，服务端实际映射 High，无独立 Fast 参数。
严格 schema、真实资料引用与允许动作均检查；只有依赖图结构错误允许一次有界重新生成。
模型失败明确显示错误，保留传统操作；不放宽权限或伪造成功。
Mac PostgreSQL17；yuelian_runtime 非所有者且无 BYPASSRLS，所有者为 NOLOGIN。
后台127.0.0.1:18797。独立Cloudflare入口通过固定VPC服务和named Tunnel连接；
原Sites仍保留 /yuelian-security Funnel 路径，其他业务路由不变。
11/02断线修复证据：output/connection-repair-20261102/REPORT.txt；维护限制见docs/cloudflare-trial.txt。
001–004迁移不可改写；005新增独立账号/会话和定向邀请，006保留真实提交时间。
运行配置与凭据只放本机私有 runtime.env 及对应入口的部署 secrets，不能进入浏览器或模型上下文。

测试与证据
完整设计先于实施：tests/FULL-TEST-PLAN.md，164条跨功能、界面、单元、权限安全及发布用例。
可维护执行入口和运行条件：tests/full/README.md、package.json 中的 test:* 命令。
本轮 Cloudflare 试用：tests/TRIAL-CLOUDFLARE-TEST-PLAN.md（54项），证据在output/trial-20261102/。
历史首次全量：output/full-20261101/；理解层V1：output/ai-v1-20261101/。不得把历史成绩冒充本轮结果。
报告区分真实PostgreSQL、受控模型/受控API、真实DeepSeek、真实workerd和线上真实Sites访问。
旧 VERIFICATION.txt、/review/security 和早期 output 为历史验收快照，不代表本轮测试结论。
全量破坏性/故障测试仅使用 yuelian_acceptance_*；不得清空运行测试库作为方便的测试步骤。
备份在独立还原库实际验证，迁移在独立恢复库验证幂等、错误库拒绝及DDL后故障回滚。

当前边界
本轮将现有网页提供独立 Cloudflare 试用入口，保留原 Sites；未新增微信/手机号登录、原生App/小程序发布、订阅支付、
真实高德地图定位、外部通知、文件导出、录音转文字或完整小班成员管理。
浏览器320/390/768/1440宽度、模拟输入法/可视区验证不等于真实设备软键盘测试。
朋友使用独立 Cloudflare 入口和管理员分配的约练账号；原Sites仍有私有访问门禁。
Mac、数据库和网络需要在线；此轮没有把后端搬到云服务器。
同机加密备份和恢复验证不等于异地容灾；单次授权快照最多5000条，不静默截断。

站内账号增量升级（005 / 006）
对既有 yuelian_security 升级前先运行现有加密备份，并保留恢复证据。以下命令在项目根目录执行：
  node server/scripts/upgrade-accounts.mjs --database yuelian_security
  node server/scripts/upgrade-accounts.mjs --database yuelian_security --apply
第一条只读检查；第二条才应用缺失迁移。脚本校验数据库名称/所有者、运行角色和完整受审schema，
以迁移所有者在单事务内应用005/006，只补固定7个测试账号，不重建教练/学员/课程/账本或其他业务资料。
已有业务行数和内容摘要在提交前再次比较；旧邮箱待接受邀请按005撤销，历史未知提交时间保持null。
控制者读取本机私有 ~/.local/state/yuelian-security/mock-access.json；报告写入同目录upgrades，不输出身份或凭据。
遇到部分迁移或未知schema会拒绝，不能靠重复seedMockData“修复”。重复成功升级为幂等检查。
隔离演练使用 --rehearsal-database yuelian_upgrade_rehearsal_<后缀> --apply，必须先自行创建并恢复到新库。
schema参考文件 upgrade-accounts-schema.json 与005/006源码摘要绑定；修改迁移后必须重新独立验证，不可跳过检查。
