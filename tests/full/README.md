# 全量接口、恢复与模型验收

在项目根目录执行：

```sh
YUELIAN_REGISTRATION_ENABLED=true node tests/full/run.mjs
```

默认依次执行 `api`、`actions`、`business`、`security`、`recovery`、`live`、`ai-v1`、`ai-v1-live`、`ai-v1-outbound`、`ai-v1-booking-intent`，使用独立数据库 `yuelian_acceptance_full_20261101`；普通套件端口 18897，恢复套件 18901。此入口不替代认证专项、Workers、单元、浏览器、视觉与线上验收。完整范围见 `tests/FULL-TEST-PLAN.md`。

套件会重建这个明确指定的验收库中的 `app` 和 `private` schema，并在每条用例前重新建立虚构夹具；拒绝 `yuelian_security` 或不以 `yuelian_acceptance_` 开头的数据库。不要让两个此类套件同时使用相同数据库。所有角色先经真实注册接口创建业务账号，取得服务端会话后再请求 API；没有测试专用认证后门。管理员连接仅用于夹具与故障注入，产品后端始终使用 `yuelian_runtime`。

默认从私有 `/Users/jarvisxiao/.local/state/yuelian-security/runtime.env` 读取数据库与模型配置，不打印凭据。可通过 `YUELIAN_TEST_ENV` 指向其他私有配置；`YUELIAN_TEST_DATABASE`、`YUELIAN_TEST_PORT`、`YUELIAN_TEST_ADMIN`、`YUELIAN_FULL_OUTPUT` 可配置隔离环境。不要将 env 或模型密钥提交到仓库。

只执行选定套件：`YUELIAN_REGISTRATION_ENABLED=true node tests/full/run.mjs api actions`。`ACCEPTANCE_FILTER` 可暂时选择逗号分隔的用例 ID 调试；最终验收必须清除此筛选，执行全部套件。

`actions` 对 17 类动作分别经过手工草稿与受控模型草稿后执行实际事务并断言数据库结果。`live` 使用真实 DeepSeek，单列语义与提示注入测试。受控模型不计作真实模型通过。

每个套件在 `output/full-20261101/<suite>/results.json` 留存最新执行报告，根目录 `summary.json` 与 `coverage.json` 关联计划 ID、结果和证据；每轮在 `runs/<时间>/` 保存不可覆盖的历史副本。每个套件先清理固定名称的上轮结果文件，再核对本轮 `runId`；启动失败、空结果或旧结果均不能被计入通过。报告分别计算全部实现与后端依赖文件哈希；运行期间后端变化要求重跑本套件，只有 UI 文案变化不作后端失效，但仍须由 UI 套件复验。报告含测试业务资料，发布归档仍遵循原项目忽略规则。

`summary.passed` 按顶层用例组计数。动作矩阵的 34 组对应 17 类动作 × 2 路径；角色矩阵另有 85 条内部权限断言，不能再重复累计为顶层组数。`coverage.json` 的计划 ID 映射仅证明该组执行的后端断言；同一计划条目的浏览器、视觉、单元或线上层面必须另外提供证据。真实模型纠错用例检查两段不同人工备注的原值保留，但不将有限样本解释为模型对所有输入的绝对保证。

封闭试用运行配置已关闭注册。上面的 `YUELIAN_REGISTRATION_ENABLED=true` 仅传给隔离测试子进程，用于创建原有测试夹具，不修改 `runtime.env` 或在线服务。独立试用认证套件自行控制各子服务的注册开关，仍验证线上注册必须拒绝。

## 完整复验命令

要求 Node 24（支持 `--use-env-proxy`）、本机 PostgreSQL 17、上述私有配置、项目及 `server/` 依赖，以及已安装的 Google Chrome。浏览器自动化使用锁文件固定的 Playwright；不依赖临时 npx 缓存路径。

```sh
npm run test:unit        # Node 单元与真实 workerd 桥接
YUELIAN_REGISTRATION_ENABLED=true npm run test:auth # Sites 通道账号认证接口
YUELIAN_REGISTRATION_ENABLED=true npm run test:integration # 十套 PostgreSQL / 故障恢复 / 真实模型
npm run test:ui          # 真实浏览器，受控 API，角色/页面/尺寸矩阵
npm run test:edge        # 真实浏览器，交互/错误边界
npm run test:functional  # 搜索、筛选、导航、可访问性及未接入功能边界
npm run test:plan-ui     # 多步引用、人工纠错与迟到结果
npm run test:recovery-ui # 提交回执、恢复、冻结及撤销界面
npm run test:safety-ui   # AI处理中退出、权限变更、私密资料和持久XSS
npm run test:ai:ui       # AI中间层及多轮纠错界面
npm run test:trial:worker # 独立Cloudflare入口与签名桥接
npm run test:trial:auth   # 独立通道、注册关闭、会话及限流
npm run test:trial:accounts # 管理员开通工具护栏与事务
npm run test:trial:browser # 独立入口、角色、邀请与真实数据库
npx tsc --noEmit
```

真实数据库浏览器业务测试需要一个单独终端先启动 `YUELIAN_REGISTRATION_ENABLED=true npm run test:browser:server`，等出现 `Browser acceptance ready`。此服务只监听 loopback，重建专用验收库 `yuelian_acceptance_browser_20261101`，不能用于线上运行。然后依次运行 `npm run test:browser`、`npm run test:browser:auth`、`npm run test:browser:booking`、`npm run test:browser:undo` 和 `npm run test:browser:relations`；不要并行，因为它们操作同一固定夹具、受同一个外层账号限流。重新完整执行业务流程前应停止并重新启动 harness。结束时终止该测试服务。其外层 Sites 身份是受控测试夹具，业务账号注册/会话、桥接、权限与 PostgreSQL 均是实际产品代码。线上真实 Sites 门禁另行验证。

测试执行后用 `npm run test:coverage` 汇总已有报告中的计划 ID、执行层及具体用例。覆盖索引保留缺口、替代验证和硬件限制；它不会补跑用例，也不能把缺少浏览器或线上证据的接口通过自动升级为全量通过。

备份恢复验收入口为 `node tests/full/backup-restore.mjs /绝对路径/备份.pgdump.aesgcm`；只恢复至新建的 `yuelian_acceptance_restore_*` 库，不覆盖运行库。发布产物生成后运行 `node tests/full/check-release.mjs` 检查凭据与旧退出入口。测试报告文件不包含会话密码；本地中间夹具和服务日志位于被 Git 忽略的 `output/`，不打包进网站。

逐层覆盖索引可执行 `node tests/full/coverage-review.mjs` 重新生成，输出 `output/full-20261101/coverage-review.json` 和 `.md`。它按每个计划ID标出实际层级、未验证引用、执行失败、限制与待线上证据；不因为同ID的接口测试通过，就自动宣称其浏览器或部署层通过。数据库绑定算法采用真实PostgreSQL集成证据的分层选择逐项列在 `layerAlternatives`，不计作执行了单元测试。
