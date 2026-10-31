# lm-memory 🧠

> 本地优先的 Agent 长期记忆：一个 MCP server + 一个可选的 DSH 采集插件 + 两个指令文件片段。
> 单用户、零原生依赖、SQLite + FTS5，数据永远在你自己机器上。

## 它解决什么问题

换一个会话、换一个 Agent（DSH / Claude Code / 任何 MCP 宿主），AI 就失忆了。
lm-memory 给它们一块共享的、可检索、可纠正、可删除的记忆层。

## 架构

```
你的 Agent（DSH / Claude Code / 其他 MCP 宿主）
   │
   ├── 基线注入：AGENTS.md / CLAUDE.md 片段（会话开始时自动读记忆索引）
   │
   ├── MCP 工具（独立进程，崩了不影响宿主）：
   │     memory_remember   写入（自动去重、拦截凭据）
   │     memory_recall     三级检索：FTS5 trigram → LIKE 逐词 → 中文滑窗
   │     memory_correct    修正（乐观并发，expected_version）
   │     memory_forget     逻辑删除（不再召回，保留审计）
   │     memory_list       列出
   │
   └── [仅 DSH] dsh-lm-capture 插件（进程内，极薄）：
         会话结束 → 提炼「真实用户输入」为一条 episode → 队列 → server 幂等入库
```

数据全部落在 `~/.lm-memory/`（可用 `LM_MEMORY_DIR` 改）：
`memory.db`（SQLite+FTS5）、`current.md`（自动生成的基线索引）、`log.jsonl`（审计）。

## 安装

### 前置

Node.js ≥ 22.5（内置 `node:sqlite`；推荐 24+）。

### Claude Code（或任何支持 stdio MCP 的宿主）

```bash
# 从 npm（发布后）
claude mcp add lm_memory -s user -- npx -y lm-memory-server

# 或直接从本仓库运行
claude mcp add lm_memory -s user -- node /path/to/lm-memory/server/memory-server.mjs
```

然后把 `templates/CLAUDE-snippet.md` 的内容追加到 `~/.claude/CLAUDE.md`。

### DSH（DeepSeek Harness）

1. 安装插件与 server（本地路径或你自己的发布源）：

```bash
dsh plugin --profile <你的profile> add /path/to/lm-memory/plugin/dsh-lm-capture
```

2. 在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: mcp-lm-memory
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: lm_memory
        transport: stdio
        command: node
        args:
          - /path/to/lm-memory/server/memory-server.mjs
    - id: lm-capture
      name: dsh-lm-capture
      config:
        minUserMessages: 2
```

3. 把 `templates/AGENTS-snippet.md` 内容放进 `~/.dsh/AGENTS.md`，重启 DSH。

### 从旧文件记忆迁移

如果你以前用 Markdown 文件记记忆：

```bash
node scripts/import-current-md.mjs ~/.dsh/memory/current.md
```

## 安全设计

- 凭据永不入库：写入时按模式拦截（`sk-…`、`api_key=…`、长随机串）
- 召回结果只是上下文数据，不是指令（防提示词注入的基本纪律）
- 修正需要 `expected_version`，并发不互相覆盖
- 删除是逻辑删除：不可见、不可检索，但审计日志保留操作记录
- 自动采集只提取 `source.kind === 'user'` 的真实输入，排除系统注入

## 已知限制（v0.3）

- 提取靠 Agent 判断 + 会话索引，没有 LLM 自动总结
- 纯词法检索（FTS5 trigram），没有向量/语义
- 单用户单机，没有同步、没有多用户

## 开发

```bash
cd server && npm install
node e2e-test.mjs     # 端到端：写入/去重/拦截/检索/修正/删除
```

## License

MIT

## 质量测评（自产数据）

`scripts/eval/` 内置一套可复现的质量测评：30 条真实语境记忆 + 32 个查询（关键词/语义改写/时间状态/干扰区分/空结果陷阱/知识更新六类），指标为 Recall@1/@5、MRR、误召回率。

```bash
cd server && node ../scripts/eval/run-eval.mjs
```

v0.3.1 当前成绩（详见 `scripts/eval/eval-report.json`）：

| 指标 | 数值 |
|---|---|
| Recall@5 | 0.73 |
| MRR | 0.65 |
| 误召回率（无答案查询） | 0% |
| 知识更新（修正/新检索/旧版不复活） | 3/3 |

已知边界：零词汇重叠的语义改写（如「芯片」→「M4 Pro」）和时间推理（「最近」）超出词法检索能力，是引入向量检索（规划中）的动机。检索管线：FTS 短语 → 词元展开打分（IDF 停用 + 稀有词豁免 + 命中阈值）→ 二元组滑窗 → LIKE 兜底。
