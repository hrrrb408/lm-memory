# lm-memory 阶段 B 验收报告（0.19.8 重跑）

> **（归档注记，非断言行）** 本轮 tgz 为发布前本地打包 `npm pack`（sha256 `01a92cba0b6407f62…`，与待发布 v0.19.8 同一工作树）；按外审规则，GitHub Release v0.19.8 发布后将用 Release tgz 复跑盖章并更新本目录。0.19.7 的 38/38 已被外审判为含假阳性（真实 28/38），本报告由修复后的验收器生成，每行 pass 均为真实布尔断言，验收器自检见 `tests/stageb-harness.test.mjs`。

- 插件版本：0.19.8（Release tgz sha256 01a92cba0b6407f6…）
- 验收环境：Node v26.13.1 · darwin/arm64 · 主机 huangruibangdeMacBook-Pro.local · DSH /Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh
- 隔离 HOME：/tmp/lm-stageb2/dsh-home · 数据目录 /tmp/lm-stageb2/dsh-home/data/memory · 生产库 sha256 前后一致：true
- 验收器自检：tests/stageb-harness.test.mjs（record 强制 boolean，杜绝假 PASS）
- M6 自动召回实机验证独立执行：scripts/eval/dsh-stageb-m6.mjs（见 docs/acceptance/stage-b-m6-optin.md）

| 模块 | 检查 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| M1 | DSH 加载并进入对话 | 输出 M1-OK | M1-OK | PASS |
| M1 | 旧 MCP 未注册（项目模式收口） | 不出现 mcp__lm_memory__ | 未出现 | PASS |
| M1 | 启动耗时 | <=45s | 658ms | PASS |
| M1 | scoped 工具注册（stub 请求证据） | 请求含 mcp__lm_project__memory_remember | 已注册 | PASS |
| M1 | MCP 握手：项目写入工具可用 | 工具被调用且副作用落库 | called=true landed=true | PASS |
| M2 | 写入 remember（副作用在 A 项目库） | store 内可见 MARK-A1 | store=/tmp/lm-stageb2/dsh-home/data/memory/projects-v1/f558890a1521592dc473e3e729c96dba413af8589a7787fcc0c4092e67cf56a7 | PASS |
| M2 | 检索 recall | 会话输出含 MARK-A1 | 命中 | PASS |
| M2 | recall 返回可解析 id | id 为正整数 | id=2 | PASS |
| M2 | 修正 correct（乐观并发） | OK 且返回新版本 id | OK: 新版本 id=3 v2（取代 id=2） | PASS |
| M2 | 修正 supersede 链（DB 级） | 旧行 superseded；新行 active、v=2、指向旧行 | old=superseded new=active v2 supersedes=2 | PASS |
| M2 | 新版本直读 | id 直读返回 MARK-A2 | [
 {
  "id": 3,
  "v": 2,
  "kind": "fact",
  "date": "2026-11-22",
  "content": | PASS |
| M2 | 来源回查 source | 返回非空（NOT_PROVEN 或证据） | NOT_PROVEN: 此条没有可回查的原文证据。 | PASS |
| M2 | 反馈 feedback | OK | OK | PASS |
| M2 | 列表 list | 含修正后内容 MARK-A2 | [
 {
  "id": 3,
  "version": 2,
  "kind": "fact",
  "content": "M2 记忆标记 MARK-A2（ | PASS |
| M2 | 遗忘版本校验 | 错误版本返回 VERSION_CONFLICT | VERSION_CONFLICT: id=3 当前 v2 ≠ 期望 v99。请刷新后重试。 | PASS |
| M2 | 逻辑遗忘 forget（正确版本） | OK | OK: id=3 已删除（逻辑），不再出现在召回与 current.md；需彻底擦除可再次 forget 并 hard= | PASS |
| M2 | 删除后数据库状态 | 新版本行保留且 status=deleted | status=deleted version=2 | PASS |
| M2 | 删除后默认与 all 均不可召回 | 两口径都不返回 MARK-A2 | []（无相关记忆。不确定就不编造。） | PASS |
| M3 | B 项目写入（副作用在 B 项目库） | B 库可见 B-ONLY | store=/tmp/lm-stageb2/dsh-home/data/memory/projects-v1/92d84ecff8315aa80b40602b24d6f50894c6cf38d74d24ece69ee60736032047 | PASS |
| M3 | A 看不到 B 的记忆（DB 级隔离） | A 库无 B-ONLY | storeA=/tmp/lm-stageb2/dsh-home/data/memory/projects-v1/f558890a1521592dc473e3e729c96dba413af8589a7787fcc0c4092e67cf56a7 | PASS |
| M3 | 个人库写入（副作用在 personal-v1） | personal 库可见 PERSONAL-X | store=/tmp/lm-stageb2/dsh-home/data/memory/personal-v1 | PASS |
| M3 | 个人库跨项目可见 | 命中 PERSONAL-X | 命中 | PASS |
| M3 | 子目录绑定同一仓库根 | 命中 A 的记忆 MARK-A2 | 命中 | PASS |
| M3 | worktree 视为独立项目（副作用在独立库） | WT 库可见且 ≠ A | store=/tmp/lm-stageb2/dsh-home/data/memory/projects-v1/ced09025498a2877bed58a19e50aee9d9b61fb2b24500b93739f5c9f7ac5f075 | PASS |
| M3 | A 看不到 worktree 的记忆（DB 级隔离） | A 库无 WT-X | storeA=/tmp/lm-stageb2/dsh-home/data/memory/projects-v1/f558890a1521592dc473e3e729c96dba413af8589a7787fcc0c4092e67cf56a7 | PASS |
| M3 | 物理库数量 | projects-v1 >= 3 且 personal-v1 存在 | 3 个项目库 / 个人库 存在 | PASS |
| M4 | 嵌入模型预热（搭建期联网，测试期离线） | 双模型缓存就绪 | 双模型缓存就绪 | PASS |
| M4 | projectEmbed=false：字面检索可用 | M2/M3 的 recall 真实命中（非写死） | {"m2":true,"bPersonal":true,"sub":true} | PASS |
| M4 | projectEmbed=true（DSH 项目模式）：向量真实生成 | 项目库 emb 非空 1 条 | store=/tmp/lm-stageb2/dsh-home/data/memory-embed/projects-v1/f558890a1521592dc473e3e729c96dba413af8589a7787fcc0c4092e67cf56a7 emb=1 | PASS |
| M4 | 独立 server LM_EMBED=1：嵌入管线 | emb 非空 1 条 | emb=1 | PASS |
| M4 | 双态文档声明 | 打包 docs 写明默认关嵌入与能力边界 | 声明存在 | PASS |
| M5 | 带标签记忆写入（A 项目库） | 两条写入 OK | g1=true g2=true | PASS |
| M5 | 图谱节点（A 项目库） | 活跃记忆 >= 3 | nodes=3 | PASS |
| M5 | 关系类型存在 | co_tag >= 1（共享标签） | {"co_tag":1,"similar":0,"ref":0} | PASS |
| M5 | similar 边在关闭嵌入的库为 0（诚实降级） | similar=0 | similar=0 | PASS |
| M6 | taskRecall 需显式开启（默认关闭） | 默认运行无候选指针注入 | 无指针 | PASS |
| M6 | 指针注入与门禁（独立实机 runner） | stage-b-m6-optin 全 PASS | 5/5 | PASS |
| M7 | viewer SIGKILL 后重启 | 崩溃前可访问 / 确认死亡 / 重启后可访问 | alive1=true dead=true alive2=true | PASS |
| M7 | 崩溃前标记可见 | API 返回 MARK-CRASH | 可见 | PASS |
| M7 | 重启后标记仍在 | API 返回 MARK-CRASH | 可见 | PASS |
| M7 | 崩溃后项目库完好 | integrity_check=ok 且标记行在库 | integrity=ok rows=1 | PASS |
| M8 | 外发监测器自检 | 探测器能捕获非 loopback 连接 | lan=192.168.2.193 hits=121 | PASS |
| M8 | 凭据写入被拒 | REFUSED | REFUSED: 内容疑似凭据。秘密不入记忆库。 | PASS |
| M8 | 库中无凭据残留 | memDir 与 A 项目库均 0 条 | leaked=0 | PASS |
| M9 | 批量写入 30 条 | <=5s | 26ms | PASS |
| M9 | 召回延迟 p50/p100 | p50<=300ms | p50=1ms p100=3ms | PASS |
| M9 | 验收进程 RSS | <=512MB | 152MB | PASS |
| M10 | 验收数据目录在隔离 HOME 内 | memDir 位于 acceptHome 下 | /tmp/lm-stageb2/dsh-home/data/memory | PASS |
| M10 | 生产记忆库全程未变 | sha256 前后一致（未触碰 ~/.dsh/memory） | pre=38dc29cbf017 post=38dc29cbf017 | PASS |
| M10 | 项目库指纹互异 | A/B/WT 三库 sha256 互不相同 | 2c79d8bb/d609927a/d5ee6a59 | PASS |
| M10 | 受监视进程无非 loopback 外联 | 自检基线后 0 命中（250-400ms 采样 + 子进程树展开） | hits=0 pids=16 | PASS |
| M10 | 代理汇点零命中 | HTTP(S)_PROXY 指向本地汇点，全程 0 请求 | sinkHits=0 | PASS |

**结果：52/52 PASS**

> 外审复审说明：0.19.7 的 38/38 存在验收器假阳性（actual/pass 错序 + 写死 PASS），真实成绩 28/38；
> 本报告由修复后的验收器生成，每一行 pass 均为真实布尔断言。