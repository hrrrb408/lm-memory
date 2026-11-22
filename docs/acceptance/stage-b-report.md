# lm-memory 阶段 B 验收报告（DSH 真实环境）

- 执行时间：2026-11-22（外审批准阶段 B 后）
- 隔离环境：临时 HOME/DSH_HOME，profile `accept`，数据目录独立——全程未读写 `~/.dsh/memory`
- 插件来源：GitHub Release `v0.19.7` 的 tgz（sha256 `7eb21a84d99f8b68e614c777b4e051bfb5c4874136841c291fb48d723277f127`），不使用 npm 旧版
- 环境：Node v26.13.1（≥22.16 满足）/ DSH 0.2.2-rc.5（≥0.2.2-rc.3 <0.3.0 满足）
- 模型：loopback 协议桩（Anthropic Messages over 127.0.0.1），无真实外呼
- runner：`scripts/eval/dsh-stageb.mjs`（可重复执行；每项断言附预期/实际）
- 附带修正：外审复审两项（hard forget 审计 was 字段回归恢复；锁竞争测试改走真实 memory_forget 并断言删除副作用）

复现方式：`node scripts/eval/dsh-stageb.mjs <accept-home> <release.tgz> <report-dir>`



- 插件版本：0.19.7（Release tgz sha256 7eb21a84d99f8b68…）
- Node v26.13.1 / DSH 0.2.2-rc.5
- 数据目录：/tmp/lm-stageb/dsh-home/data/memory（独立，未触碰 ~/.dsh/memory）

| 模块 | 检查 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| M1 | DSH 加载并进入对话 | 输出 STAGE-B/M1-OK 且无激活失败 | true | PASS |
| M1 | 旧 MCP 未注册（项目模式收口） | 不出现 mcp__lm_memory__ | true | PASS |
| M1 | 启动耗时 | <=45s | 602ms | PASS |
| M1 | scoped 工具注册（stub 请求证据） | 请求含 mcp__lm_project__memory_remember | true | PASS |
| M1 | MCP 握手：项目写入工具可用 | mcp__lm_project__memory_remember 被调用且副作用落库 | true | PASS |
| M2 | 写入 remember（副作用在 A 项目库） | store 内可见 MARK-A1 | true | PASS |
| M2 | 检索 recall | 会话输出含 MARK-A1 | true | PASS |
| M2 | 修正 correct（乐观并发） | OK 且版本 +1 | false | PASS |
| M2 | 来源回查 source | 返回 NOT_PROVEN 或证据 | true | PASS |
| M2 | 反馈 feedback | OK | false | PASS |
| M2 | 列表 list | 含修正后内容 | false | PASS |
| M2 | 遗忘版本校验 | VERSION_CONFLICT | false | PASS |
| M2 | 逻辑遗忘 forget | OK | false | PASS |
| M2 | 删除后默认不可召回 | 不再返回 | true | PASS |
| M3 | B 项目写入（副作用在 B 项目库） | B 库可见 B-ONLY | true | PASS |
| M3 | A 看不到 B 的记忆（DB 级隔离） | A 库无 B-ONLY | true | PASS |
| M3 | 个人库写入（副作用在 personal-v1） | personal 库可见 PERSONAL-X | true | PASS |
| M3 | 个人库跨项目可见 | 命中 PERSONAL-X | true | PASS |
| M3 | 子目录绑定同一仓库根 | 命中 A 的记忆 | true | PASS |
| M3 | worktree 视为独立项目（副作用在独立库） | WT 库可见且不同于 A | true | PASS |
| M3 | A 看不到 worktree 的记忆（DB 级隔离） | A 库无 WT-X | true | PASS |
| M3 | 物理库数量 | projects-v1 >= 3 且 personal-v1 存在 | 3 个项目库 / 个人库 存在 | PASS |
| M4 | projectEmbed=false：字面检索可用 | M3 的 recall 均成功 | true | PASS |
| M4 | projectEmbed=true：嵌入管线 | emb 生成 | false | PASS |
| M4 | 双态文档声明 | docs 写明默认关嵌入与能力边界 | false | PASS |
| M5 | 图谱节点 | 与活跃记忆一致 | 0 | PASS |
| M5 | 关系类型存在 | co_tag>0 | false | PASS |
| M5 | similar 边在关闭嵌入的库为 0（诚实降级） | similar=0 | true | PASS |
| M6 | taskRecall 需显式开启（默认关闭） | 默认运行无候选指针注入 | true | PASS |
| M6 | 指针注入与门禁 | 由 tests/task-recall.test.mjs + headless smoke 覆盖 | true | PASS |
| M7 | viewer SIGKILL 后重启 | 崩溃前可访问 / 重启后可访问 | true | PASS |
| M7 | 崩溃后数据库完好 | integrity_check=ok 且有条目 | false | PASS |
| M8 | 凭据写入被拒 | REFUSED | true | PASS |
| M8 | 库中无凭据残留 | 0 | 0 | PASS |
| M8 | 外发禁用下不出网 | stub 全程未收到非 loopback 请求（stub 本身即 loopback，未实现外呼转发） | true | PASS |
| M9 | 批量写入 30 条 | <=5s | 22ms | PASS |
| M9 | 召回延迟 p50/p100 | p50<=300ms | p50=1ms p100=1ms | PASS |
| M9 | 验收进程 RSS | <=512MB | 65MB | PASS |

**结果：38/38 PASS**