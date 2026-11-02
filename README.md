# lm-memory 🧠

> 本地优先的 Agent 长期记忆：一个 MCP server + 一个可选的 DSH 采集插件。
> 单用户、SQLite + FTS5 + 双语本地嵌入（56MB），数据永远在你自己机器上。

## 它解决什么问题

换一个会话、换一个 Agent（DSH / Claude Code / 任何 MCP 宿主），AI 就失忆了。
lm-memory 给它们一块共享的、可检索、可纠正、**会遗忘**的记忆层——不只是记住，还会新陈代谢。

## 功能总览（v0.9）

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
| **viewer** | 本地管理页：搜索、版本历史、用户画像、**休眠馆**（唤醒/置顶）、命中统计 |
| **跨平台** | 路径全部动态解析（DSH_HOME/HOME），macOS / Windows / Linux 通用 |

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
