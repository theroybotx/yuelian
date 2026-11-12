# 管理员创建试用账号

这批试用账号使用约练自己的用户名和密码。管理员在 Mac 的终端创建账号，再分别把账号信息交给试用者；不需要短信或邮件服务。学员与教练仍通过平台已有的邀请流程关联，不会因为名字相同或账号一起创建而自动关联。

脚本是本地管理工具，不提供新的公开注册、找回密码或重置密码接口。公开注册是否关闭由后端认证配置控制；此脚本本身不修改线上配置。

## 默认八个账号

| 用户名 | 显示名 | 初始身份 |
| --- | --- | --- |
| `trial-roy` | Roy（试用学员） | 学员 |
| `trial-coach-01` | 试用教练01 | 教练 |
| `trial-coach-02` | 试用教练02 | 教练 |
| `trial-coach-03` | 试用教练03 | 教练 |
| `trial-student-01` | 试用学员01 | 学员 |
| `trial-student-02` | 试用学员02 | 学员 |
| `trial-student-03` | 试用学员03 | 学员 |
| `trial-student-04` | 试用学员04 | 学员 |

教练使用现有 `private.create_workspace` 函数创建自己的教学资料和 owner 成员关系，与原账号创建流程一致。初始没有课程、学员档案、课时、场地或邀请。学员仅创建登录账号，初始不属于任何教练。

## 先检查，再新增

在项目根目录执行。必须明确指定数据库；默认仅检查，不创建账号或密码文件。

```sh
node --env-file="$HOME/.local/state/yuelian-security/runtime.env" \
  server/scripts/provision-trial-accounts.mjs \
  --database yuelian_security
```

检查输出只有用户名、显示名、身份、`existing` / `would-create` 和数量，不含密码。确认这批账号确实在本次授权范围内后，执行新增：

```sh
node --env-file="$HOME/.local/state/yuelian-security/runtime.env" \
  server/scripts/provision-trial-accounts.mjs \
  --database yuelian_security \
  --apply \
  --credential-output "$HOME/.local/state/yuelian-security/trial-credentials/initial-batch.json"
```

新账号默认生成 24 字节随机值编码成的 32 字符密码。密码复用现有 scrypt 参数与随机 salt，仅哈希存入数据库。明文只写入指定的私有文件，文件为 `0600`，父目录必须属于当前系统用户且为 `0700`。文件必须使用绝对路径，放在项目外；已有文件或符号链接不会被覆盖。

私有文件的 `accounts` 数组包含新账号的 `username`、`name`、`role` 和 `password`。管理员从该文件分别取出需要交付的条目，不要把整批密码复制到终端日志、项目文件、Git 或公开使用指南中。重复执行相同命令时，已有账号不重新生成密码，不改原文件，也不重复创建教学资料。

## 后续新增账号

不限制使用默认八个用户名。建立一个**不含密码**的清单，例如 `new-trial-accounts.json`：

```json
{
  "accounts": [
    { "username": "friend-coach-04", "name": "新试用教练", "role": "coach" },
    { "username": "friend-student-05", "name": "新试用学员", "role": "student" }
  ]
}
```

用户名沿用平台规则：3–32 位、小写字母开头，可含字母、数字、点、下划线和连字符；输入会去首尾空格并转小写。`demo-*`、`mock-*` 等系统保留名不能创建。身份只能为 `coach` 或 `student`，后续助教、管理员权限通过正常邀请流程授予。

```sh
node --env-file="$HOME/.local/state/yuelian-security/runtime.env" \
  server/scripts/provision-trial-accounts.mjs \
  --database yuelian_security --file new-trial-accounts.json
```

检查无冲突后，在同一命令加 `--apply --credential-output`，使用一个新的私有输出路径。清单可以只列新账号，也可以包含已创建账号；后者会被核验并保留。

如需自定新账号密码，通过 `--passwords-stdin` 接收 JSON；不要将密码放在命令参数或清单中。输入格式为 `{"passwords":{"用户名":"密码"}}`，由安全输入工具写入标准输入。可仅为部分新账号指定密码，其余随机生成。密码沿用平台现有长度限制；不符合要求时整批拒绝。为已有账号提供密码会报 `PASSWORD_RESET_FORBIDDEN`，不会执行重置，也不会让人误以为密码已更新。

## 幂等、冲突与失败处理

- 每个用户名对应确定的本工具身份 ID。已有账号的 ID、用户名、显示名、注册身份、密码登录类型及启用状态都必须吻合；普通注册账号重名、配置改名改身份、停用账号均拒绝整批操作，不覆盖或重新启用。
- 已有教练必须保留一个有效、自建的教学资料。教学资料名称、已有课程、课时、学员资料及会话不会重置；缺少有效教学资料时拒绝自动修复。学员后续接受的教练关联也会原样保留。
- 一批账号在单个数据库事务内创建；教练资料创建失败时，本批新增全部回滚，未提交的密码文件删除。并发创建同一用户名使用数据库事务锁，只有一方新增，不会产生第二套密码。
- 密码文件先写入并同步到磁盘，再提交数据库。文件中的 `preparedAt` 只说明它已准备好，不能单独证明数据库提交成功。以命令成功输出为准。
- 如果提交时进程退出或连接中断，保留私有密码文件，先执行同一清单的 dry-run 核对。不要盲目重建或覆盖文件；已有账号不会由本脚本重置密码。所有账号仍显示 `would-create` 时，才能确认这批尚未提交，再使用一个新的输出文件重试。
- 标准输出和错误输出不包含密码、salt、hash 或原始数据库错误。意外数据库错误统一为 `PROVISION_FAILED`；其他拒绝包含固定原因代码。

## 数据库权限与验收

脚本固定使用既有 `yuelian_runtime` 角色，拒绝 owner、超级用户、BYPASSRLS、建库/建角色权限或 owner 成员身份。只使用现有账号 `SELECT` / `INSERT`、事务锁及 `private.create_workspace` 权限；不需要新增授权或迁移，也不使用 schema owner 执行业务写入。数据库名必须显式为 `yuelian_security` 或隔离的 `yuelian_trial_rehearsal_*`，并核对实际数据库与 schema 所有者。

运行独立验收：

```sh
node --test tests/provision-trial-accounts.test.mjs
```

测试使用新的 `yuelian_trial_rehearsal_<时间>_<进程>` 数据库。测试夹具由本机现有管理员创建隔离库并安装现有迁移；CLI 本身始终以 runtime 角色操作。结束后删除该隔离库和临时私有密码目录，不连接运行库。报告写入 `output/trial-accounts-20261102/results.json`，清理证据在同目录 `cleanup.json`。

覆盖默认检查、首次新增与真实密码验证、已有登录服务、重复执行、后续增量、冲突拒绝、资料与会话保留、新教练 RLS 隔离、未关联学员空关系、已关联学员关系保留、stdin 校验、不泄露凭据、私有文件权限/路径/拒绝覆盖、事务回滚、并发幂等及错误数据库保护。

## 试用者的关联步骤

1. 教练登录，使用“添加学员”建立该学员档案。
2. 教练在已有邀请界面填写试用学员的约练用户名，生成邀请。
3. 管理员或教练把邀请入口交给指定学员；平台不会代发微信、短信或邮件。
4. 学员用自己的账号登录并接受邀请，随后在自己的教练列表和收件箱中操作。

同一学员可以按正常流程接受多个教练邀请，彼此教学数据继续按权限隔离。Sites 预览的访问分享与约练业务账号是两层独立权限；创建约练账号不会自行开放 Sites 给外部访客。
