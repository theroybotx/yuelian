# 持续发布安全门禁

常规路线仍为 `.github/workflows/vercel.yml`；不开 Vercel 原生 Git 自动部署。环境/来源配置完成前，保持 `YUELIAN_DEPLOY_ENABLED=false`，一次性 `YUELIAN_FIRST_STAGE_ENABLED=false` 不再打开。

## 准入与环境

- Preview 仅允许本仓库 push、`GITHUB_REF_PROTECTED=true`、精确 `YUELIAN_PREVIEW_BRANCH`，且不能是 `YUELIAN_RELEASE_BRANCH`。PR、fork 与任意开发分支不进入发布 job。
- Production 继续要求受保护的精确发布分支或受保护的 `release-vX.Y.Z` 标签。main 的 Required checks 和 Isolated database acceptance 必须成功。
- 两个 job 分别绑定 `yuelian-preview` / `yuelian-production` GitHub Environment；仅发布 job 有 `deployments:write` / `actions:read`，检查 job 仍只读。
- 管理员须在启用前配置 Environment 的准确 deployment branch/tag policies；仓库级 secret 并不因声明 environment 自动变成环境级 secret，拥有仓库写权限的人仍属可信维护者。不得让不可信代码进入这些受保护来源，不使用 pull_request_target 执行 PR 代码。
- Preview 必须具有独立后端/数据、会话与签名配置；单独 URL 不能证明隔离。此代码改动不创建这些实例，也不证明隔离已通过。

## 同次制品与持久记录

每个发布 job 从当前 workflow run 下载 `vercel-manifest-${github.sha}` 到 `.ci-output-manifest`，最终构建/测试后逐项比较 sourceCommit 和全部文件摘要；不跨 run 下载同名制品。只有相同 SHA 的真实检查结果与制品才准上传。

所有发布 job 使用同一个不自动取消的 `yuelian-vercel-release` concurrency group。上传前再次核实时 ref，并查询同 SHA + 目标环境的 GitHub deployment receipt。任何已有 receipt（成功、失败或状态不明）均拒绝自动再上传。

上传前创建持久 intent，记录项目、SHA、ref、target、CI run ID，并 GET 同一 ID 核对。Vercel 上传带 `continuousReceipt` 元数据，完整 deployment API 必须匹配。冒烟和最终目标核对后写 success status，再 GET 该 status 核对。上传/响应失败保留 intent，不删除或自动重试，不把旧 CI 标绿。

## 中断与恢复

1. 关闭常规开关，保留原 workflow/run/receipt/deployment，先读回结果，不重放上传。
2. 用 intent 的项目/SHA/ref/CI run 和 Vercel `continuousReceipt` 查唯一部署，核 READY/target、完整制品摘要、登录与匿名 API、最终 alias（Production）。缺字段或出现多个匹配保持未确认。
3. 上传已完成时只修读取/补缺失状态，不再创建部署。只有独立核验实际成功后才补真实 success status；原失败 CI 保持失败。
4. 未完成发布的下一步由维护者明确决定，保留旧 intent。不得删 receipt 使自动重试绕过未知结果。
5. 回退代码使用新提交，不 force push。线上恢复按受保护来源、前一已核版本和原授权执行；控制器拒绝不明来源或向后覆盖。

首次正式 alias 接续使用精确 `YUELIAN_INITIAL_STAGE_ID`，只在当前 alias 未解析、项目 `targets={}` 且 `autoAssignCustomDomains=false` 时适用。控制器验证既有stage为READY/production/无alias、原firstStageReceipt已success、候选是stage同版或后继，以及候选同SHA唯一Preview receipt已success且真实部署的目标/项目/来源/receipt全部对应。还核全部production inventory（超过一页拒绝）不含无关上传；上传后只能出现当前run自己的receipt。所有核验在上传及提升前重读；现有alias恢复后自动回到正常forwardOnly。此路径不重开first-stage、不删除receipt、不把离线bootstrap替身投入生产。若同SHA Preview未成功，保持拒绝。

Vercel运行环境为preview时，网关在登录页和业务HTML加入显著固定Preview提示；Production不注入，JSON不改写。此标识使用平台runtime变量，构建制品仍跨目标逐字节可比。

本文件描述源码行为与操作前提，不声称远端部署/账号/业务验收已通过。真实版本和结果见原卡当前 run 的固定证据。
