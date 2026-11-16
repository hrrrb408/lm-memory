# Living Memory（轻量版 v0）

> 记忆库使用协议。任何 agent（DSH / Claude Code / 未来的 MCP server）读写这里时必须遵守。

## 结构

- `current.md` — 当前有效记忆（agent 每次会话开工先读这个）
- `log.jsonl` — 追加式事件日志：每条记忆的写入/修正/删除都记一行（时间、操作、来源）

## 写入规则（从 Living Memory 文档偷来的纪律）

1. **每条记忆必须带日期和来源**，格式：`- [YYYY-MM-DD] 内容（来源：会话/文件/工具）`
2. **禁止入库**：API key、密码、token、恢复码等一切秘密；用户明确说"别记"的内容
3. **修正不覆盖历史**：改 `current.md` 的同时在 `log.jsonl` 记一条 `correct`，旧内容留在日志里
4. **不确定就不写**：单次猜测、未验证的推断不进 `current.md`，宁可空着
5. **区分时效**：偏好/事实进 `current.md`；一次性事件只进 `log.jsonl`，除非有复用价值
6. **最小相关**：召回时只取和当前任务相关的条目，不整页背诵

## 敏感度

默认所有内容视为 internal（本机个人数据）。健康、住址、财务类标记 `[敏感]`，仅本地处理，永不外发给远程服务。

## 自动采集（dsh-lm-capture）

- 插件挂载在 DSH profile 上，监听 `session/created`、`workspace/session-stop`、`session/disposed` 与进程退出
- 会话结束时把「真实用户输入」（`source.kind === 'user'`，排除 runtime-context 等注入）提炼成一条 episode：
  `会话 <日期>｜<工作目录>｜N 条用户输入｜首问「…」｜末问「…」`
- 先写 `pending-episodes.jsonl`，由 MCP server 在启动/召回时幂等入库；同一 session 只采一次（`captured-sessions.jsonl` 为标记）
- episode 只可检索（memory_recall），**不进 current.md 基线**，不与偏好/事实混排
- 桌面端配置 `minUserMessages: 2`，一次性测试会话不会污染库
- 关掉它：从 profile 的 `cordis.patch.yml` 移除 `lm-capture` 条目并重启

## 升级路径

v0 是纯文件。若未来迁移到 MCP server（SQLite+FTS5），数据从这里导出为 JSONL 即可，字段约定保持兼容。

## Sleep-time 价值衰减（v0.7）

- **召回埋点**：每次 `memory_recall` 返回的记忆记一次命中（`hit_count` / `last_hit_at`）
- **宽限期**（按 kind）：todo 45 天、episode 60 天、fact/procedure 120 天、preference 240 天
- **命中延期**：每命中一次 +7 天，上限 +90 天；修正/唤醒会重置时钟（`updated_at` 刷新）
- **休眠（dormant）**：超期未置顶的 active 记忆转入 dormant——默认召回不包含（显式 scope=dormant/all 可查）、不进 current.md，但保留在库中可随时唤醒。触发：server 启动时 + 每 12 小时巡检 + `memory_sleep` 手动
- **置顶/唤醒**：`memory_pin`（pin / unpin / wake）——置顶永不休眠；对休眠记忆置顶会同时唤醒
- 全部转换写入 `log.jsonl`（`sleep_pass` / `pin` / `unpin` / `wake`），可审计可回滚

## 英文语义层（v0.8）

- 双模型：中文 bge-small-zh（`emb` 列）+ 英文 bge-small-en（`emb_en` 列），按查询语言自动路由（含 CJK → zh，含拉丁字母 → en）
- 写入/修正时双列同时嵌入；backfill 自动补齐两列；换模型自动作废旧向量
- 首次使用 bge-small-en 需联网下载 ~130MB 到 `models/` 缓存（生产与评测共用）
- 注意：在 DSH 沙箱/托管 node 里跑评测会被 macOS AMFI 拦 onnxruntime 原生库，评测一律用 `/opt/homebrew/bin/node`；`lm-bench/` 是外部基准 harness（LongMemEval/LoCoMo）

## 会话摘要卡（v0.9）

- dsh-lm-capture 的 extract-helper 在会话结束时额外生成 1-2 句带日期的自包含摘要，作为 `episode` 入库（tags 前缀 `summary,`，source `auto-extract`）
- 作用：给跨会话联合与时间线推理提供 session 粒度上下文（当年 bench 显示时间推理 0.60→1.00，但与摘要/top-k/提示同期共变、未做单变量消融——2026-11-17 勘误后仅作方向参考）
- 幂等：同一 session 只写一张（`summary,%` 前缀 + session 标签双条件去重）；孤儿任务重跑安全
- server 启动/召回前经统一提交入口消化候选队列（凭据拦截/查重/嵌入/索引/图谱/热流同路径），12h 巡检兜底补嵌

## 日期锚定（2026-11-02 摄入机制；归因 2026-11-17 勘误）

- **摄入端**：extract-helper 的原子提炼与会话摘要均要求把相对时间（昨天/上周/明天）换算成绝对日期再入库（以会话日期为锚）。机制有效，但旧注「multi-hop 0.20→0.93 的核心机制」作废：当年 bench 类别映射错（0.93 实为时间题）且未做单变量消融
- **消费端**：MCP server instructions 提醒 agent 做时间推算时以每条记忆的 date 字段为锚。v0.15 起 `date` 取自 `event_date`（事件发生/观察日），唤醒/修正/休眠等管理操作不再推移它（此前 date=updated_at 会被管理操作污染）
- 教训来源：LoCoMo 逐题验尸发现时间类失分多为相对时间未锚定的日期算术问题

## 提炼模型可配置（2026-11-02）

- 会话提炼/摘要的 LLM 可在插件 patch 的 `llm` 块配置：`{ model, baseURL, apiKeyEnv }`，默认 glm-5.3-flash @ bigmodel
- key 解析顺序：`apiKeyEnv` 指定的环境变量 → `~/.dsh/.credentials.yaml` 中同名条目；无 key 时优雅降级（跳过 LLM 提炼并清理任务，检索功能不受影响）
- `LM_LLM_MODEL` / `LM_LLM_BASE` 环境变量亦可兜底

## 会话模型跟随（2026-11-02）

- **默认行为**：提炼/摘要跟随会话最后使用的模型（`request/header` 事件的 provider+model）——用户聊天选什么档位，记忆提炼就用什么档位，零配置
- 优先级：`llm` 块显式 `model`（用户接管）> 会话模型（provider 在映射表内：zai-coding-cn / deepseek-official / deepseek-api-key / agnes，自动带 baseURL+keyEnv）> 默认 glm-5.3-flash
- key 从 `apiKeyEnv` 的环境变量或 `~/.dsh/.credentials.yaml` 同名条目读取；解析不到则优雅降级（跳过提炼，检索不受影响）
- helper 的 stderr 会打印所选模型与来源，如 `[extract] LLM: glm-5.3 @ open.bigmodel.cn (来源: session(zai-coding-cn))`

## 召回契约（可靠性修复，未发布）

- `memory_recall({id: 123})` 或 `{query: "#123"}` 精确读全文；`query` / `id` 必须二选一。
- `kind` 同时约束词法、语义、ID 与图谱关联结果；候选频率统计也使用相同范围。
- 默认 `scope: "active"`；显式 `"dormant"` 只查休眠，`"all"` 查 active+dormant。任何范围都不含 deleted/superseded。
- 返回记录含 `status`。休眠读取只作发现，不自动唤醒，也不更新休眠条目的命中统计；恢复使用 `memory_pin({id, action:"wake"})`。
- 图谱目前只有 active-active 边，dormant 搜索不扩展图谱；all 的关联仍只含 active，并受 kind 约束。
- 搜索默认 `max_bytes: 16384`，允许 512–65536 UTF-8 字节。预算按完整条目裁剪，绝不截断证据正文；超额返回 `{hits, related, budget:{max_bytes, omitted, notice}}`。预算内保留原数组格式，expand 时为 `{hits, related}`。无相关结果沿用原来的空结果提示。
- ID 精确读取绕过搜索字节预算以兑现全文指针；最多一条主命中。搜索预算省略的候选不获得命中延期。
- current.md 硬限 25KiB / 200 行，优先输出置顶（含 ID）再输出普通索引；超额保留整行并标明省略。置顶量超额时也会省略，应按需读取。热流注入硬限 8KiB / 40 行，原有每批 8 条限制保持。
- 缓存身份包含完整文本、模型、query/passage 角色与查询前缀；RRF 缺失分支贡献为零。
