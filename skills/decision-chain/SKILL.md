---
name: decision-chain
description: 结对决策审计的纪律：何时用 decision_add 记录关键决策、决策链格式、里程碑用 /pair-audit 触发审计。主会话（writer）侧配合 decision-auditor 审计者的规约。
---

# 决策链纪律（Decision Chain Discipline）

你与一个只读代码的结对审计者（`decision-auditor`）共同工作。它负责从对话日志捕获决策入链并审计决策推理链（默认 `.pi/decision-auditor/chain.md`，设 `PI_PAIR_CHAIN_PUBLIC=1` 时写 `docs/decisions/chain.md`），不写代码。你的职责是配合它，让链保持可审计。

## 何时必须记录决策（用 `decision_add`）

出现以下任一情况即追加一条（不要攒到里程碑才记——审计者靠增量定位新决策）：

- 从**多个方案中做了取舍**（选了 A 弃 B，有实际否决理由）
- 决定了**架构/依赖/实现方式**（引入库、改数据流、选模式）
- 采纳了**用户的关键要求**（会影响后续方向的拍板）
- 修正/推翻**之前的一条决策**（用 `supersedes` 声明旧 id）

**不记**：命名、格式、单文件内实现细节、已有决策的自然延伸。

## subagent 决策必须转述（v1.0.48）

派发 subagent（writer / reviewer / 并行任务）后，把它的**决策性选择**（方案取舍、架构决定、被采纳的审查建议）转述进你的最终回复或 `decision_add` 的 Context，并标注来源（如「来源: subagent writer run-xxx」）——subagent 的输出不进 convlog，审计者只能靠你的转述捕获它做的决策。不转述 = 该决策在证明链上消失。

## 泛化路径复用（v1.0.48c，开工前查）

方案取舍前，用 grep 查两处历史，避免重复踩主 agent 曾没想到的盲区：

- `.pi/decision-auditor/audit-log.md`（public 模式 `docs/decisions/audit-log.md`）的 `### 泛化发现` section——审计者每轮沉淀的「主 agent 没想到的候选路径」（一行一条：场景 | 路径 | 来源）
- `chain.md` 的 `Alternatives` 字段——被否决过的方案及其理由

命中相关场景 → 主动考虑该路径（采纳与否决策时在 Context 里引用它，形成闭环）；未命中 → 正常推进。这是 AI 检索（grep/read），无独立工具。

## 记录的推理链格式（`decision_add` 参数）

`Context` 必须只含**可验证事实**（带数字/来源），这是审计者校验推理有效性的锚点：

```
summary:      采用 Redis 做读缓存
context:      读多写少，QPS 峰值 2k；Postgres 读路径 60ms（压测记录）
decision:     引入 Redis 缓存读路径
rationale:    缓存命中时读路径 <5ms；写路径用失效策略保一致性
alternatives: Memcached（否决：功能少）；本地内存（否决：不可跨实例）
confidence:   high            # Context 有数据支撑才可 high
supersedes:   []              # 推翻旧决策时填旧 id
```

注意：`rationale` 必须能被 `context` 推出；写不出时先补 context 数据，别硬编理由。

## 里程碑触发审计

- 每完成一个**里程碑**（一组相关改动落地、测试绿）：`/pair-audit`
- 只看增量：`/pair-audit D-003`（自 D-003 起审计）
- 连带产物忠实性：`/pair-audit --diff`（审计者会对照 git diff）
- 审计是 async：启动后继续干活，报告回来再处理发现

## 用户输入触发词（v1.0.85，扩展层机械判定，词表写死）

用户消息里的显式意图词会被自动处理（不需要斜杠命令），优先级 **取消 > 豁免 > 请求**（同轮多条命中取最高，保守不触发）。词表是**写死数组**（子串匹配）——裸「审计」「audit」不触发（可能是「审计日志/audit log」名词语境），漏触发补一句「帮我审计」即可：

| 意图 | 触发词（写死词表） | 处理 |
| --- | --- | --- |
| 请求审计 | 帮我审 / 帮我审计 / 审一下 / 审一审 / 审计一下 / 审计这个 / 审计我的 / 审计本轮 / 审计本次 / pair audit / audit my / audit the / audit this | 本轮结束强制审计（等价 `/pair-audit` 无参数） |
| 豁免本轮 | 不用审 / 别审 / 跳过审计 / 不审计 / 先不审 / 不用审计 / 免审 / 无需审计 / 不用再审 / skip audit / no audit | 本轮不自动审计（单轮语义；未覆盖提交下轮自然补审） |
| 取消在跑 | 取消审计 / 停掉审计 / 停止审计 / 终止审计 / 别审了 / cancel audit / stop audit | 立即 stop 在跑审计 + 本轮豁免 |

注意：豁免/取消是**单轮**语义——下轮没说「不用审」就恢复正常自动审计。误触发可观察可取消（会 notify，说「取消审计」即可）。

## 收到审计结论消息（`pi-pair-audit-findings`，v1.0.85）

审计完成且有缺口时，扩展会以 **customType 系统消息**（`pi-pair-audit-findings`，display:false + triggerTurn）唤醒你立即处理——**这是系统审计报告，不是用户消息**：

- **立即处理**：审计缺口 = 交付缺陷，优先修复（细化精度闭环：修 → 提交 → 下轮自动再审）
- **汇报**：处理结果在回复中说明（「审计发现 N 个缺口：已修复 / 未修复原因」），不要引用成「按用户要求」
- **可打断**：用户说「别修了」→ 停止，正常响应用户请求

## 对话持久化（v1.0.85，知情 + 控制）

每轮对话（用户消息 + 助手回复）会 append 到 `.pi/decision-auditor/convlog.md`（1MB 滚动）供审计者当证据源。**设置 `PI_PAIR_CONVLOG=0` 可关闭**——关闭后审计者的对话上下文随之缺失（审计质量下降）。

系统会在你开始新一轮工作时，若检测到**上一轮有未签名的工作**，注入一条 `pi-pair:audit-phase` 阶段提醒（`customType` 标记，**不是用户消息，优先级低于用户请求**）。收到后：

1. **用户请求优先**：先处理用户请求，不要因审计提醒延迟或拒绝用户
2. **自审计**（低成本，2 分钟内）：在处理请求的同时/之后，对照决策链与任务目标，检查上一轮产物是否忠实、有无明显错误、有无该记而没记的决策
3. **交叉审计**：spawn `pi-pair.decision-auditor` 独立审查上一轮产物与决策链增量（fresh context，不依赖你的判断）
4. **签名**：审计通过 → 用 write 更新 `.pi/decision-auditor/state.json` 的 `signature` 为 `{ "status": "passed" }`，并推进 `signatureConvLine`；审计发现问题 → 修复或补录决策（supersede）

**签名语义**：`signature.status` 为 `passed` 表示上一轮工作已通过审计；`blocked` 表示有未解决的 blocker。审计是提醒不是门禁——来不及可在后续轮次补审，但尽量在每次回复完成前完成签名。

## 处理审计发现

| 审计判定 | 你的动作 |
| --- | --- |
| 一致 ✓ | 继续 |
| 偏离 ✗ | 修复产物，或追加新决策 supersede 旧决策（决策改了，不是产物错） |
| 需裁决 ⚠ | 审计者会 `contact_supervisor` 问你；有真实上下文就补给它，需要用户拍板就转给用户 |

## 审计者问你了（contact_supervisor 进来时）

- `interview_request`：它要**真实上下文**（压测数字、依赖约束）——直接给事实，别给推理。
- `need_decision`：它发现**链矛盾**——裁决保留哪个，或转用户。

## 原则

1. **append-only**：旧决策绝不修改，修订 = 新条目 + supersede
2. **Context 是事实，Rationale 是推理**：两者混写 = 审计者会标记推理无效
3. **不为了好看写 Confidence**：无数据 = low/medium，审计者校准这一条
