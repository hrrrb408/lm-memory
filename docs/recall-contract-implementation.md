# 召回契约修复交付报告（2026-11-11）

代码与本地回归已完成，维持版本 0.13.0，未发布、未打 tag。第六项交付了固定脱敏场景集与质量门禁，但**原始真实问题的逐字来源尚未认证**，不能宣称已经交付经溯源核验的生产真实问题集。

依据：先读取 `/tmp/codex-lm-eval.md` 第六节第二项与第二节问题说明，再逐处阅读 server、图谱、插件注入与既有评测源码。修改前工作区干净，未发现适用的 AGENTS.md。没有操作 `~/.dsh/memory` 数据或生产模型缓存，没有修改 viewer 实现/部署。

## 分步提交

| 提交 | 文件 | 改动点 | 验证 |
|---|---|---|---|
| 941f1a6 | server/memory-server.mjs；tests/helpers.mjs；tests/recall-contract.test.mjs | id 与 query=#id 精确取全文，参数互斥，默认生命周期边界 | ID 全文、缺失 ID、kind 不符、deleted/superseded/dormant 默认排除 |
| 93fcc11 | server/memory-server.mjs；tests/mock-embeddings.mjs；契约测试 | 语义扫描与图谱关联同样过滤 kind | 确定性嵌入替身通过真实 MCP 分支验证，含无匹配类型 |
| 9744481 | server/recall-utils.mjs；server/memory-server.mjs；工具/契约测试 | 全文+模型+角色+查询前缀 SHA-256 缓存身份 | 400 字同前缀不同尾部，双语言入库向量不同；身份隔离单测 |
| c1d08fe | server/recall-utils.mjs；server/memory-server.mjs；工具测试 | RRF 缺席排名贡献零，存在排名仍按 1/(60+1+rank) | 词法独有/语义独有对称、双命中相加、双缺席零分 |
| c804940 | server/memory-server.mjs；server/recall-utils.mjs；plugin/lib/index.js；docs/memory-protocol.md；测试 | scope=active/dormant/all；候选频率使用相同 kind/scope；搜索与启动/热流注入硬预算 | dormant 词法/语义/ID、状态标识、不唤醒/延寿；UTF-8/行预算，全文指针绕过搜索预算 |
| 9b85dc1 | scripts/eval/recall-{metrics,regression}.mjs；scripts/test.mjs；tests/fixtures/*；新增预算/指标测试；package.json；server/recall-eval.mjs | 30 条脱敏记忆、37 题、证据分组、冻结 hash/质量基线、全套测试入口；禁用嵌入时旧评测不再空等 90 秒 | 11 个新增测试通过；固定集指标门禁通过；完整现有套件通过 |

## 接口与预算

- `memory_recall({id:123})` 或 `{query:'#123'}` 取全文；与自然语言 query 互斥。
- kind 对所有召回分支生效。默认 active；显式 dormant/all 才可发现休眠记录，永不暴露 deleted/superseded。
- dormant 读取不自动唤醒，不修改其 hit_count/last_hit_at/updated_at；唤醒仍使用 memory_pin wake。图谱尚仅有 active-active 边，dormant 不扩展。
- 搜索 JSON 默认 16KiB，允许 512–65536 字节；整条裁剪，不截正文。超预算返回 hits/related/budget 对象，标明省略量；原数组格式在预算内保持。按 ID 读取绕过搜索预算。
- current.md 限 25KiB / 200 行，置顶段优先且补上 #id。超额整行省略并提示按需查询；热流限 8KiB / 40 行。被搜索预算省略的候选不累计命中。
- 预算是 UTF-8 字节限额，不是模型 token 估算。新版大结果对象格式需要调用方按协议处理。

## 验证结果

在干净代码提交 `9b85dc10f03273e83613479464730c49535e7a05` 上执行 `npm test`，Node v26.12.0 / macOS。测试入口为每个脚本创建独立临时库；viewer-e2e 只启动/停止随机端口上的测试 viewer，与生产部署隔离。

| 测试 | 结果 |
|---|---|
| 新增契约、缓存、融合、预算、指标测试 | 11 passed / 0 failed |
| sleep-e2e | 16 passed / 0 failed |
| dream-e2e | 8 passed / 0 failed |
| graph-e2e | 14 passed / 0 failed |
| current-md-e2e | 12 passed / 0 failed |
| refresh-e2e | 22 passed / 0 failed |
| viewer-e2e（临时实例） | 5 passed / 0 failed |
| e2e-test | exit 0，旧脚本以打印观察值为主 |
| recall-eval（纯词法） | exit 0；zhHard@5=0.50、zhEasy@5=0.75、en@5=0.80、traps=0/3；旧脚本不设质量失败门槛 |
| 固定回归集 | exit 0；语料 hash 一致，聚合指标未低于冻结基线 |

6 个既有显式断言套件合计 77 项通过；新增 11 项通过。`git diff --check` 通过。真实嵌入不参与本轮完整套件；语义契约测试采用确定性替身，不算真实模型质量证据。

固定集共 37 题，31 道有证据、6 道无答案，包含 5 道多证据题。每个 k 各跑一遍，计 74 次 MCP 召回。必要证据按完整正文逐组检查，不能以单条命中替代证据齐全。

| 指标 | k=1 | k=5 |
|---|---:|---:|
| Hit@k | 21/31，67.74% | 24/31，77.42% |
| 证据完整率 | 16/31，51.61% | 23/31，74.19% |
| 必要证据组覆盖率 | 21/37，56.76% | 29/37，78.38% |
| 无关条目/返回条目（误召回率） | 5/26，19.23% | 17/49，34.69% |
| 无答案误触发率 | 0/6 | 0/6 |
| 延迟 p50 / p95 / max（ms） | 0.661 / 1.083 / 1.265 | 0.629 / 1.063 / 1.277 |

延迟包含 MCP 往返与序列化，不含进程启动、播种；本次无嵌入，不能外推真实双模型延迟或大库性能。误召回依赖人工 relevant_ids 的完整性，组合题的全部证据门槛与普通题的替代证据已分开标注。

证据文件：[逐题指标与环境](evidence/recall-regression-2026-11-11.json)、[完整套件摘要](evidence/recall-suite-2026-11-11.json)、[语料来源与指标说明](../tests/fixtures/README.md)。摘要保留本次临时原始日志路径；逐题报告保存在仓库中。

复跑：`npm test`；单独回归：`npm run test:recall`。真实模型试跑入口：`LM_EMBED_CACHE=<独立测试缓存> node scripts/eval/recall-regression.mjs --semantic`，不得指向生产目录。

## 未尽事项

1. **真实问题溯源 NOT_PROVEN。** 既有集没有原始逐字对话，不能认证成“真实用户问题原话”。已完成脱敏与来源标识，并主动征询新增真实失败问题；后续需用经确认的脱敏真实失败问题补充版本化语料、复审 gold，再冻结新基线。没有读生产数据来填这个缺口。
2. **真实双模型质量/延迟 NOT_RUN。** 本轮仅证明纯词法固定集和确定性语义契约；双模型实测、真实宿主会话注入与长期休眠收益仍需独立隔离验收。
3. **端到端答案正确率 NOT_RUN。** 已保留报告字段，不以检索命中冒充答案正确。用户本轮列出的四类检索指标均有实现；原评估报告另提到的答题模型闭环留待单独验证。
4. **语义阈值未调。** 语义独立召回的 ≥0.55 且领先第二名 ≥0.03 规则保持；多相关候选可能整体被拒绝，需要真实语义固定集与消融实验再校准。
5. **质量仍有提升空间。** k=5 的 34.69% 条目误召回率与未齐全的多证据题是已记录缺口；冻结基线用于防退化，不代表质量已达标。尚无大样本/跨机器延迟阈值。
6. **历史向量未重建。** 缓存修复保护新计算，不证明历史向量从未受旧缓存碰撞影响；若需重嵌，必须另行规划生产数据操作，本次没有执行。
7. **独立范围。** 统一写入/outbox、提炼证据与隐私分流、并发修正、热流超过 8 条的逐项补投等仍属于其他改进。未顺带改动。
