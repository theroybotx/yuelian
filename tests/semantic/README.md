# 第一版语义评测运行说明

数据全部为原创虚构。150 条固定案例包括 45 条开发集、105 条保留测试集；其中 78 条显式标记为简短口语。完整场景和独立答案在 `dataset.mjs`。不要把整个数据文件或保留集答案送入生产提示。

`dev-examples.json` 只有明确属于开发集的 10 条示例，可供业务理解层筛选相关说明。它不是模型训练数据，也没有完整测试答案。当前是否实际被生产检索使用，需以实现和模型请求证据为准。

## 离线检查

```sh
node --test tests/semantic/oracle.test.mjs
node tests/semantic/run.mjs --mode=new --split=all
```

第二条默认只验证和保存本次选择，不调用模型。不能把 dry run 计为语义理解通过。

## 真实模型

从仓库目录运行，使用已经授权的私有 env 文件。不要将 API key 写入参数或日志。

```sh
node --use-env-proxy --experimental-transform-types \
  --env-file=/Users/jarvisxiao/.local/state/yuelian-security/runtime.env \
  tests/semantic/run.mjs --live --mode=new --split=all

node --use-env-proxy --experimental-transform-types \
  --env-file=/Users/jarvisxiao/.local/state/yuelian-security/runtime.env \
  tests/semantic/run.mjs --live --mode=baseline --split=holdout
```

可用 `--ids=SEM-A01,SEM-P01` 选择固定案例，`--representative` 选择固定 24 条保留集对照。`--output=output/semantic-v1/run-name` 指定新的输出目录；目录已有 `results.json` 时拒绝覆盖。基线文件保存在报告目录，从 c78 提取，不依赖新版理解模块。自定义输出应放在仓库 `output` 下，以便基线模块解析现有依赖。

新版实际调用生产 `prepareUnderstanding`、`understandingHint`、`generateResponse` 和修订入口；传入虚构的授权业务投影。评测不连接、不查询、不修改数据库，数据库会话绑定和持久多轮状态另做集成测试。

完整新版 150 条，加完整基线保留集 105 条，共 255 个逻辑案例。前置消歧可零次调用模型；解析器的有界重试可能增加实际调用数，报告按 HTTP 请求计数。默认并发 1，允许 `--concurrency=3` 或 4，最大 4。每例独立日志，汇总与控制台始终按固定 case 顺序输出；写盘同步串行，不互相覆盖。

## 如何判断结果

- `results.json` 每条都有 input text、完整返回草稿、独立检查路径、expected/actual、状态和错误。
- 断言比对所有步骤数量与顺序、意图、人物与场地 ID、日期、时长、数量、依赖。修订还逐字段检查没有要求改的业务值和引用保持。
- 同时报告严格字段与有效业务语义两种分数。初始 `record.publish=null` 按后台已有默认等于不共享，`edit-student.next=null` 等于保留；这些不能误判为业务错误。修订中的未改字段仍严格比较，不进行这种默认替换。`rescore.mjs` 可对同一原始响应重算，保留旧证据、旧oracle摘要和原因，零模型调用。
- 结果分开发集/保留集、组别和口语类型统计。没有真实模型调用的前置澄清与真实调用分别列出。
- `actualModelCalls` 是实际发出的 HTTP 请求数；`callsWithUsage` 是有厂商用量的请求数。不可拿字符数假装 token；无用量的失败单独保留。
- 保存每次调用的 request digest、instructions digest、actualModel、usage、耗时和 HTTP 状态。后续诊断轮另外保存公开的结构化 `output_text`（原始patch），不保存 API key、请求认证头或模型推理内容。首轮运行器没有保存此公开原始输出，错误只有应用验证结果。
- 首轮失败记录不会被覆盖。修复之后另建目录重跑；看过失败后调整实现的保留集结果必须叫“修复后回归”。
- 最终运行中源码摘要变化会使 runner 退出失败，即使全部案例通过。待实现冻结后重新整集验收。

对于固定 oracle 未列出的合法交互，`adjudicate.mjs` 另行记录第三种“交互等价”分数。它保留前两种分数和每条原始失败，逐项断言原始字段，引用带摘要的会话链证据。两版遵循相同裁定，不能只替新版放宽标准。例如唯一完整简称不等于公共前缀；先保留整项请求、逐项追问、随后恢复全部操作，需要真实持久会话验证，单轮只返回一句追问本身不能证明任务没有丢失。

```sh
node tests/semantic/adjudicate.mjs \
  output/semantic-v1/baseline-holdout-first/business-score.json \
  output/semantic-v1/new-full-final/results.json \
  output/ai-v1-20261101/api-final/results.json \
  output/ai-v1-20261101/live-final/results.json \
  output/semantic-v1/interaction-audit-unique-name.json
```

定点修复复测不能覆盖或冒充一次新的完整 150 条运行。汇总应分别列出整集所在源码、后续改动、定点范围、重复运行次数和每次原始失败；网络超时也是失败，不以“只是网络”划掉。

这些指标是这套固定合成场景的结果，不是全体真实用户准确率、所有说法的覆盖率、数据库执行正确率或端到端延迟承诺。

本轮最终累计证据：`output/semantic-v1/FINAL-ACCEPTANCE-MANIFEST-v3.json`，各版manifest保留。原150完整轮149/150交互口径，唯一姓名契约缺陷修复后完成范围回归；新需求独立24条最终整集24/24。只读称呼前缀修复后，受影响INTENT-11..19另回归9/9，未重写原24和姓名13的成绩。随后“示例 ·”场地装饰名匹配修复仅改变`lib/plan-amendment.ts`，原名称、简称、相近前缀和局部修改7条回归严格/业务6/7，R10依照既有独立裁定后交互7/7；原失败仍保留。新增装饰名与重名冲突单元测试、真实会话LIVE08另见主任务证据。`write-final-manifest.mjs`生成原manifest，v2与v3按次记录源文件边界、范围回归及上一版摘要。当前教练预约问句的新合同见 `INTENT-V1.1-PLAN.md`。
