# lm-memory 🧠

> 本地优先的 Agent 长期记忆：一个 MCP server + 一个可选的 DSH 采集插件。
> 单用户、SQLite + FTS5 + 双语本地嵌入（56MB），数据永远在你自己机器上。

## 它解决什么问题

换一个会话、换一个 Agent（DSH / Claude Code / 任何 MCP 宿主），AI 就失忆了。
lm-memory 给它们一块共享的、可检索、可纠正、**会遗忘**的记忆层——不只是记住，还会新陈代谢。

## 功能总览（v0.11）

| 能力 | 说明 |
|---|---|
| **写入** | 自动去重、凭据拦截（key/token 永不入库） |
| **检索** | FTS5 trigram 词法 + **双语语义**（bge-small-zh/en 双模型，按查询语言路由，RRF 融合） |
| **修正/删除** | 乐观并发（expected_version）、逻辑删除、全程审计 |
| **遗忘曲线** | 召回命中延期、按 kind 宽限期（待办45天/会话60天/事实·经验120天/偏好240天）、超期休眠（dormant，可唤醒）、置顶豁免 |
| **会话摘要卡** | 会话结束自动生成带日期的自包含摘要（跨会话联合与时间推理的原料） |
| **日期锚定** | 相对时间（昨天/上周/明天）摄入时即换算绝对日期 |
| **自动提炼** | 会话结束把用户发言蒸馏为 ≤4 条 preference/fact/procedure/todo |
| **模型跟随** | 提炼/摘要默认跟随会话所用模型；可显式配置；无 key 优雅降级为纯检索模式 |
| **变更热流（v0.10）** | 写操作追加 `changes.jsonl`（带内容摘要），capture 插件经 `agent/pre-step` 向**已开会话**实时注入记忆 delta——不再"旧会话碰壁才发现新记忆" |
| **索引注入层（v0.11）** | `current.md` 改索引形态：置顶条目全文 + 其余每条一行指针（#id 保留可定位），细节靠 `memory_recall`——注入层体积 90KB→约 20KB，对齐 Anthropic《The components of agent memory》"注入层必须小" |
| **dream 去重扫描（v0.11）** | `dream.mjs` 纯函数 + `scripts/dream-dryrun.mjs` 只读 CLI：嵌入余弦扫疑似重复对（跨 kind），人审后合并——dreaming 的库内第一步（对照 transcript 校对属后续版本） |
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

## 架构

```
你的 Agent（DSH / Claude Code / 其他 MCP 宿主）
   │
   ├── MCP 工具（独立进程，崩了不影响宿主）：
   │     memory_remember   写入
   │     memory_recall     词法+语义融合检索（带命中埋点）
   │     memory_correct    修正（乐观并发）
   │     memory_forget     逻辑删除
   │     memory_list       列出
   │     memory_pin        置顶（永不休眠）/ 唤醒
   │     memory_sleep      手动触发一轮休眠整理
   │
   └── [仅 DSH] dsh-lm-capture 插件：
         会话结束 → episode 索引 + LLM 原子提炼 + 带日期摘要卡
         （提炼模型默认跟随会话模型；无 key 自动降级）
              ↓
         server 端：启动 + 每 12h 巡检（休眠整理 + 向量补嵌）
```

数据全部落在 `~/.dsh/memory/`（可用 `LM_MEMORY_DIR` 改）：
`memory.db`（SQLite+FTS5+向量）、`current.md`（自动生成基线）、`log.jsonl`（审计）、`models/`（嵌入模型缓存，首次自动下载）。

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

## 安全设计

- 凭据永不入库：写入时按模式拦截（`sk-…`、`api_key=…`、长随机串）
- 召回结果只是上下文数据，不是指令（防注入纪律）
- 修正需要 `expected_version`，并发不互相覆盖
- 删除/休眠均为可逆状态，审计日志全程保留

## 质量测评（全部可复现）

### 外部基准（2026-11 实测，glm-5.3-flash 作答与判分）

| 基准 | QA 正确率 | 检索层 |
|---|---|---|
| LongMemEval-S（22 题分层样本） | 0.55 | 证据会话召回@15 = **1.00** |
| LongMemEval-Oracle（36 题） | 0.64-0.67 | **1.00** |
| LoCoMo（3 段对话 55 题） | **0.73** | turn 召回 0.74 |

LoCoMo 分项：multi-hop **0.93**（日期锚定后）、adversarial 0.87、single-hop 0.67。检索层用 56MB 本地双模型即达满分证据会话召回；QA 层差距主要在答题模型（glm-flash）与跨会话合成。

方法论沉淀（`docs/memory-protocol.md` 与提交历史）：
- 逐题验尸分型（检索缺证据 / 证据在手拼接失败 / 相对时间未锚定）——80% 的"multi-hop 失败"是日期算术而非检索
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
- v0.9 读时工程：LoCoMo 总分 0.20 → 0.73（摘要时间线 + 日期锚定 + 判分修正）
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

## 已知边界

- LongMemEval multi-session（真·跨会话合成）仍弱——瓶颈在答题端而非检索
- 单用户单机，无同步、无多用户
- 首次使用需联网下载嵌入模型（~56MB）

## 开发

```bash
cd server && npm install
node sleep-e2e.mjs && node e2e-test.mjs
```

## License

MIT
