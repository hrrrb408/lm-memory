<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/banner-dark.svg">
  <img src="docs/banner.svg" alt="lm-memory — local-first long-term memory for agents">
</picture>

Agent 长期记忆：一个 MCP server、一个可选的 DSH 采集插件、一个本地管理页。单用户，SQLite + FTS5 + 本地双语嵌入（56MB）。存储和嵌入都在本机；提炼和摘要会调用你配置的远程 LLM，`allowRemote: false` 可以全部关掉。

这个项目被外部评审反复锤过十一轮（2026-11-17 起，5 分到 6.5 分再到逐轮收口），所以 README 里对可靠性、隐私、评测的描述都以故障注入测试和验收记录为准，不写做不到的事。

## 它解决什么问题

换个会话、换个宿主，AI 就失忆。lm-memory 给它们一块共享的、可检索、可纠正、会遗忘的记忆层。它最在意的不是功能多，而是三类常被忽略的故障：网络抖一下就永久漏记、续聊一次就覆盖掉新任务、错误记忆靠反复曝光给自己续命。这三个都有对应的机制和回归测试（见下文任务状态机、outbox、使用反馈续租）。

## 特性

| 能力 | 说明 |
|---|---|
| 统一提交入口 | MCP、采集卡、提炼候选三条写入路径走同一个事务函数 `commitMemoryTx`：凭据拦截 → 查重 → 事务 → 嵌入 → 索引 → 图谱 → 热流。提炼进程没有任何写库权限 |
| 持久 outbox | 内容变更和事件写在同一个 SQLite 事务里，事件写失败内容一起回滚。热流至少一次投递，每条事件带 `eid`，消费端去重 |
| 提炼任务状态机 | 派发、领取（owner + 10 分钟租约）、回执、结算全部落库。LLM 失败、截断输出、缺 key 都会保留任务重跑，超 5 次归档到 `extraction-jobs/failed/`。「有没有漏记」可以查表 |
| 使用反馈续租 | 召回命中只算曝光，`memory_feedback useful=true` 才续租。错误记忆没法靠反复出现在检索结果里给自己延寿 |
| 来源回查 | 自动条目保存脱敏后的输入窗口和消息序号，`memory_source` 可以查到这条记忆来自哪句话 |
| 同会话纠正 | 提炼输出可以带 `supersedes_id` 加逐字引文取代旧主张，引文对不上就不落库 |
| 检索 | FTS5 trigram 词法 + bge-small-zh/en 双语语义，按查询语言路由，RRF 融合。零命中会提示休眠馆里有别的记忆 |
| 遗忘 | 使用反馈 TTL + 按类型宽限期（待办 45 天、会话 60 天、事实和经验 120 天、偏好 240 天），超期转 dormant 降可见度，可唤醒，置顶豁免。这只是一套降可见度策略，没有证据说明它是正确的遗忘模型 |
| 批量写入 | `memory_batch_remember` 最多 50 条，逐条过统一提交防线 |
| 安全 | 凭据模式三处入口共用一套常量；采集落盘前脱敏；viewer 只接受本机严格同源请求；在线备份带 integrity 校验 |
| 记忆运维 | 冲突消解扫描（信号粗筛 + 模型复核，判定缓存化）、dream 去重、记忆图谱（similar/co_tag/ref 边）、变更热流向已开会话推送 |

## MCP 工具

| 工具 | 说明 |
|---|---|
| `memory_remember` | 写入。可显式传 `event_date`；凭据模式直接拒绝 |
| `memory_recall` | 词法+语义融合检索；`expand: true` 附图谱一跳扩展；零命中会提示休眠馆 |
| `memory_correct` | 修正，需 `expected_version`；新版本继承置顶和事件锚 |
| `memory_forget` | 默认逻辑删除；`hard: true` 按 id 物理删除任意状态的行（只删该行）；休眠条目可删 |
| `memory_list` | 按种类列出最近记忆 |
| `memory_pin` | 置顶 / 取消置顶 / 唤醒休眠 |
| `memory_sleep` | 手动跑一轮休眠整理 + 冲突扫描 |
| `memory_feedback` | `{id, useful: true}` 更新续租统计。曝光不算使用 |
| `memory_source` | 查自动条目的原文来源（脱敏窗口 + 消息序号） |
| `memory_batch_remember` | 批量写入（≤50 条），逐条过完整防线 |

## 架构

```
你的 Agent（DSH / Claude Code / 其他 MCP 宿主）
   │
   ├── MCP server（独立进程）：10 个记忆工具 + 统一提交入口 + outbox + 任务账本
   │
   └── [仅 DSH] dsh-lm-capture 插件
         会话结束 → 采集卡 + 提炼 job 文件 + 待派发通知（不直接 spawn）
              ↓
         server dispatchJob：禁外发检查 → 登记 → 原子领取 → spawn helper
              ↓
         helper：脱敏 → LLM 提炼/摘要 → 候选队列 + 回执
              ↓
         server：候选消费 → 回执结算
         周期任务：30 分钟任务回收 / 12h 休眠整理与补嵌
```

数据目录默认 `~/.dsh/memory/`（`LM_MEMORY_DIR` 或插件 `memoryDir` 可改）：

| 文件 | 用途 |
|---|---|
| `memory.db` | SQLite + FTS5 + 向量 + outbox + 任务账本 |
| `current.md` | 注入层索引（置顶全文 + 一行指针；写失败时 EXISTS 重试自愈） |
| `log.jsonl` / `changes.jsonl` | 无内容审计流 / 带摘要的变更热流 |
| `pending-*.jsonl` | 采集卡、提炼候选、待派发任务队列（rename 快照崩溃恢复） |
| `extraction-jobs/` | 任务文件、`receipts/` 回执、`failed/` 归档 |
| `models/` | 嵌入模型缓存（首次下载约 56MB） |

## 任务怎么不丢

提炼任务的生命周期全部落库（`extract_jobs` 表），漏没漏记查表就知道：

```
登记（pending）
  → 原子领取（条件 UPDATE 抢 owner+租约，第二个 server 抢不到）
  → helper 执行（LLM 失败/截断/坏输出/缺 key → 保留任务，非零退出）
  → 候选消费（哪条失败哪条进重试队列，任务不标完成）
  → 回执结算（回执里全部候选 eid 都处置完才算 done；零候选也是明确终态）
  → 领取次数超 5 → failed 归档
```

几个设计决定：

- 候选 id 由 hash(sessionId · rev · kind · content) 确定性生成，rev 在任务创建时固定。同一个任务重跑不会换身份，重放不会把新摘要退回旧版；摘要更新还有版本序约束。
- 事件至少一次投递，靠 `eid` 在消费端去重；内容变更和事件同一个事务，不存在「库改了通知丢了」。
- 队列消费用 rename 快照，崩溃残留的 `.processing` 下次并回；写回失败就保留快照，从不删没落盘的数据。
- `allowRemote: false` 时派发入口在领取前就拦截，helper 自己也检查一遍；任务保留，恢复远程后自动重跑。

## 变更热流

写操作事件进 outbox，再投到 `changes.jsonl`，插件在每个模型 step 前按 per-session 字节 offset 增量读取，把变更摘要注进已开会话（一次最多 8 条）。候选队列的消费时机是 server 启动、召回前和周期巡检，不承诺会话运行中的秒级入库。

修改 `allowRemote` 后重启 DSH，使 MCP server 使用新配置。管理页是独立进程，只有能确认它由当前安装启动时才会自动替换；否则设置面板不会连接旧进程。请确认占用端口的是你启动的旧 lm-memory viewer，再手动停止并重启 DSH；若不是，请改用空闲端口。

## 安全

凭据防线是 `server/guards.mjs` 一个模块管三处入口（模式：`sk-…`、`api_key=…`、ghp/xox/AKIA 前缀）：MCP 写入直接拒绝；采集在落盘之前脱敏；进远程 prompt 之前再过滤一遍，「别记」的消息整条剔除。评测分块摄入也走同样的双重过滤，有「分块拼不回凭据」的测试。

Viewer 监听回环地址，并检查请求的 Host。对携带 Origin 的请求，读接口允许本机来源和 `dsh-app://app`，在跨来源读取时回显 CORS；写接口只允许严格同源或 DSH Desktop 自定义协议来源。设置页先通过宿主接口确认当前 Viewer 地址与配置相符，再读取摘要。

边界要说清楚：凭据模式只认常见格式，不是机密检测器；逻辑删除保留审计行和历史热流摘要（删除事件本身不带原文）；`hard: true` 按 id 删行，介质级擦除和备份清理不在此列。

## 评测

所有成绩都是 glm-5.3-flash 同模型作答和判分、bench 摄入而非生产自动提炼链路。跟任何厂商自报数字（Mem0 92.5%、Zep 94.7%）没有可比性。

### LoCoMo

| 协议 | 结果 |
|---|---|
| 前 3 段 55 题（官方类别映射勘误后重聚合） | 总体 40/55 = 0.727：multi-hop 0.67、temporal 0.93、open-domain 0.30、single-hop 0.87、adversarial 没测 |
| 全量 10 段 1986 题（2026-11-17） | 非陷阱 1540 题 73.77%（multi-hop 55.32、temporal 80.06、single-hop 81.21、open-domain 41.67）；陷阱 446 题 82.06%；合计 75.63% |

历史小样当年用错了类别映射（官方映射见 [snap-research/locomo#29](https://github.com/snap-research/locomo/issues/29)），曾宣称的「multi-hop 0.93」「adversarial 0.87」都不成立。证据覆盖按三种口径算：任一命中 70.4%，真平均 62.5%，全部命中 55.6%——所以「检索已经解决」这个说法也撤回了。

### LongMemEval-S

| 协议 | 结果 |
|---|---|
| 旧 22 题 + 全量摘要时间线注入 | QA 0.55，gold session 覆盖@15 = 1.00（session 级命中不代表答案证据齐全） |
| 完整 S 500 题（2026-11-18，无时间线注入） | 62.0%：single-session-use 87.5%、multi-session 39.67%、temporal 59.06%、abstention 93.33% |

两行协议不同，差值不能叫改进。multi-session（跨会话合成）仍然是最弱的一项。

### 回归

`npm test` 跑 15 组套件：单元测试（含 reliability、来源回溯、批量防线）加 13 组 e2e（休眠、图谱、热流、任务状态机、并发领取、禁外发、隐私边界、viewer 边界）。检索实验的冻结验收记录在 [docs/phase2-acceptance.md](docs/phase2-acceptance.md)——四项消融没过预设门槛，相关实现默认关闭。

## 安装

Node.js ≥ 22.16（内置 `node:sqlite`，推荐 24+）。

### npm

```bash
npm install -g dsh-lm-memory
```

装好后把 server 挂进宿主（以 Claude Code 为例）：

```bash
claude mcp add lm_memory -s user -- node "$(npm root -g)/dsh-lm-memory/server/memory-server.mjs"
```

### Claude Code 或任意 stdio MCP 宿主（git 方式）

```bash
git clone https://github.com/hrrrb408/lm-memory.git
claude mcp add lm_memory -s user -- node /path/to/lm-memory/server/memory-server.mjs
```

### DSH

正式版 `0.19.5`（GitHub Release 附安装包；npm 同名版本同步发布）。先核对 DSH 版本满足 `>=0.2.2-rc.3 <0.3.0`；在隔离环境打开 **插件 → 添加插件**，输入 `file:` 加下载到的 `dsh-lm-memory-0.19.5.tgz` 绝对路径（Windows 例：`file:C:/LM-Test/dsh-lm-memory-0.19.5.tgz`），按宿主提示重启。包只包含插件；安装依赖可能需要联网，且插件仍需要独立 Node.js ≥22.16。不要因此同意不明构建脚本或版本兼容豁免。

0.19.5 的默认行为与 0.17.3 相同：按 Git 仓库隔离的项目记忆、用户确认结论/修复经验、事实有效日期、任务候选提示，全部需要显式开启，默认关闭，说明与限制见 `docs/project-memory.md`。

以下是已发布稳定版示例。profile 的 `package.json` 加依赖（建议用 tag 固定版本）：

```json
"dsh-lm-memory": "github:hrrrb408/lm-memory#v0.17.3"
```

`dsh.profile.bundles` 加 `"dsh-lm-memory"`，`pnpm install` 后重启 DSH。数据目录和安装位置无关，升级不动数据。

GUI 找不到可用 Node 时，将 `DSH_NODE` 设为符合上面版本要求的 Node 可执行文件绝对路径，再重启 DSH。新版启动逻辑在找不到可用 Node 时会跳过 MCP/viewer 启动并记录诊断，不会因此阻止宿主启动。

新版设置面板从 DSH 宿主读取 `viewer` 指定的本机端口（默认 `7640`），不会猜端口。若旧版 viewer 仍占用端口且无法确认进程归属，插件不会结束它；请手动停止自己启动的旧 viewer，再重启 DSH。

旧库（v0.16 表结构、hit_count 续租）启动时自动迁移：CHECK 约束重建，追加 `used_count/last_used_at` 列。旧曝光计数保留为统计，续租从零按使用反馈重新累计。

### 插件配置

```yaml
llm:
  model: glm-5.3        # 默认跟随会话模型，显式指定即接管
  # baseURL: ""         # 换供应商才需要（OpenAI 兼容）
  # apiKeyEnv: ZAI_CODING_CN_API_KEY
allowRemote: true       # false = 系统级禁外发
memoryDir: ""           # 自定义数据目录，队列/标记/任务路径跟随
refresh: true           # false = 关闭变更热流注入
extract: true           # false = 关闭自动提炼
# taskRecall:           # 实验；不配置即关闭，需显式列出测试 Session ID
#   enabled: true
#   sessionIds: [session-替换为实际ID]
```

自动候选提示与 `refresh` 变更热流相互独立。启用方式、隐私与验收边界见[任务召回指针实验](docs/task-recall-experiment.md)。

### 功能开关（设置页）

**设置 → 记忆库** 里可以开关：项目记忆、确认结论入库、允许外发提炼、任务候选提示（含授权会话 ID）。改动写入 `<memoryDir>/settings.json`，重启 DSH 生效；文件存在时以它为准，其余配置（模型、端口、数据目录）仍来自 `cordis.patch.yml`。不想用页面时二者等价，手写 YAML 仍有效。

### 项目记忆（可选）

按 Git 仓库隔离记忆，默认关闭：

```yaml
projectMemory: true      # 项目库按真实 Git 根隔离；个人库独立命名空间
confirmedOutcomes: true  # 允许「确认结论：/确认修复：」把上一轮助手原句存为项目事实/经验
allowRemote: true        # 允许项目模式投递提炼作业（默认不外发）
```

开启后工具分成 `mcp__lm_personal__memory_*`（个人通用）和 `mcp__lm_project__memory_*`（当前仓库），编号各自独立；会话首次使用时绑定，之后不可改绑；未绑定会话、子代理、非 Git 目录一律拒绝，不回退旧全局库。项目模式不启动旧 MCP、旧采集和 Viewer。

旧库不会自动迁移，个人库从空开始。需要带走历史时手动跑一次（只复制、不删除原库，可重复执行）：

```bash
# 从仓库检出运行
node scripts/migrate-to-personal.mjs --dry-run  # 只看条数
node scripts/migrate-to-personal.mjs

# 从 npm 安装的运行（脚本随包发布）
node node_modules/dsh-lm-memory/scripts/migrate-to-personal.mjs --dry-run
```

细节与已验收边界见[项目记忆](docs/project-memory.md)。

key 从环境变量或 `~/.dsh/.credentials.yaml` 同名条目读取。没有 key 时自动提炼跳过但任务保留，重试 5 次后归档到 `extraction-jobs/failed/`，检索和手动写入不受影响。内置 provider 映射：zai-coding-cn、deepseek-official、deepseek-api-key、agnes。

### 使用反馈约定

休眠续租只认 `memory_feedback`，需要在宿主指令文件（比如 AGENTS.md）里加一条约定：

> 记忆被使用且确有帮助后，调用 `memory_feedback {id, useful: true}`；自动条目的重要主张先用 `memory_source` 回查原文。入库前先 recall 查重；已有正册档案的主题只存指针；当日流水账不入库。

### 评测复现

LoCoMo runner 的凭据走 `BENCH_BASE_URL` / `BENCH_API_KEY` / `BENCH_LLM`，默认不读个人凭据；`LM_BENCH_SPLIT=development|holdout|all` 控制对话范围。其他脚本在 `scripts/eval/`，源码哈希和原始判分输出随报告留档。

## 已知边界

- 遗忘这套是使用反馈 TTL，不是验证过的遗忘模型。反馈依赖宿主如实报告；置顶全文和启动索引的使用不计入。生产库还没有 dormant 样本，误休眠率和恢复率没有数据。
- 同会话的明确纠正能自动取代（要逐字引文），跨会话矛盾还是靠冲突扫描发现、人工复核，不做自动改写；语义改写后的同文防复活不保证。
- `event_date` 是稳定的观察锚，不等于考证过的事件日。旧数据回填自创建日，会有偏差；`memory_remember` 可以显式传。
- 没有独立 holdout 上的同条件竞品对照；judge 和答题是同一个模型；bench 摄入不等于生产链路。BM25 实验有个字符类缺陷待修。
- `memory_source` 只能回查到会话内消息，跨会话的实体和主张归一没做。自动提炼的内容没有经过语义验证，用之前自己判断。
- 图谱每次写操作全量重建（数百条毫秒级，数千条要换增量方案），对答案质量的收益没有消融数据，也不参与默认召回。
- 双语嵌入只是按查询语言路由，不是跨语言召回。bge-small 的窗口约 512 token，超长记忆（500 字以上）尾部语义会丢——两条 850 字、只有尾部城市不同的文本，向量完全一样。长内容拆开存。
- 单用户单机，无同步。删除的介质级擦除和备份清理不做。viewer 图谱页不支持触摸和键盘。
- 项目记忆按物理路径识别仓库：移动或重新 clone 会变成新项目，旧库需要手工再用（迁移脚本可以拷进个人库）。项目模式不启动 Viewer，管理走工具。项目只在 macOS 上验证过，Windows 未实测（依赖硬链接做原子绑定、用 lstat 识别软链/junction，失败时一律拒绝而不是降级）。
- 自动召回是词面匹配：改述、同义、无引号的中文提问基本不会命中，命中率低是有意为之的保守取舍，不是故障。

## 常见问题

**`ERR_PNPM_IGNORED_BUILDS`**：pnpm 10+ 默认不跑依赖构建脚本，onnxruntime-node 的二进制已在 tarball 里，功能正常，可忽略。想消除警告就在 `pnpm-workspace.yaml` 加 `onlyBuiltDependencies`。

**首次启动慢**：在下载双语嵌入模型（约 56MB）到 `models/`，正常。

**没有 LLM key**：自动提炼跳过但任务保留，检索、遗忘、viewer 都正常，手动 `memory_remember` 照常用。

**macOS 跑测试被 AMFI 拦**：DSH 托管的 node 会被拦 onnxruntime 原生库，本地测试换 Homebrew node；生产由宿主拉起，不受影响。

## 开发

```bash
npm test                                # 15 组套件
node scripts/eval/locomo-run.mjs 1 5    # LoCoMo 单段冒烟（需 key 和数据文件）
node scripts/dream-dryrun.mjs           # 去重扫描（只读）
node scripts/conflict-dryrun.mjs        # 冲突扫描（只读）
```

验收记录与未完成项：[docs/hardening-acceptance.md](docs/hardening-acceptance.md)、[docs/phase2-acceptance.md](docs/phase2-acceptance.md)。下一步待验收：真实 DSH 生命周期、跨会话事实归一、长期遗忘观察、同条件竞品对照。

## License

MIT
