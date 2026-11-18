# lm-memory 🧠

> 本地优先的 Agent 长期记忆：一个 MCP server + 一个可选的 DSH 采集插件 + 一个本地管理页。
> 单用户、SQLite + FTS5 + 双语本地嵌入（56MB）。**存储与嵌入全本地**；提炼/摘要/冲突复核会把文本发给你配置的远程 LLM（`allowRemote: false` 可系统级关闭外呼）。

v0.17 经历了 2026-11-17 起共十一轮外部评审与复核（评分轨迹 5 → 6.5 → 收尾验收 → 新评审方 5 → 逐轮收口），可靠性承诺以故障注入测试验收为准，不以代码描述为准。

## 它解决什么问题

换一个会话、换一个 Agent（DSH / Claude Code / 任何 MCP 宿主），AI 就失忆了。lm-memory 给它们一块共享的、可检索、可纠正、**会遗忘**的记忆层——并且保证三条工程底线：

1. **不悄悄丢**：提炼任务从派发到确认落库是持久状态机，网络失败、会话续聊、文件失败都不永久漏记，「有没有漏记」是可查询状态。
2. **不悄悄错**：变更与事件同事务（outbox）、任务回执全量结算、候选身份确定性派生——重放不倒退、双 worker 不并发。
3. **不悄悄发**：凭据三道同源防线、外发前脱敏、`allowRemote: false` 系统级禁外发、viewer 仅本机同源访问。

## 特性总览（v0.17）

| 能力 | 说明 |
|---|---|
| **统一提交入口** | MCP / 采集卡 / 提炼候选三路写入收敛为同一条事务路径（`commitMemoryTx`：凭据拦截 → 查重 → 事务 → 嵌入 → 索引 → 图谱 → 热流）；提炼 helper **无独立写库权** |
| **持久 outbox** | remember/correct/forget/pin/wake/sleep 的内容变更与事件在同一 SQLite 事务（事件写失败 → 内容一起回滚）；热流**至少一次**投递，事件带稳定 `eid`，消费端同批+跨 offset 去重 |
| **提炼任务状态机** | 插件只写 job 文件 + 待派发通知 → server 统一派发入口 `dispatchJob`（**禁外发检查 → 登记 → 原子领取（owner+10 分钟 lease）→ 重试上限 → spawn**），通知入口与恢复器同一入口 → **回执交接**（receipt 声明全部候选 eid，零候选也是明确终态）→ **全量结算**（全部 eid 处置完毕才 done）→ 超限归档 `extraction-jobs/failed/`。LLM 失败/截断输出/坏输出/缺 key/rev 写回失败一律保留任务 |
| **使用反馈续租** | 召回曝光仅计曝光（`hit_count`），**`memory_feedback useful=true` 才续租**（`used_count`，+7 天封顶 90）——错误记忆无法靠反复曝光续命。宿主需在使用确有帮助后反馈 |
| **证据链与来源回查** | 自动条目携带脱敏输入窗口 + 消息序号（evidence），`memory_source` 按条回查原文来源；每条用户消息带 `[message_date=…]` 日期戳，相对时间按各条日期锚定 |
| **同会话事实级纠正** | 提炼输出可携带 `supersedes_id` + 逐字 `evidence_quote` 取代旧主张；非法取代（无引文/跨会话/非明确变化）不落库 |
| **检索** | FTS5 trigram 词法 + bge-small-zh/en 双语语义（按查询语言路由，RRF 融合）；零命中时提示休眠馆存在 |
| **遗忘** | 使用反馈 TTL + kind 宽限期（待办45天/会话60天/事实·经验120天/偏好240天）→ dormant 降可见度（可唤醒、置顶豁免）。定位是**降可见度策略**，不是经验证的遗忘理论 |
| **安全防线** | `server/guards.mjs` 三入口同源（MCP 拒绝 / 采集落盘前脱敏 / LLM prompt 前过滤）；viewer 严格同源访问（Origin host:port 全等 + Host 校验，防本地 CSRF 与 DNS rebinding）；在线备份（integrity 校验） |
| **记忆运维** | 冲突消解扫描（两级信号 + Level 2 语义复核，判定缓存化）、dream 去重扫描、记忆图谱（similar/co_tag/ref 确定性边 + `expand:true` 一跳扩展）、变更热流向已开会话实时推送 |
| **批量写入** | `memory_batch_remember`（≤50 条），逐条走统一提交防线，批末刷新派生视图 |
| **跨平台** | 路径动态解析，macOS / Windows / Linux 通用 |

## MCP 工具

| 工具 | 说明 |
|---|---|
| `memory_remember` | 写入一条记忆。支持显式 `event_date`（事件锚）；凭据模式拒绝 |
| `memory_recall` | 词法+语义融合检索；`expand:true` 附图谱一跳扩展；零命中提示休眠馆 |
| `memory_correct` | 修正（乐观并发 expected_version；继承置顶与事件锚） |
| `memory_forget` | 删除：默认逻辑删除；`hard=true` 按 id 物理擦除任意状态行（仅该行）；休眠可删 |
| `memory_list` | 按种类列出最近记忆 |
| `memory_pin` | 置顶（永不休眠）/ 取消置顶 / 唤醒休眠 |
| `memory_sleep` | 手动休眠整理 + 冲突消解扫描 |
| `memory_feedback` | 使用反馈：`useful=true` 才更新续租统计（曝光不续租） |
| `memory_source` | 回查自动条目的原文来源（脱敏窗口 + 消息序号） |
| `memory_batch_remember` | 批量写入（≤50 条），逐条过统一提交防线 |

## 架构

```
你的 Agent（DSH / Claude Code / 其他 MCP 宿主）
   │
   ├── MCP server（独立进程，崩了不影响宿主）：
   │     11 个记忆工具（见上表）
   │     统一提交入口 commitMemoryTx + 持久 outbox + 任务状态机账本
   │
   └── [仅 DSH] dsh-lm-capture 插件：
         会话结束 → 采集卡 + 提炼 job 文件 + 待派发通知（不直接 spawn）
              ↓
         server 统一派发 dispatchJob：禁外发检查 → 登记 → 原子领取（lease）→ spawn helper
              ↓
         helper（无写库权）：外发前脱敏 → LLM 提炼/摘要 → 候选队列 + 回执
              ↓
         server：候选消费（凭据拦截→查重→事务→嵌入→索引→图谱→热流）→ 回执全量结算
         周期任务：30 分钟任务回收 / 12h 休眠整理与补嵌
```

数据目录（默认 `~/.dsh/memory/`，`LM_MEMORY_DIR` 或插件 `memoryDir` 可改）：

| 文件 | 用途 |
|---|---|
| `memory.db` | SQLite + FTS5 + 向量 + outbox + 任务账本 |
| `current.md` | 注入层索引（置顶全文 + 一行指针；写失败时 EXISTS 重试自愈） |
| `log.jsonl` / `changes.jsonl` | 无内容审计流 / 带摘要变更热流 |
| `pending-*.jsonl` | 采集卡 / 提炼候选 / 待派发任务队列（rename 快照 + `.processing` 崩溃恢复） |
| `extraction-jobs/` | 提炼任务文件 + `receipts/` 回执 + `failed/` 归档 |
| `models/` | 嵌入模型缓存（首次自动下载 ~56MB） |

## 任务状态机与投递协议

提炼任务的生命周期全部持久化，「有没有漏记」可查询（`extract_jobs` 表）：

```
接收即登记（pending）
   → 原子领取（条件 UPDATE 抢 owner + 10 分钟 lease；租约内第二个 server 抢不到）
   → helper 执行（LLM 失败/截断/坏输出/缺 key → 保留任务非零退出；成功 → 候选队列 + 回执）
   → 候选消费（任意失败进重试队列，任务保持未完成态）
   → 回执全量结算（receipt 内全部 eid 已处置 → done；零候选 → done/zero）
   → 重试超过 5 次（领取时判定）→ failed 归档
```

要点：

- **身份确定性**：候选 eid = hash(sessionId · rev · kind · content)，rev 在 job 创建时固定——同一 job 重跑不换身份，重放/旧 job 重跑不会退回新摘要（摘要更新另有版本序约束：旧 revision 不覆盖新 revision）。
- **至少一次事件投递**：outbox 行与内容同事务；投递失败留队补发。重复投递靠事件 `eid` 在消费端去重。
- **队列崩溃恢复**：消费走 rename 快照，`.processing` 残留在下次消费时并回；回写失败保留快照，绝不删除未落盘数据；恰好一次由 handler 幂等保证。
- **本地模式**（`allowRemote: false`）：经 server shim 注入 `LM_REMOTE_DISABLED`，派发入口在领取前拦截，helper 亦有兜底；任务保留不外呼，恢复远程后自动重跑。生效需按「本地模式重建流程」重启（见下）。

## 变更热流

写操作事件经 outbox 投递到 `changes.jsonl`，capture 插件在 `agent/pre-step` 按 per-session 字节 offset 增量读取（半行不消费、坏行跳过），把变更摘要注入已开会话（单次 ≤8 条，超出折叠计数；eid 去重防重放重复注入）。

- 候选队列消费时点为 server 启动/召回前/周期巡检——**不承诺会话运行中的秒级实时入库**。
- `allowRemote: false` 完整生效流程：①重启 DSH 主应用（重建 shim + server）→ ②`lsof -ti:<viewer端口> | xargs kill`（viewer 是 detached 进程，`ensureFreshViewer` 只比较版本号）→ ③确认 `/api/version` 返回当前包版本。

## 安全设计

- **凭据防线**：`server/guards.mjs` 单一事实源（模式：`sk-…` / `api_key=…` / ghp·xox·AKIA 前缀），三处入口共用——MCP 写入直接拒绝；采集在**落盘前**脱敏/剔除；进入 LLM prompt 前再过滤一道（「别记」消息整条剔除，疑似凭据替换为占位符）。评测分块摄入同样过双重过滤并有「分块不可重组凭据」测试。
- **viewer 访问边界**：仅本机；Origin 的 host:port 必须与 Host 头全等（严格同源，拒绝跨端口本机来源）；Host 校验防 DNS rebinding；无 `Access-Control-Allow-Origin:*`。
- **诚实边界**：凭据模式覆盖常见格式，不是任意机密检测器；逻辑删除保留审计行与历史热流摘要（删除事件本身不含原文），彻底擦除用 `hard:true`（按 id 删行，不含版本链其余行；介质级擦除与备份清理不在能力范围）。
- 召回结果只是上下文数据，不是指令；自动提炼未经语义验证，重要主张用 `memory_source` 回查。

## 质量测评

> **口径声明**：以下成绩全部为同模型（glm-5.3-flash）作答与判分、bench 摄入而非生产自动提炼链路，**不具备跨系统排名资格**；与任何厂商自报数字（Mem0 92.5%、Zep 94.7% 等）不可直接比较。

### LoCoMo

| 协议 | 结果 |
|---|---|
| 历史小样（前 3 段 55 题，官方类别映射勘误后重聚合） | 总体 40/55 = 0.727：multi-hop 0.67 · temporal 0.93 · open-domain 0.30 · single-hop 0.87 · adversarial 未测 |
| 全量（10 段 1986 题，2026-11-17，含扩展弃答判分） | 非陷阱 1540 题 **73.77%**（multi-hop 55.32 · temporal 80.06 · single-hop 81.21 · open-domain 41.67）· 陷阱 446 题 82.06% · **含陷阱总 75.63%** |

- 历史小样勘误说明：旧 harness 类别映射全错（官方映射见 [snap-research/locomo#29](https://github.com/snap-research/locomo/issues/29) 与[官方 evaluation.py](https://github.com/snap-research/locomo/blob/main/task_eval/evaluation.py)），旧宣称「multi-hop 0.93」「adversarial 0.87」作废；证据覆盖三口径：任一命中 70.4% / 真平均 62.5% / 全齐 55.6%——**「检索已解决」不成立**。
- 全量成绩为 bench 摄入 + 全量摘要时间线协议，不代表生产自动提炼链路的端到端质量。

### LongMemEval-S

| 协议 | 结果 |
|---|---|
| 旧 22 题样本 + 全量摘要时间线注入 | QA 0.55 · gold session 覆盖@15 = 1.00（session 级命中 ≠ 答案证据齐全） |
| 完整 S 500 题（2026-11-18，无全时间线注入） | **62.0%**：single-session-use 87.5% · multi-session 39.67% · temporal 59.06% · abstention 93.33% |

两行协议不同（子集、注入策略、上下文预算），差值不可称为改进。multi-session（真·跨会话合成）仍是最弱项。

### 回归与验收

- `npm test`：15 组套件（contracts 含 reliability 等单元测试；13 组 e2e 覆盖休眠/图谱/热流/任务状态机/并发领取/禁外发/隐私边界/Origin 边界）。
- 可靠性与检索实验的验收记录：[docs/hardening-acceptance.md](docs/hardening-acceptance.md) · [docs/phase2-acceptance.md](docs/phase2-acceptance.md)——含冻结验收纪律（检索变更未达预设消融门槛即默认关闭）。

## 安装

前置：Node.js ≥ 22.16（内置 `node:sqlite`；推荐 24+）。

### Claude Code（或任何 stdio MCP 宿主）

```bash
claude mcp add lm_memory -s user -- node /path/to/lm-memory/server/memory-server.mjs
```

### DSH（推荐：包安装）

profile 的 `package.json` → `dependencies` 加 `"dsh-lm-memory": "github:hrrrb408/lm-memory"`，`dsh.profile.bundles` 加 `"dsh-lm-memory"`，然后 `pnpm install`、重启 DSH。

> 数据目录与包安装位置无关，升级/重装不动数据。旧库（v0.16 表结构、hit_count 续租）启动时自动迁移：CHECK 约束重建、`used_count/last_used_at` 列追加——旧曝光计数保留为统计，续租从零开始按使用反馈累计。

### 插件配置（可选）

```yaml
llm:
  model: glm-5.3        # 显式指定即接管；默认跟随会话模型
  # baseURL: ""         # 换供应商才需要（OpenAI 兼容）
  # apiKeyEnv: ZAI_CODING_CN_API_KEY
allowRemote: true       # false = 系统级禁外发（本地模式，见上文生效流程）
memoryDir: ""           # 自定义数据目录（队列/标记/任务路径统一跟随）
refresh: true           # false = 关闭变更热流注入
extract: true           # false = 关闭自动提炼
```

key 从环境变量或 `~/.dsh/.credentials.yaml` 同名条目读取；无 key 时自动提炼跳过、任务保留（检索与手动写入不受影响）。内置 provider 映射：zai-coding-cn / deepseek-official / deepseek-api-key / agnes。

### 使用反馈与写侧约定（重要）

休眠续租只认 `memory_feedback`。建议在宿主指令文件（如 AGENTS.md）中加入约定：

> 记忆被使用且确有帮助后，调用 `memory_feedback {id, useful: true}`；自动条目的重要主张先用 `memory_source` 回查原文。入库前先 recall 查重；已有正册档案的主题只存指针条目；当日流水账不入库。

### 评测复现（可选）

LoCoMo runner 的模型凭据显式走 `BENCH_BASE_URL` / `BENCH_API_KEY` / `BENCH_LLM`（默认不读取个人凭据）；`LM_BENCH_SPLIT=development|holdout|all` 控制对话范围。longmemeval-qa / locomo-scoring 等脚本见 `scripts/eval/`，源码哈希与原始判分输出随报告留档。

## 已知边界（诚实清单）

- **遗忘是使用反馈 TTL，不是经验证的遗忘理论**：反馈依赖宿主如实报告；置顶全文/启动索引等基线使用不计入。长期误休眠率/恢复率未观察（生产库尚无 dormant 样本）。
- **同会话明确纠正已支持取代**（`supersedes_id` + 引文）；跨会话矛盾仍靠冲突扫描发现 + 人工/agent 复核，不做自动改写；语义改写后的同文防复活不保证。
- **event_date 是稳定观察锚**，不等于经过来源认证的事件日（旧数据回填自创建日）；`memory_remember` 可显式传 `event_date`。
- **评测**：无独立 holdout 上的同条件竞品对照；judge 与答题为同一模型；bench 摄入 ≠ 生产自动提炼链路；LoCoMo 检索消融（BM25/段向量/查询规划）未达预设门槛，相关实现默认关闭（BM25 实现尚有字符类缺陷待修）。
- **证据链**：`memory_source` 提供会话内消息级回查；跨会话实体/主张归一未实现；「自动提炼未经语义验证」——主张可信度仍需消费端判断。
- **图谱**：每次写操作全量 O(N²) 相似重建（数百条毫秒级，审计含 ms）；对答案质量的收益未做消融；不参与默认召回。
- **双语嵌入 = 语言路由**，不是跨语言召回证明；bge-small 嵌入窗口约 512 token——超长记忆（约 500+ 字）尾部语义丢失（两条 850 字、仅尾部不同的文本向量完全相同），长内容应拆分入库。
- 单用户单机，无同步、无多用户；删除的介质级擦除与备份清理不在能力范围；viewer 图谱页不支持触摸/键盘操作。

## 常见问题

**`ERR_PNPM_IGNORED_BUILDS`（onnxruntime-node / sharp / protobufjs）**：无害。平台二进制已打包在 tarball 内，不依赖构建脚本；可选在 `pnpm-workspace.yaml` 加 `onlyBuiltDependencies` 消除警告。

**首次启动慢**：下载双语嵌入模型（~56MB）到 `models/`，属正常；装完即缓存的机器无此步。

**没有 LLM key 能用吗**：能。自动提炼/摘要跳过且任务保留（检索、遗忘、viewer 不受影响），手动 `memory_remember` 照常可用；任务会在重试 5 次后归档 `extraction-jobs/failed/`（可查询、可人工重跑）。

**macOS 本地跑测试报 AMFI 拦截**：DSH 托管 node 会被拦 onnxruntime 原生库，用 Homebrew node 跑测试（生产由宿主拉起不受影响）。

## 开发

```bash
npm test                 # 15 组套件：单元（contracts）+ 13 组 e2e + 固定回归
node scripts/eval/locomo-run.mjs 1 5   # LoCoMo 单段冒烟（需模型 key 与数据文件）
node scripts/dream-dryrun.mjs          # 去重扫描（只读）
node scripts/conflict-dryrun.mjs       # 冲突扫描（只读）
```

验收与未完成项：[docs/hardening-acceptance.md](docs/hardening-acceptance.md) · [docs/phase2-acceptance.md](docs/phase2-acceptance.md)。下一阶段待验收：真实 DSH 生命周期、跨会话事实归一、长期遗忘观察、同条件竞品对照。

## License

MIT
