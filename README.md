# lm-memory 🧠

> 本地优先的 Agent 长期记忆：一个 MCP server + 一个可选的 DSH 采集插件。
> 单用户、SQLite + FTS5 + 双语本地嵌入（56MB）：**存储与嵌入全本地**；提炼/摘要/冲突复核会把文本发给你配置的远程 LLM（插件配置 `allowRemote: false` 可完全关闭外呼）。

## 它解决什么问题

换一个会话、换一个 Agent（DSH / Claude Code / 任何 MCP 宿主），AI 就失忆了。
lm-memory 给它们一块共享的、可检索、可纠正、**会遗忘**的记忆层——不只是记住，还会新陈代谢。

## 功能总览（v0.15）

| 能力 | 说明 |
|---|---|
| **统一提交入口（v0.15）** | MCP / 采集卡 / 提炼候选三路写入收敛为同一条事务路径（`commitMemoryTx`）；提炼 helper **无独立写库权**，只产候选队列由 server 消费——凭据拦截、查重、嵌入、索引、图谱全覆盖。**持久 outbox（v0.15.1）**：变更事件与内容同事务入库，热流投递可重试补发（写失败/崩溃不丢事件）。队列带 rename 快照 + `.processing` 崩溃恢复 + 失败保留（绝不删除未落盘数据） + 坏行重试保留 |
| **外发前脱敏（v0.15）** | `server/guards.mjs` 单一事实源：会话文本在落盘/外呼前按「别记」剔除、疑似凭据替换为占位符；MCP 写入拒绝、队列消费再拦，三道同源防线。**`allowRemote: false` 系统级禁外发（v0.15.1）**：经 shim 传播到 server——自动提炼不派发、冲突复核跳过、孤儿任务保留不外呼、viewer 画像/复核降级为空（需重启使 shim/进程重建生效） |
| **事件时间锚（v0.15）** | 新增 `event_date` 列：recall 返回的 `date` 是事件锚（事件发生/观察日），唤醒/修正/休眠等管理操作不再推移它 |
| **尾部优先提炼窗口（v0.15）** | 修复「只读前 30 条 → 末尾纠正进不了上下文」：预算内从最新往回收集，头部保留背景，省略段显式标注 |
| **会话指纹二采（v0.15）** | 同 session 文本指纹变化即重新采集（修复「stop 后继续聊天的新内容不被采集」），库侧由统一入口幂等去重 |
| **写入** | 自动去重、凭据拦截（写入与外发双重脱敏） |
| **检索** | FTS5 trigram 词法 + **双语语义**（bge-small-zh/en 双模型，按查询语言路由，RRF 融合）；零命中时提示休眠馆存在（低频事实不静默消失） |
| **修正/删除** | 乐观并发（expected_version）；修正继承置顶与事件锚；默认逻辑删除 + `hard=true` 按 id 物理擦除任意状态行（active/dormant/deleted/superseded；**只删该行**，版本链其它行/队列/历史热流摘要不在范围内）；删除事件不携带被删原文 |
| **遗忘曲线** | 命中续租 TTL（命中 +7 天封顶 90，同时刷新计时起点）、kind 宽限期（待办45天/会话60天/事实·经验120天/偏好240天）、超期转 dormant 降可见度（可唤醒）、置顶豁免——这是**降可见度策略**，不是经过验证的遗忘理论（见已知边界） |
| **会话摘要卡** | 会话结束自动生成带日期的自包含摘要（跨会话联合与时间推理的原料） |
| **日期锚定** | 相对时间（昨天/上周/明天）摄入时即换算绝对日期 |
| **自动提炼** | 会话结束把用户发言蒸馏为 ≤4 条 preference/fact/procedure/todo |
| **模型跟随** | 提炼/摘要默认跟随会话所用模型；可显式配置；无 key 优雅降级为纯检索模式 |
| **变更热流（v0.10）** | 写操作追加 `changes.jsonl`（带内容摘要），capture 插件经 `agent/pre-step` 向**已开会话**实时注入记忆 delta——不再"旧会话碰壁才发现新记忆" |
| **索引注入层（v0.11）** | `current.md` 改索引形态：置顶条目全文 + 其余每条一行指针（#id 保留可定位），细节靠 `memory_recall`——注入层体积 90KB→约 20KB，对齐 Anthropic《The components of agent memory》"注入层必须小" |
| **dream 去重扫描（v0.11）** | `dream.mjs` 纯函数 + `scripts/dream-dryrun.mjs` 只读 CLI：嵌入余弦扫疑似重复对（跨 kind），人审后合并——dreaming 的库内第一步（对照 transcript 校对属后续版本） |
| **冲突消解扫描（v0.14）** | `conflict.mjs` 纯函数 + `scripts/conflict-dryrun.mjs` 只读 CLI + 随 sleep pass 自动巡检（结果经热流播报）：两级信号（取代性引用 / 相似+完结词）扫「旧条疑似已被新事实接棒」候选对——dreaming 的库内第二步。v0.14.1 起信号层跳过版本发布条；v0.14.1-0.14.3 候选对自动交提炼模型做 Level 2 语义复核（superseded/related/unrelated，判定缓存化、复核过的误报不反复播报），判定输出只进审计与热流，不自动改库 |
| **记忆图谱（v0.12）** | `edges` 边表（similar/co_tag/ref 三类确定性边，高频 tag 防 supernode）+ `recall expand:true` 一跳关联扩展 + viewer 图谱页（零依赖 SVG 力导）。思路对齐 Mem0 native Graph Memory——不做类型化关系，纯共现/相似/引用推断 |
| **viewer** | 本地管理页：搜索、版本历史、用户画像、**休眠馆**（唤醒/置顶）、命中统计 |
| **跨平台** | 路径全部动态解析（DSH_HOME/HOME），macOS / Windows / Linux 通用 |

## 记忆变更热流与会话实时推送（v0.10）

**病灶**：会话只在启动时读一次记忆快照（current.md 基线），之后记忆库的更新对它不可见——
旧会话按过时流程干活，碰壁后才发现别处已改。

**机制**（人脑式持续记忆流 + 场景触发的最小实现）：

```
memory_remember/correct/forget/pin/unpin/wake/sleep
   └─ server announce() 追加 changes.jsonl（ts/op/id/kind/content≤200字/reason）
        └─ capture 插件 agent/pre-step 瀑布（每个模型 step 前触发）
             ├─ stat 一次：无增长零成本返回
             ├─ per-session 字节 offset 增量读取（半行不消费、坏行跳过、文件轮转重置）
             └─ 有新变更 → 往本 step 消息列表尾部注入一条 user 消息
                  （source.kind=lm-memory-refresh，模型下一步立刻看到：
                    「与当前任务相关的以最新内容为准；需要全文调 memory_recall」）
```

- **注入内容**：新增/修正/删除/置顶等变更摘要（单次最多 8 条，超出折叠计数）；episode 入库与 dormant 转换只折叠提示不展开
- **幂等**：offset 随读随推，同一条变更对同一会话只注入一次；会话 dispose 清 offset
- **投递保证（v0.15.1）**：事件先入 SQLite outbox（与内容同事务），再尽力投递 changes.jsonl；投递失败留队，启动/召回/巡检/下次写入时补发——数据库已提交的变更不会因热流写失败而丢失。候选队列的消费时点为 server 启动/召回前/12h 巡检，**不承诺会话运行中的秒级实时入库**
- **基线语义**：会话首次 step 前的存量变更不推送（插件部署/会话启动前的记忆不算"新"）
- **多会话隔离**：每个会话独立 offset，A 会话的推送不影响 B
- **开关**：插件配置 `refresh: false` 一键关闭；viewer 管理页的写操作走 MCP 工具处理器，热流自动覆盖
- **viewer 旧版自动升级（v0.10）**：viewer 是 detached 进程，app 重启杀不掉——插件启动时探测 `/api/version`（缺端点或版本旧 → lsof 定位端口 pid、ps 校验命令行含 viewer.mjs 防误杀 → SIGTERM → 拉起新 viewer），否则管理页写操作会永远走旧 server、不进热流
- **验证**：`node server/refresh-e2e.mjs` 全链路 22 断言；`node server/viewer-e2e.mjs` 升级路径 5 断言（写流→读流→注入→幂等→隔离→半行→reject 透传；旧版 kill→新版拉起→不重复重启）

## 索引注入层与 dream 去重扫描（v0.11）

**依据**：Anthropic《The components of agent memory》（2026-11-06）——注入层必须小（加载不等于遵循，
Claude Code 基线 200 行/25KB 索引）；dreaming 的价值在拿原始记录校对与去重。

- **索引注入层**：`regenerateCurrentMd` 改索引形态——置顶条目全文在场，其余每条一行 `#id [日期] 32字摘要`；
  episode 依旧只可检索。实测 226 条 active 从 90KB 降到约 20KB；长条目细节用 `memory_recall(id 或关键词)` 取全文。
- **dream 去重扫描**：`server/dream.mjs` 导出 `findDuplicatePairs(db, { threshold=0.88, maxPairs=100 })`——
  对 active 且有嵌入的条目做两两余弦（嵌入写入时已 normalize，跨 kind 参与），返回相似对按分降序。
  `scripts/dream-dryrun.mjs [db路径] [--threshold=0.88]` 只读打开真库出报告（`readOnly:true`，绝不写库）；
  合并由人审后走 `memory_correct`/`memory_forget`，本版不做自动合并。
- **写侧闸门（约定层）**：入库前先 recall 查重；LifeOS 正册已有档案的主题只存指针条目；流水账不入库。
  落在宿主 AGENTS.md（服务端不强制——让模型自己判断显著性，对齐"给模型自由比死规则有效"的实验结论）。
- **验证**：`current-md-e2e.mjs` 12 断言（截断/折叠/pinned 全文/episode 排除/25KB 线）；
  `dream-e2e.mjs` 8 断言（高相似抓取/正交不误报/deleted 排除/阈值敏感/跨 kind）；
  既有 sleep 16 + refresh 22 + e2e-test 全量回归通过。

## 记忆图谱（v0.12）

**对齐**：Mem0 Graph Memory（2026 native 版）的核心洞察——图谱的价值在"提到同一实体的记忆互相能找到"，
类型化关系边（"A 管理 B"）连 Mem0 都已放弃（LLM 抽边是幻觉源）。本版只做三类**确定性信号**的边：

| 边 | 信号 | 权重 |
|---|---|---|
| `similar` | 嵌入余弦 ≥0.82（阈值低于 dream 的 0.88——这里要"相关"，不要"重复"） | cos 值 |
| `co_tag` | 低频标签共现（df 2..20 才是信号；`lifeos`×97 这种背景噪声直接出局） | 共享 tag 数 |
| `ref` | 正文显式引用同库条目（`#272` / `记忆 275` / `id=258`；「条目N」式序号会误匹配，graph-e2e 实抓后剔除） | 1 |

- **维护时机**：remember/correct/forget/pin/sleep 之后全量重建（数千条内毫秒级，先正确后增量）；每节点 maxDeg=32 防 supernode
- **检索接入**：`memory_recall` 新增 `expand: true`——返回 `{hits, related}`，related 为命中条目的一跳邻居（带 `rel(w=权重) via #锚点` 建边依据）；默认 false 不破坏原数组格式
- **viewer 图谱页**：`/api/graph` + 零依赖 SVG 力导（预跑 300 步降温出稳定布局，节点色=kind、半径=度数、边色=rel、悬停看全文、可拖拽整理）
- **验证**：`graph-e2e.mjs` 14 断言（三类边建对/高频 tag 防 supernode/写后自动重建/expand 格式/forget 后边消失/默认格式兼容）

## 冲突消解扫描（v0.14）

**病灶**：一条「会话只在启动时加载记忆」的 fact 被同日上线的变更热流解决后，过时条目在库里躺了 7 天没人发现——缺的不是取代机制（schema 有 `superseded`/`supersedes` 与 `memory_correct` 修正链），是「主动发现旧条已过时」的定期扫描。人脑睡眠巩固不只归并相似记忆，还包括消解新旧冲突。

**机制**（`conflict.mjs` 纯函数只读，随 sleep pass 自动巡检）：

```
sleep pass（工具/启动/12h 巡检三处共用）
   └─ findConflictPairs(db) 两级信号扫候选对（只读，不处置）
        ├─ supersede_signal — 语义相近（sim ≥ 0.85）+ 晚条带取代词 + 早条干净
        └─ explicit_ref    — 取代性引用（引用点 ±40 字窗口内带取代语境；纯「相关：id=N」关联不算）
             └─ 有候选 → audit("conflict_sweep") + announce 热流播报（≤3 对摘要）
```

- **处置**（人工/agent 复核后）：`memory_correct` 给旧条追加「【已过时 MM-DD】见 #新id」指针，或由新条正式接棒；教训叙事里的完结词不是状态声明，不要直接 `memory_forget`
- **CLI**：`node scripts/conflict-dryrun.mjs [--sim=0.85]` 只读出报告
- **已知边界**：候选对粗筛误报率偏高（记忆条目为高密度决策文体）——v0.14.1 起两级缓解：①信号层跳过版本发布条（版本时间线互不推翻，真库 15 对复核 14 误报中过半源于版本条互撞）；②候选对自动交默认提炼模型做 Level 2 语义复核（superseded/related/unrelated 三档），复核确认的才二次播报，无 key 优雅降级为候选对播报。判定输出只进审计与热流，不自动改库
- **验证**：`conflict-e2e.mjs` 20 断言（只读性/取代信号对/零相似引用对/双完结词不误报/deleted 排除/纯关联引用不出对/阈值独立），已收编进 `scripts/test.mjs` 主套件

## 架构

```
你的 Agent（DSH / Claude Code / 其他 MCP 宿主）
   │
   ├── MCP 工具（独立进程，崩了不影响宿主）：
   │     memory_remember   写入（统一提交入口）
   │     memory_recall     词法+语义融合检索（带命中埋点；零命中提示休眠馆）
   │     memory_correct    修正（乐观并发，继承置顶/事件锚）
   │     memory_forget     删除（默认逻辑，hard=true 物理擦除；休眠可删）
   │     memory_list       列出
   │     memory_pin        置顶（永不休眠）/ 唤醒
   │     memory_sleep      手动触发一轮休眠整理
   │
   └── [仅 DSH] dsh-lm-capture 插件：
         会话结束 → episode 索引卡 + LLM 原子提炼 + 带日期摘要卡
         （外发前脱敏；提炼模型默认跟随会话模型；无 key 自动降级；allowRemote:false 可关外呼）
              ↓ 候选队列 pending-*.jsonl（helper 无独立写库权）
         server 统一提交入口：启动/召回前消费（凭据拦截→查重→事务→嵌入→索引→图谱→热流）
         + 每 12h 巡检（队列消化 + 休眠整理 + 向量补嵌）
```

数据全部落在 `~/.dsh/memory/`（可用 `LM_MEMORY_DIR` 改）：
`memory.db`（SQLite+FTS5+向量）、`current.md`（自动生成基线）、`log.jsonl`（审计）、`changes.jsonl`（变更热流）、`pending-*.jsonl`（采集卡/提炼候选队列，统一提交入口消费，带崩溃恢复）、`models/`（嵌入模型缓存，首次自动下载）。

## 安装

### 前置

Node.js ≥ 22.5（内置 `node:sqlite`；推荐 24+）。任何平台。

### Claude Code（或任何 stdio MCP 宿主）

```bash
claude mcp add lm_memory -s user -- node /path/to/lm-memory/server/memory-server.mjs
```

### DSH（推荐：包安装）

profile 的 `package.json` → `dependencies` 加：

```json
"dsh-lm-memory": "github:hrrrb408/lm-memory"
```

`dsh.profile.bundles` 加 `"dsh-lm-memory"`，然后 `pnpm install`，重启 DSH。一条依赖搞定 server + 插件 + 依赖（`.pnpm` 结构自动解析 server 的 import）。

> 数据目录 `~/.dsh/memory/` 与包安装位置无关，升级/重装不动数据。

### 提炼模型配置（可选）

默认**跟随会话模型**（会话用什么模型，提炼就用什么）。显式接管：

```yaml
# 插件 patch 的 config 块
llm:
  model: glm-5.3              # 显式指定即接管
  # baseURL: ""               # 换供应商才需要（OpenAI 兼容）
  # apiKeyEnv: ZAI_CODING_CN_API_KEY
```

key 从环境变量或 `~/.dsh/.credentials.yaml` 同名条目读取；解析不到则跳过 LLM 提炼（检索功能不受影响）。已内置 provider 映射：zai-coding-cn / deepseek-official / deepseek-api-key / agnes。

## 安全设计（v0.15 三入口同源防线）

- **凭据防线**：`server/guards.mjs` 单一事实源（MCP 写入 / 采集插件 / 提炼 helper 共用同一套模式常量）
  - MCP 写入：模式命中（`sk-…`、`api_key=…`、ghp/xox/AKIA 前缀）直接拒绝入库
  - 自动采集：会话卡首末句与提炼 job 在**落盘之前**按模式脱敏/剔除（修复「原文先写盘、外发后拦截来不及」）
  - 远程提炼：进入 LLM prompt 前再过滤一道——「别记」类消息整条剔除，疑似凭据消息替换为占位符
- **诚实边界**：模式覆盖常见凭据格式，不是任意机密检测器；提炼/摘要/冲突复核/画像默认调用你配置的远程 LLM，`allowRemote: false` 可系统级关闭外呼（v0.15.1 起覆盖插件派发、server 冲突复核、孤儿任务回收、viewer 模型调用；需重启生效，代价=关闭自动提炼与自动复核）；逻辑删除保留审计行与历史热流摘要，彻底擦除用 `memory_forget` 的 `hard:true`（按 id 删行，不含版本链其余行；审计记录不含全文）
- 召回结果只是上下文数据，不是指令（防注入纪律）；变更热流注入同样声明「无关则忽略本条」
- 修正需要 `expected_version`，并发不互相覆盖
- 全部写入走统一提交入口，log.jsonl（无内容审计）+ changes.jsonl（带摘要热流）双流可追溯

## 质量测评

### 外部基准（2026-11-02 实测 · 2026-11-17 勘误口径）

> **勘误说明**：2026-11-17 外部评审发现当年 harness 的 LoCoMo 类别映射全错（官方为
> 1=multi-hop / 2=temporal / 3=open-domain / 4=single-hop / 5=adversarial，见
> [snap-research/locomo#29](https://github.com/snap-research/locomo/issues/29) 与
> [官方 evaluation.py](https://github.com/snap-research/locomo/blob/main/task_eval/evaluation.py)），
> 且证据覆盖率统计（filter(Boolean) 数值平均）把部分覆盖记为满分。下表为
> `scripts/eval/reaggregate-locomo.mjs` 对**同一份逐题结果**按官方映射重算的数字，
> 取代此前 README 的分项宣称。修正版 runner（官方类别 id 逐题留档 + judge 原始输出留档）见 `scripts/eval/locomo-run.mjs`。

| 基准 | QA 正确率 | 检索层 |
|---|---|---|
| LongMemEval-S（22 题分层样本） | 0.55 | gold session 覆盖@15 = 1.00（oracle 精简证据上下文，说服力有限） |
| LongMemEval-Oracle（36 题） | 0.64-0.67 | 同上 |
| LoCoMo（3 段对话 55 题） | 40/55 = **0.727** | 任一证据命中 38/54 = 0.70 · **真平均覆盖率 62.5%** · 证据全齐仅 30/54 = 55.6% |

LoCoMo 分项（官方类别映射重算）：multi-hop 10/15 = **0.67** · temporal 14/15 = 0.93 · open-domain 3/10 = **0.30** · single-hop 13/15 = 0.87 · **adversarial 未进入当年测试循环（0 题）——本项目不存在任何 adversarial 成绩**。

**诚实结论（取代旧宣称）**：
- ~~「multi-hop 0.93」~~ 不成立——那是时间题（temporal）的成绩；「0.20→0.93 多跳跃升」叙事作废
- ~~「检索已解决，瓶颈在答题模型」~~ 不成立——session 级命中 ≠ 答案证据齐全（真平均证据覆盖 62.5%）
- 0.73 **无跨系统排名资格**：数据子集、类别分布、judge、答题模型、上下文预算均与他人不同（Mem0 自报 [92.5%](https://mem0.ai/research) 属厂商口径，不可直接相减）
- bench 与生产链路不同：bench 喂全量对话 turns + 全量摘要时间线；生产采集只收用户发言（尾部优先窗口 8000 字）——bench 分数不代表生产端到端质量
- 日期锚定等读时工程与摘要/top-k/judge 同期共变，未做单变量消融；同模型自答自判，评判偏差未测

方法论沉淀（`docs/memory-protocol.md` 与提交历史，仍有效）：
- 逐题验尸分型（检索缺证据 / 证据在手拼接失败 / 相对时间未锚定）
- 判分协议先验数据分布再选模板（一起判分协议 bug 曾制造 0.07 的假弱项）
- 弱模型自查"细节是否存在"会系统性过度弃答（试验失败已回滚）

### 回归测试

```bash
cd server && npm install
node sleep-e2e.mjs       # 休眠/唤醒/置顶生命周期 16 项断言
node e2e-test.mjs        # 写入/去重/拦截/检索/修正/删除
LM_MEMORY_DIR=/tmp/lm-eval node recall-eval.mjs   # 三档召回基准
```

注意：本地跑测试/评测需用无 library validation 的 node（如 Homebrew 版）；DSH 托管 node 在 macOS 上会被 AMFI 拦 onnxruntime 原生库（生产环境由宿主拉起不受影响）。

### 历史基线（演进过程）

- v0.3 纯词法：LongMemEval_S 证据召回 0.87@5（500 题全量）
- v0.5 中文语义：语义改写 0.50 → 0.88@5（自产 32 查询集）
- v0.8 英文语义：英文 0.80 → 1.00@5（10 对改写集）
- v0.9 读时工程：LoCoMo 总分 0.20 → 0.73（摘要时间线+日期锚定提示+判分口径多项同期改动，未做单变量消融；分项类别名 2026-11-17 已按官方映射勘误）
- 闭环对照（30 题）：无记忆 0% vs 记忆注入 40%

## 常见问题

### 安装时出现 `ERR_PNPM_IGNORED_BUILDS`（onnxruntime-node / sharp / protobufjs）

**无害，可以忽略。** pnpm 10+ 出于供应链安全默认不执行依赖的构建脚本。这三个包被拦后功能正常：

- `onnxruntime-node`：平台原生二进制直接打包在 npm tarball 里，不依赖安装脚本（实测 macOS arm64 原生加速正常）
- `sharp` / `protobufjs`：文本嵌入用不到，无影响

想让警告消失（可选），在 profile 的 `pnpm-workspace.yaml` 加：

```yaml
onlyBuiltDependencies:
  - onnxruntime-node
  - protobufjs
  - sharp
```

### 首次使用很慢 / 卡在下载

首次启动会下载双语嵌入模型（~56MB）到数据目录的 `models/`，属正常。装完即缓存的机器没有这一步。

### 没有 LLM key 能用吗

能。不配 key 时自动提炼/摘要跳过（不影响检索、遗忘曲线、viewer），手动 `memory_remember` 照常可用。

## 已知边界（2026-11-17 外部评审+复核后的诚实清单）

- **重新采集不等于纠正已入库事实**：同会话续聊产生的候选与早前候选会并存（精确查重只拦同文）；会话摘要卡已改为同事务 supersede 更新，事实级的「后条取代前条」依赖 v0.14 冲突扫描发现 + 人工/agent 复核，不做自动改写
- **event_date 是稳定观察锚，不等于经过来源认证的事件日**：旧数据回填自创建日（可能与真实事件日有偏差）；`memory_remember` 可显式传 `event_date`
- **遗忘是命中续租 TTL，不是经验证的遗忘理论**：返回即计命中（不区分是否真被使用），命中同时刷新计时起点——错误记忆可被反复曝光长期续命；置顶全文/启动索引等基线使用不计入命中。长期误休眠率/恢复率未测，因此休眠定位为**可唤醒的降可见度策略**（零命中时召回会提示休眠馆存在，缓解发现死角）
- **评测可信度**：历史成绩含开发集反复调优成分，无独立 holdout；真 adversarial 能力未实测（runner 已修：cat5 走 adversarial_answer 进循环，官方弃答口径与本 runner 的 LLM judge 口径不混用）；judge 与答题为同一模型；无同条件竞品对照（评测工具链见 `scripts/eval/`，守卫为 realpath 级）
- **证据链**：auto-extract 记忆只有会话级来源标签（`session:X`），未定位到具体消息 span；「候选摘要直接升为事实」暂缺原文回查接口
- **图谱**：每次写操作全量 O(N²) 相似重建（数百条实测毫秒级，`rebuild_edges` 审计含 ms 可观测；数千条后需增量方案）；图谱对答案质量的收益未做消融
- **双列嵌入 = 语言路由**，不是跨语言召回证明（英文查询中文记忆的可靠性未测）
- LongMemEval multi-session（真·跨会话合成）仍弱
- 单用户单机，无同步、无多用户；首次使用需联网下载嵌入模型（~56MB）
- viewer 图谱页不支持触摸拖拽/键盘访问（本地管理工具，桌面鼠标优先）
- 硬删除/逻辑删除的介质级擦除与备份清理不在能力范围内

## 开发

```bash
cd server && npm install
node sleep-e2e.mjs && node e2e-test.mjs
```

## License

MIT
