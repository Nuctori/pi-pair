# Changelog

## [1.0.86] - 2026-08-24

两处审计可靠性修复（行为级测试锁定）：

- **过程结对审计完全不触发（回归，high）**：v1.0.85 #3 给「未提交改动」触发分支加了 `toolsThisRound > 0` 门槛（本轮有代码工具调用才 spawn），但扩展在 `pi.on("tool_call")` 上计数 `roundToolCalls`——宿主 `_emitExtensionEvent` 从不向扩展转发 `tool_call` 事件，监听器永不触发 → `roundToolCalls` 恒 0 → 未提交改动轮的过程审计永不满足门槛，只有 commit 轮（hasNewCommit）照常触发。修复：监听改 `tool_execution_start`（宿主实际转发、同样带 `toolName`）。机制完整性盲区⑥通过。
- **≥30KB 审计日志正文静默丢失（#1，high）**：审计者未落盘完整报告时，扩展 `backfillAuditLogIfNeeded` 原只写「扩展补写元数据条目」空壳（≥30KB 豁免路径），推理正文永久丢失。修复分层：① 新增确定性 `audit_report_append` 工具（扩展原子写 + mtime 乐观锁，正文绝不丢失），审计者报告经该工具落盘，删除「≥30KB 豁免、用 write 全量重建 audit-log」指令（agent SKILL 同步）；② `backfillAuditLogIfNeeded` 兜底不再写空壳——用 state.auditFindings + 真实 blockers 重建正文（auditFindings 占位过滤 + blockers 去重），审计者被强杀时仍能补回正文。历史空壳条目不回溯改写（幂等早返回，不破坏既有证明链）。
- 验证：102/102 通过（+1 #1 body 重建断言 + #3 守卫事件名同步），tsc 0。

## [1.0.85] - 2026-08-16

用户视角审查（7 条不友好行为全修，测试驱动闭环——接线守卫断言期望行为后实现）：

- **审计结论不再伪装用户消息（#1，high）**：blocked 交付从 `sendUserMessage(deliverAs:"followUp")`（user 形态 → agent 误以为用户指令、回复「按你的要求修复了」）改为 `pi.sendMessage({ customType: "pi-pair-audit-findings" }, { triggerTurn: true, deliverAs: "followUp" })`——系统消息形态唤醒 agent **立即处理**（审计缺口 = 交付缺陷，细化精度闭环），但 agent 知道这是审计报告非用户话语（SKILL 声明处理规则）。
- **闲聊轮不烧审计（#3，medium）**：`hasUncommittedChanges` 单独不再触发 spawn（历史脏工作区 ≠ 本轮有工作）——加 `tool_call` 事件计数（edit/write/bash 等代码类工具），本轮没动手不 spawn。D-006 零 spawn 语义从「纯咨询」扩展到「没动手」。
- **findings 弹窗节流（#4，low）**：观察器同轮审计只 notify 首条真实 findings，后续由呼吸灯「已发现 N 项」计数承接（此前审计者快速产出时逐条弹窗刷屏）。
- **失败必通知（#5，medium）**：三条失败路径统一 notify「审计未完成（原因）——下轮补审或 /pair-audit」：① spawn 失败无提交轮（此前静默）② run 异常终止无签名（此前静默，只留下轮惊悚注入）③ 门禁超时降级（此前完全静默）。
- **触发词写死词表（#6）**：宽松正则全部干掉，改固定数组（REQUEST_WORDS/SKIP_WORDS/CANCEL_WORDS，子串匹配）——裸「审计」/裸 "audit" 不再触发（名词语境误触发面），只认明确请求组合（帮我审/审一下/审计一下/审计这个/审计我的/pair audit/audit my|the|this）。
- **对话落盘知情 + 控制（#7）**：convlog 持久化默认保留（审计者证据源），加 `PI_PAIR_CONVLOG=0` 关闭开关；SKILL 声明。
- **多实例 warning 去重（#8）**：每 root 每会话只弹一次（nonGitRootWarned 模式），纯聊天轮不再每轮弹技术性警告。
- 验证：101/101 通过（+1 接线守卫 + 触发词测试收紧），tsc 0。

## [1.0.84] - 2026-08-16

用户报障「审计者明显 subagent 错误后呼吸灯依旧常亮（4387s ≈ 73min）」——run 失败但灯不灭（F-15）：

- **审计者 run 异常终止后呼吸灯常亮（medium，F-15）**：run 失败（崩溃/provider 报错）时 `state.inFlight` 残留 true，三条灭灯通道全失效：① async-complete 事件丢失或 runId 匹配失败（spawn 存的是 `runId ?? asyncId` 单值，事件 payload 字段互缺 → `completedCwd=null`）；② 事件内 TTL 兜底只在事件到达那一刻执行一次（事件早到、TTL 未过期 → 之后无触发源）；③ agent_end deadAuditor 需 stopRun 成功才灭灯。修复：findingsObserverTick（唯一与灯同生命周期、事件无关的 20s 常驻轮询）增加 TTL 超龄灭灯兜底（16min 判定 run 已死，与既有 TTL 语义一致）→ 删内存条目 + 停观察 + 灭灯，run 回收留给 agent_end/session_shutdown 既有通道；async-complete 匹配加固双 id（runId/asyncId 任一命中）。测试：接线守卫新增断言。
- **用户输入触发词（新功能）**：`before_agent_start` 读 `event.prompt` 机械分类（lib 纯函数 `classifyAuditTrigger`，行为级测试锁定）：**请求**（审一下/帮我审/审计/pair audit 等）→ 本轮 agent_end 强制 spawn（等价 /pair-audit 无参数）；**豁免**（不用审/别审/跳过审计/skip audit 等）→ 本轮 agent_end 跳过自动审计（单轮语义，未覆盖提交下轮自然补审）；**取消**（取消审计/停掉审计/别审了/cancel audit 等）→ 异步 stop 在跑审计 + 本轮豁免。优先级 cancel > skip > request（同轮多条命中取最高，保守不触发）。信号会话级置位/消费/清零（FP #3 模式）。测试：+5 触发词行为测试。
- 验证：100/100 通过（+5 触发词测试 + 接线守卫），tsc 0。

## [1.0.83] - 2026-08-16

## [1.0.82] - 2026-08-15

5 轮独立 subagent 对抗性审计第 5 轮（注入/签名/杂项，reviewer fresh 只读）——5 轮审计全部完成：

- **at=0 签名跨 run 撞去重键（medium）**：B5 兜底路径（审计者手写漏 at → 消毒为 0）下 `injectedAt === sig.at` 的 0===0 恒真 → 第二条 at=0 签名的 blockers 永不注入（结论静默吞）。修复：lib 去重仅 at>0 参与 + 扩展全部落盘点（持久化 ×4 + 内存 map ×4 + async-complete ×1）`?? Date.now()` 改 `|| Date.now()`（`??` 对非空 number 是死代码，at=0 原样落盘）。测试：R5-F1。
- **缺 runId 签名靠时钟容差劫持门禁（medium）**：兼容路径（auditRunId 在、sig.runId 缺）无身份可校验，LC-06 的 5min 容差把前轮残留签名（5min 内完成）误满足本轮完成判定 → 未审提交被旧结论放行。修复：缺 runId 时主路径与 B5 分支均严格比较（不容差），身份可校验才享容差。测试：R5-F2（前轮 60s 签名不放行）。
- **auditStartedAt=0 无条件清锁（low）**：年龄守卫短路为不过滤 → inFlight=true + 年龄未知（LLM 覆盖写丢字段/legacy）→ 活锁被清 → 并发双审计。修复：0 视为过新（不清）；陈旧锁由 resetForSessionStart 兜底。测试：R5-F3 + 既有测试契约更新。
- **负 convExtractedLine 恒真触发（low）**：clamp 只钳上界，负值（损坏 state）→ hasNewConversation 恒真 → 纯咨询轮每轮 spawn。修复：同时钳下界到 0。测试：R5-F4。
- **appendGeneralization 字段含 ` | ` 错位分裂（low）**：FINDING_RE 贪心解析下字段含 ` | 来源: ` 等分隔符词组 → path/场景被污染（frequentPaths 聚合失真）。修复：写入侧剥离竖线（标签字段语义无损）。测试：R5-F5。
- **B5 兜底分支无时钟容差（low）**：at=0 + lastAuditAt 严格比较，与主路径 LC-06 容差不一致 → 跨主机慢钟假超时 → 300s 降级覆盖真实 blocked 结论。修复：身份可校验时 B5 同享容差（随 F2 的 grace 重构一并实现）。测试：R5-F6。
- 验证：95/95 通过（+6 R5 测试 + 1 契约更新），tsc 0。

## [1.0.81] - 2026-08-15

5 轮独立 subagent 对抗性审计第 4 轮（convlog 路径，reviewer fresh 只读）：

- **trim 后游标错位 → 未提取尾部永久漏审（high）**：trim 删除已覆盖行后对话行重编号，convExtractedLine 原地不动 → 审计者从新游标起读，D-023 保留的未提取尾部落在游标之前 → 内容保留却永不提取（决策性消息静默漏审）。修复：截断后函数式 patch 重映射游标（减 dropped，基于最新值换算，审计者并发推进同样适用）。测试：500 消息 + 游标 350 → trim 后游标 = 旧 350 的新位置、尾部 150 条全保留。
- **trim 直接用未钳制游标当对话行下标（medium）**：审计者写文件行号单位（B2 实证失败模式）时，游标 < 实际对话数 → 未读行被当已覆盖删除（D-023 硬违反）。修复：有效游标 = 前 rawCursor 个文件行内的对话行数（文件行号单位时精确、对话行单位时保守少删多留，最多重复读无丢失）。测试：500 消息 + 游标 150（文件行号）→ 消息 76..149 全保留。
- **appendConv 800 截断劈开 surrogate pair（low）**：slice 边界孤立高代理被 appendFileSync 编码为 U+FFFD（emoji 静默损坏——实测确认 appendFileSync 替换、writeFileSync 保留 WTF-8 的行为差异）。修复：截断先剥离尾部孤立高代理再补省略号。测试：799a+😀 无替换符。
- **readConvTail/readProcess 截断边界劈开代理对（low）**：slice(-maxChars) 起点可落在低代理（高代理在省略区）→ 返回串含孤立代理。修复：头部剥离尾部高代理、尾部剥离起始低代理。测试：直写 "🚀a"×4000+"a" → 无孤立代理。
- **裸 \r / U+2028/U+2029 视觉注入（low）**：单行化只处理 \r?\n——审计者 read 工具按通用换行渲染，消息内裸 \r 可伪造 `## 👤 用户:` 行（注入面）。修复：`[\r\u2028\u2029]` 一并单行化。测试：三形态注入行单行化。
- **convlogForeignRuns 的 Task: 子串匹配（low）**：整行子串匹配使并发实例真实消息任意位置含 "Task:" 即被豁免 → 多实例守卫失效。修复：收紧为 `^## 👤 用户: Task:` 内容前缀（对齐注释意图）。测试：含 Task: 子串的真实消息计数。
- **trim mtime 复校验窗口（low）**：复校验在 tmp 写前，写→rename 窗口他实例 append 被覆盖丢行。修复：rename 紧前二次复校验（FAT 粗粒度 mtime 不变仍漏检属文件系统极限，注释明示）。
- **F8 判定为非问题**：「游标严重滞后时每次 append 全量重写」误诊——`keep.length === dialog.length` 早退不重写，仅 O(file) 读；未提取尾部 ≥512KB 时不截断是 D-023 与 1MB 上限的固有张力（D-023 优先，正确行为）。
- 验证：89/89 通过（+6 R4 测试），tsc 0。

## [1.0.80] - 2026-08-15

5 轮独立 subagent 对抗性审计第 3 轮（state 机，reviewer fresh 只读）：

- **sweepAtomicWrites 清掉可解析备份（medium）**：只保留最新 1 份 .corrupt-*，而最新一份按构造是刚 rename 的损坏文件（大概率不可解析）→ 可解析旧备份被清 → 下次损坏重建无进度来源（LC-09 失效，进度归零）。修复：保留最新 2 份（有界）。测试：R3-F1 + T3 契约更新。
- **读侧自愈覆盖有效文件（medium）**：readAuditState 首读瞬时失败（EBUSY/竞态半程）→ 重读已完整 → tryRecoverAuditState 仍走 ② 用陈旧 .corrupt 备份覆盖有效文件（锁复活/进度回退）。修复：入口先解析当前 raw，可解析则直接返回不写盘。瞬时窗口不可确定性注入，测试缺（同 R1-F7 类），文档化。
- **损坏重建吞 blockedStreak 清零补丁（low）**：非默认值过滤只豁免 inFlight/auditFindings/lastError——recordSignature 的 blockedStreak:0（passed 清零）0 === DEFAULT 被过滤 → 备份旧 streak 存活 → A2 门禁误触发。修复：blockedStreak 加入总是覆盖列表。测试：R3-F3。
- **resetForSessionStart 违反 F-01 函数式重派生（low）**：auditDead 在 patch 前用早读快照计算，间隙他写者获取新锁时陈旧 inFlight:false 清掉新鲜锁 → 双实例并发 spawn。修复：改 `(latest) => ...` 函数式。并发语义不可注入，测试缺，文档化。
- **state.json 缺失但备份存在时进度归零（low）**：`if (existsSync)` / `if (backup)` 门跳过 .corrupt-* 扫描——SIGKILL 落在 rename 窗口（损坏文件已移走、新文件未落盘）或备份 rename 失败时，存量可解析备份的进度整体归零。修复：备份块重构——rename 仅在文件存在时执行，候选扫描无条件运行。测试：R3-F5（缺失 + 备份存在 → gatedHead 恢复、patch 字段优先）。
- **非法 signature.status 通过消毒（low）**：只查 `!== undefined`，LLM 写垃圾 status（数字/拼写错误）→ isAuditCompleted 视非 failed 为完成 → 门禁误开 + blockers 静默丢失。修复：status 必须在 4 合法值内，否则签名丢弃（fail-closed）。测试：R3-F6（status: 42 → signature null）。
- 验证：83/83 通过（+4 R3 测试 + T3 契约更新），tsc 0。

## [1.0.79] - 2026-08-15

5 轮独立 subagent 对抗性审计第 2 轮（audit-log/backfill/clamp/queryGaps 路径，reviewer fresh 只读）：

- **readRawAuditLog/readAuditLog 吞非 ENOENT 读错误（high）**：R1-F1 同源缺陷仍在 audit-log 路径——catch-all 把 EBUSY/EIO 当缺失 → before_agent_start 轮询读到 [] → shouldBackfillAuditLog 恒真 → appendAuditReport 按空日志编号、rename 覆盖整条证明链（mtime 复校验通过、verify 通过）。修复：readRawAuditLog（仅 ENOENT 视为头）、readAuditLog（仅 ENOENT 返回 []）、appendGeneralization 读（孪生，仅 ENOENT 视为空）其余抛错。测试：EISDIR 实证 ×2 + ENOENT 不回归。
- **appendAuditReport/appendGeneralization expectedMtime=null 跳过复校验（medium）**：R1-F7 同型守卫仍在两处。修复：去掉 null 守卫（与 R1-F7 同理由，瞬时 stat 失败不可注入，文档化）。
- **正文 `## AUDIT-` 引用行 → 幻影条目 + 写失败（medium）**：审计者正文引用旧条目 id（`## AUDIT-<digits>:` 行）→ 解析侧按条目头分裂幻影条目（queryGaps latest 变垃圾）+ 写后「末尾条目」校验被幻影顶掉 → 3 次重试仍失败、证明链空洞且文件被重复污染。修复：写入侧把正文中匹配条目头的行转义为 HTML 注释（内容保留）。测试：引用行写成功、解析 1 条、行首不再匹配条目头。
- **appendAuditReport/appendGeneralization 截断劈开 surrogate pair（low）**：R1-F6 同型（clean 无代理对保护）。修复 + 测试（奇数偏移 blockers）。
- **queryGaps NaN 日期比较（low）**：手写/损坏日期 `new Date().getTime()` = NaN，`NaN > x` 恒 false → 静默视为已审（缺口被吞）。修复：不可解析日期保守报未审（宁多报不隐藏）。测试：垃圾日期必现于 unreviewedDecisions。
- **backfill 条目 Date 用补写时刻（low）**：掩盖签名 at 与补写之间的新决策（误判已审）。修复：`appendAuditReport(..., new Date(sig.at))`。测试：补写条目 date = 签名 at。
- **runId 与 head 均空 → 每轮重复补写（low）**：git 失败 + 无 auditRunId 时匹配分支全死 → shouldBackfillAuditLog 恒真 → audit-log 无界增长。修复：无可锚定身份时返回 false。测试：两次调用不增长。
- **F7 判定为非问题**：recentFindings 被 gaps.md 主导是设计（gaps.md v1.0.60 起为 canonical 源，audit-log findings 为迁移前兼容数据），不修。
- 验证：79/79 通过（+7 R2 测试），tsc 0。

## [1.0.78] - 2026-08-15

5 轮独立 subagent 对抗性审计第 1 轮（chain 追加/解析路径，reviewer fresh 只读）：

- **readRaw 吞非 ENOENT 读错误（high）**：catch-all 把 EBUSY/EIO/EISDIR 当缺失 → append 按空链编号 D-001、rename 静默覆盖整条旧链（三重防线全失效：mtime 复校验通过、写后 verify 通过、末尾条目校验通过）。修复：仅 ENOENT 视为空链，其余抛错。测试：chain.md 换同名目录（EISDIR 实证）→ 读错误直接外抛而非笼统「并发冲突」。
- **supersedes 元素未消毒（high）**：其余字段全过 cleanField，唯独 supersedes.join(", ") 原样写入 → `\n## D-099: fake [Accepted]` 注入伪条目。修复：元素逐个单行化+截断。测试：注入负载落盘后不得解析出 D-099。
- **畸形条目导致 id 复用（medium）**：parseChain 宽容丢弃畸形条目（缺 `]`/裸 CR）→ nextId 复用文本中已有 id → 落盘双 D-004。修复：编号改从原文 `D-(\d+)` 扫描（含畸形条目文本，跳号无害碰撞致命）。测试：D-003+D-004(畸形) 追加 → D-005。
- **summary 含 `[` 解析错位（medium）**：惰性 `(.+?)` 在首个 `[` 停下、贪婪 status 吞到末个 `]` → 中文摘要「增加 [分页] 支持」解析为摘要「增加」+ status「分页] 支持 [Accepted」。修复：ENTRY_RE 改贪婪 + status 取 `[^\]]+`。
- **resolveProjectRoot 取最远祖先（low）**：注释「取最近」实际 best 被每个带标记祖先覆盖 → monorepo 子包串到外层根。修复：命中即 break。测试：嵌套 package.json/Cargo.toml。
- **cleanField 截断劈开 surrogate pair（low）**：slice(0,max) 按 UTF-16 码元切 → 尾部孤立高代理；Node utf8 按 WTF-8 往返保留（非 U+FFFD 替换）→ 文件含非法 Unicode 标量。修复：截断后剥离尾部孤立高代理。测试：奇数偏移 emoji 摘要无残留代理。
- **expectedMtime=null 跳过复校验（low）**：去掉 `expectedMtime !== null &&` 守卫，复校验无条件执行（需捕获+复校验两次 stat 都失败才漏检）。无确定性测试：瞬时 stat 失败无法注入（node:fs ESM 命名空间静态快照，Module 命名空间 [[Set]] 一律拒绝，mock.method/赋值均不可见——probe 实证），文档化守护。
- **附带**：测试文件补 AuditState/AuditSignature 类型导入（潜伏类型错误）；既有「乐观锁重试」测试标注假阳性（其 fsModule 打桩从未生效，断言在无冲突路径碰巧通过，重试路径实际零覆盖）。
- 验证：72/72 通过（+6 R1 测试），tsc 0。

## [1.0.77] - 2026-08-15

reviewer 终审 Medium 处理：

- **L2 prompt 补轻量退出前置守卫**（reviewer Medium-1，D-052 先例）：DELIVERY_ANGLES 全维度 prompt 缺 v1.0.74 前置守卫（空 --since 窗口不豁免 + 兜底对照 + 全部提交 git show）——M1 根因（轻量退出跳过兜底 = 系统性漏审）在 L2 交付门禁路径可复发。修复：L2 低价值窗口段补同一守卫句（与 L1 同构）。
- **clamp 函数式重派生**（reviewer Medium-2）：已在 v1.0.76 闭环（`(latest) => ...` 锁内重读重判，防旧快照覆盖并发签名）。
- **空洞回填完成**（reviewer Medium-3）：v1.0.75（0db08b4）/ style（b41d6e4）手工回填——audit-log 28 条，61→76 窗口全覆盖。
- Low（injected* 被清 null）记录：审计者收尾 write 覆盖去重标记（协议已有"原样保留"强化，v1.0.25）——影响低（head 匹配把关新鲜度），下轮审计者协议重申。
- 验证：66/66 通过，tsc 0。

## [1.0.76] - 2026-08-15

reviewer 终审 Medium-Note/Low 处理：

- **空洞回填**（reviewer Medium-Note）：v1.0.73（1731fac）/ v1.0.74（120316c）手工回填——audit-log 26 条，61→75 窗口全覆盖（audit-log 46KB ≥30KB 豁免 + 运行时扩展版本滞后，backfill 未触发，同 algeff v1.0.47 部署滞后模式）。
- **clamp 改函数式重派生 patch**（reviewer Low）：对象 patch 用早读快照 sig，与审计者并发签名撞 mtime 时重试仍用旧字段覆盖新签名——改 `(latest) => ...` 函数式（v1.0.28 F-01 模式），锁获取点读最新 state 合并，最新快照非未来则放弃。
- 验证：66/66 通过，tsc 0。

## [1.0.75] - 2026-08-15

reviewer/审计者 Note 处理（clampFutureSignatureAt 测试与守卫锁定）：

- **clampFutureSignatureAt 单测**（reviewer/审计者 Note①）：4 场景——未来 at（+10min 实证形态）钳制为当前并落盘 / 容差内（+2min）不钳制 / 无签名 noop / 缺 at noop——阈值语义锁定（5min 容差）。
- **接线守卫断言**（审计者 Note②）：before_agent_start 必须接线 clampFutureSignatureAt。
- **D-078 入链**（decision_add）：未来签名 at 钳制决策（钳制 vs 拒绝 vs 仅协议，采纳钳制双保险）。
- Note③（lastAuditAt 与钳制后 at 语义分离）记录：钳制只改 signature.at，lastAuditAt 保留审计者原值——下轮审计窗口起点优先用钳制后 at，语义自洽。
- 验证：66/66 通过（+1 clamp 测试），tsc 0。

## [1.0.74] - 2026-08-15

reviewer 三路终审 M1/M2 根因修复（系统性漏审路径）：

- **未来签名 at 钳制**（reviewer M2 根因）：审计者 LLM 写 at 时手动换算 epoch 常错 +10~11min（本地/UTC 混淆实证）→ 下轮审计 `--since=at` 窗口起点未来 → 窗口恒空 → 覆盖完全依赖兜底交叉对照（M1 实证兜底可被轻量退出跳过）→ **系统性漏审路径**。修复：`clampFutureSignatureAt`（lib，at 超未来 5min → 钳制为当前时间落盘 + warn），before_agent_start 每轮起点接线（审计者 spawn 前读到修正值）。
- **轻量退出前置守卫**（reviewer M1）：判定'仅文档/格式'前必须完成兜底交叉对照（空 --since 窗口不豁免）+ 窗口内全部提交 git show 确认——空窗口 + HEAD≠head 时默认走兜底；对照结果写 auditFindings。
- **at 写法协议强化**（M2 根因）：任务文本 + agent 协议——at 必须写当前 epoch ms（Date.now() 语义），禁止从可读时间手动换算。
- **空洞回填**（reviewer N1/N2）：v1.0.70（ef4c295）/ v1.0.71（3469809，blocked 含 blockers）/ v1.0.72（3951be6）手工回填——audit-log 24 条，"61→70 全覆盖"表述修正。
- **D-077 入链**（reviewer 三路 Low）：D-075/D-076 refines D-072 声明（引用完整性补全）。
- 验证：65/65 通过，tsc 0。

## [1.0.73] - 2026-08-15

reviewer 终审 Medium（泄漏型幂等回归——存在性检查与写入侧 blockers 不同源）：

- **同源 blockers**（reviewer Medium）：存在性检查传 `sig.blockers ?? []`（泄漏签名=空）而写入侧 v1.0.68 兜底从 auditFindings 派生（非空）→ blocked 无 blockers 签名首次补写后，`normalizedBlockers(派生) === normalizedBlockers([])` 恒不等 → before_agent_start 每 turn 重复补写、audit-log 无界增长（v1.0.61 同型污染）。修复：兜底计算移到存在性检查**之前**，检查与写入共用同一派生值（v1.0.72 对称原则的延伸）。测试⑥空 findings 恰好掩盖的盲区已补（findings 非空泄漏型场景 + 幂等断言）。
- **D-076 入链**（decision_add）：存在性检查与写入侧同源 blockers。
- 测试：泄漏型幂等场景（findings 派生 + 重复调用不补），65/65 通过，tsc 0。

## [1.0.72] - 2026-08-15

审计者 blocker（v1.0.71 blockersKey 与写入侧 clean 不对称——多空白重复补写）：

- **判定 key 与写入侧对称**（审计者 blocker）：v1.0.71 的 `JSON.stringify(sort)` 比较原始文本，但 appendAuditReport 落盘时 blockers 经 `clean(join(" | "), 1000)`（压缩空白+截断）——多空白/超长 blocker 补写后恒不等 → 每轮重复补写（v1.0.61 同型污染）。修复：`normalizedBlockers` = join → clean → split → sort → JSON，比较基于落盘形式（v1.0.70~71 两版 key 变换均为非对称缺陷的终结）。
- **D-075 入链**（decision_add）：判定 key 与写入侧 clean 对称决策。
- 测试：多空白对称场景（条目 clean 后 vs sig 原始多空白 → 相等不补），65/65 通过，tsc 0。

## [1.0.71] - 2026-08-15

reviewer 终审 Low 处理（blockers 比较健壮性）：

- **blockersKey 顺序无关 + 分隔符安全**（reviewer Low）：`" | "` join 比较顺序敏感（不同来源顺序不同 → 误判新结论重复补写）且分隔符冲突（sig blocker 文本含 `" | "` 时撞 key → 真实新结论被抑制，lossy 方向）。修复：`JSON.stringify([...b].sort())`——顺序无关，JSON 不拆分含分隔符文本。
- **空洞回填**（reviewer Note）：v1.0.68（118789d）/ v1.0.69（38b11f8）/ style（9efe91b，low-value）手工回填——audit-log 21 条，61→70 窗口全覆盖。
- 测试：blockers 顺序无关 + 分隔符安全 2 场景，65/65 通过，tsc 0。

## [1.0.70] - 2026-08-15

reviewer 终审 Medium/Low 处理（补写判定终态的判别维度补全）：

- **blockers 判别**（reviewer Medium）：同 head 同 verdict 但 blockers 不同 = 新结论（修复轮 HEAD 未变时两轮均 blocked 但缺口演进）→ 必须补写——纯 verdict 判定吞掉次轮 → audit-log 停留 stale blockers、unclosedBlockers 双源漂移。修复：blocked 场景存在性匹配增加 blockers 内容比较。
- **low-value 视为 passed 已记录**（reviewer Low）：轻量退出写 low-value 条目 + passed 签名，纯 verdict 比较会对已记录窗口重复补写冗余条目 → `verdictMatched` 兼容。
- **D-074 入链**（reviewer Low）：refines D-072——存在性判定含 verdict + blockers + low-value 判别（引用完整性）。
- **测试补全**（reviewer Note-5）：空 head 守卫直接测试 + 同 head 异 blockers 补写 + low-value 幂等——shouldBackfillAuditLog 9 场景。
- **blockers 兜底时间窗限制**（reviewer Low-4）：注释/CHANGELOG 如实标注——兜底依赖 auditFindings 存活窗口（新审计锁获取清零），best-effort，主防线是协议必填强化。
- 验证：65/65 通过，tsc 0。

## [1.0.69] - 2026-08-15

reviewer 终审 Medium（同 head 双轮塌缩——存在性检查对 v1.0.65 的回归）：

- **verdict 判别**（reviewer Medium）：runId 恒空环境退化为纯 head 匹配后，同 head 的次轮结论（修复轮 HEAD 未变：blocked→passed）被存在性检查吞掉——passed 结论永久丢失 / blocked 条目 stale → unclosedBlockers 假阳性。修复：存在性判定 = head 匹配 **且 verdict 相同** 才视为已记录；同 head 异 verdict 必须补写（新结论）。真实日志 3 条连续同 head c01c4ef 证明同 head 多轮是修复轮常态。
- **D-073 入链**（reviewer Low）：supersedes D-067/D-068——补写判定终态 = 存在性 + verdict 判别（引用完整性）。
- **Medium-2 确认已闭环**：v1.0.65（4c8b68c）条目 v1.0.68 已回填（audit-log 18 条，61→67 全覆盖）。
- 测试：shouldBackfillAuditLog 7 场景（含同 head 异 verdict 补写 / 同 head 同 verdict 幂等），65/65 通过，tsc 0。

## [1.0.68] - 2026-08-15

reviewer 双路终审 Medium/Low 处理：

- **blocked 无 blockers 兜底**（reviewer Medium-1）：v1.0.66 审计者 blocked 签名漏写 blockers 字段（只活在瞬时 auditFindings）→ 机器通道（修复轮守卫/价值注入/补写条目）全失效。修复双管：① 扩展 `backfillAuditLogIfNeeded` blocked 无 blockers 时从 auditFindings 过滤占位兜底；② 任务文本 + agent 协议强化「blockers 必填非空」（v1.0.66 实证）。
- **空 head 毒化守卫**（reviewer Low-4）：`shouldBackfillAuditLog` headMatch 空串 `startsWith("")` 恒真 → 空 head 条目匹配任意签名抑制补写。修复：`!!h &&` 守卫。
- **空洞回填**（reviewer Medium-2/Note）：v1.0.65（4c8b68c）/ v1.0.66（91b2ed8，blocked 含 blockers）/ v1.0.67（66eead5）手工回填——audit-log 18 条，61→67 窗口全覆盖。
- **CHANGELOG 补 [1.0.67] 段**（reviewer Low）：v1.0.67 发布漏写 changelog 条目（约定违例）。
- 验证：65/65 通过，tsc 0。

## [1.0.67] - 2026-08-15

- 删旧 JSDoc 残留（审计者 Low：v1.0.63 注释描述废弃 Date 判定，与 v1.0.66 存在性检查注释叠放）+ biome 格式化；version bump 1.0.67（含 tag 修正 force update——首推 tag 指向未 bump 提交，npm publish 拒绝后修正）。

## [1.0.66] - 2026-08-15

reviewer Medium 根因修复（v1.0.65 门方案永久丢弃上轮待补条目）——补写判定三代理缺陷终结：

- **补写判定重构为存在性检查**（D-072）：shouldBackfillAuditLog 改为"audit-log 是否已有该签名条目"（head 前缀匹配兼容回填短哈希 + runId 匹配），与 inFlight/auditStartedAt/时间**无关**——v1.0.61（sigAt 恒真）、v1.0.62（auditStartedAt 兜底）、v1.0.65（双门丢弃上轮待补）三次代理缺陷的本质解：存在性是判定本质，时间/审计状态是代理。上轮漏补可补（Medium 实证修复），幂等由存在性天然保证。
- **unauditedArtifacts 前缀匹配**（reviewer Low-4）：回填条目短哈希 vs 当前 HEAD 全哈希的严格比较恒真 → 产物未审假阳性；改 `head.startsWith(latest.head)`（全哈希相等、短哈希为前缀）。
- **空洞回填**：v1.0.60（3420f8e，interrupted 降级）/ v1.0.63（fd1220d）/ v1.0.64（c70ad46，blocked）手工回填——audit-log 15 条，61→65 窗口全部覆盖。
- **测试重构**：shouldBackfillAuditLog 5 场景（runId 匹配/不匹配/head 精确/短哈希前缀/空）+ backfill 6 场景（⑥⑦ 改为"in-flight/陈旧签名也补 + 幂等"——Medium 修复行为锁定）。
- 验证：65/65 通过，tsc 0。

## [1.0.65] - 2026-08-15

reviewer 终审 High（轮询路径陈旧签名重复补写，v1.0.61 同型污染）：

- **新鲜度门**（reviewer High）：backfillAuditLogIfNeeded 入口加双门——① `state.inFlight` 时不补（新审计 in-flight 期间 signature 是上轮陈旧值，补写 = 每轮重复 + blocker 复活 + 假修复轮 + 真实结论延迟）；② `sig.at < auditStartedAt` 不补（签名早于本轮审计开始 = 陈旧，与事件路径 sigCompleted 语义对称）。实证前置条件已存在（state: signature blocked at=1786804612297 / 新审计 in-flight auditStartedAt=1786805302537）。
- **测试补场景⑥⑦**（reviewer Note）：in-flight 陈旧签名不补 + 陈旧签名（at < auditStartedAt）不补。
- 验证：65/65 通过，tsc 0。

## [1.0.64] - 2026-08-15

reviewer 终审 Medium（幂等缺陷，v1.0.61 同型复发路径）：

- **补写条目 runId 与判定同源**（reviewer Medium）：backfillAuditLogIfNeeded 补写 `runId: sig.runId ?? ""` vs 判定 `sigRunId = sig.runId ?? state.auditRunId ?? ""` 来源不一致——签名无 runId 但 auditRunId 非空时（auditRunId 落盘失败模式的实证场景），首次补写条目 runId="" 与下次判定 sigRunId 不匹配 → 每轮重复补写污染证明链。修复：`runId: sigRunId`（与判定同源）。
- **测试补场景⑤**（reviewer Low）：签名无 runId + auditRunId 非空的幂等边缘——同源 runId 断言 + 重复调用不补（v1.0.61 同型复发防线）。
- **D-070/D-071 入链**（decision_add）：补写双保险决策 + 否决形式化路线决策（用户要求审计隔壁 3 条深化建议，判定不落地——实证校准/原语聚类/工程反射已覆盖）。
- 验证：65/65 通过，tsc 0。

## [1.0.63] - 2026-08-15

审计者 blocker（v1.0.61/62 报告未落盘且补写未生效——证明链空洞，豁免协议第一次完整走查即暴露补写通道失效）：

- **补写双保险**（根因修复）：补写从单点事件路径（async-complete）改为统一入口 `backfillAuditLogIfNeeded`（lib）双保险——事件路径（async-complete，替换内联块）+ **轮询兜底（before_agent_start：每轮开始自动补上一轮的洞）**。事件丢失/匹配失败/版本滞后时下轮自动修复，不再产生不可逆空洞。幂等（补写后判定覆盖）。
- **空洞回填**：v1.0.61（head=16727b4）/ v1.0.62（head=c0ed89c）手工回填元数据条目（同 v1.0.59 模式），audit-log 12 条目无空洞。
- **根因记录**：state.auditRunId 为空 + 运行时版本时序——补写事件路径在真实运行中未触发（审计者收尾说明已按 v1.0.60 豁免协议执行，说明任务文本是新的；补写块是否在运行时存在无法直接验证，双保险从设计上消除单点依赖）。
- 测试：backfillAuditLogIfNeeded 4 场景（未落盘补写/幂等/failed 不补/runId 匹配不补）+ 守卫 +2 断言，65/65 通过，tsc 0。

## [1.0.62] - 2026-08-15

reviewer 终审 Medium-High/Low 处理：

- **agent 协议豁免语义双点同步**（reviewer Medium-High，v1.0.52→53 事故同类）：`decision-auditor.md` L148 仍是 v1.0.59 原文（"只落盘元数据条目…下轮补正文"——正是 blocker-1 指出的自相矛盾），v1.0.60 只更新任务文本 → 审计者读两份矛盾指令。修复：agent 文件同步 v1.0.60 语义（禁止 write 触碰 + 扩展原子补写）+ 接线守卫断言。
- **补写兜底改 auditStartedAt 语义**（reviewer Low）：shouldBackfillAuditLog 空 runId 兜底从 `sigAt - 5min` 容差改为 `auditStartedAt` 比较——连续豁免轮 <5min 间隔时 5min 容差会漏补写（第二轮 latest entry = 第一轮补写条目 Date 刚过去）；auditStartedAt 比较无此边缘（本轮开始前落库 = 前轮条目）。
- **v1.0.59 空洞手工补写**（reviewer Medium）：该窗口 blocked 审计按当时豁免协议未落盘，补写机制只对未来生效——用 appendAuditReport 补写元数据条目（AUDIT-1786804240436，head=a9b367c，双 blocker 摘要）。
- 测试：shouldBackfillAuditLog 更新为 auditStartedAt 语义（5 场景）+ 守卫 +1 断言，64/64 通过，tsc 0。

## [1.0.61] - 2026-08-15

审计者修复轮 blocker（v1.0.60 补写判定恒真）：

- **补写判定 runId 优先**（审计者 blocker）：async-complete 补写判定 `latestEntry.date < sigAt` 缺 runId 校验——审计者正常落盘报告 Date 恒早于签名（先报告后签名），判定恒真 → 每轮正常审计都触发重复补写冗余元数据（证明链污染）。修复：`shouldBackfillAuditLog` 纯函数（lib，可测）——runId 优先（匹配 = 已落盘不补写）；runId 缺失走 Date 兼容 + 5min 容差（isAuditCompleted 同语义）。
- **body 文案更新**：v1.0.59 → v1.0.60 豁免版本号。
- 测试：shouldBackfillAuditLog 5 场景（runId 匹配/不同/缺失容差内/超容差/无条目）+ 接线守卫 +1 断言，64/64 通过，tsc 0。

## [1.0.60] - 2026-08-15

审计者双 blocker 修复（v1.0.59 豁免协议实现矛盾 + 泛化通道断流）：

- **豁免补写改扩展原子执行**（blocker-1）：审计者 write 工具无法「只落盘元数据」而不全量重建 40KB 文件（豁免初衷即避免压缩风险）——修正协议：audit-log ≥30KB 时**审计者禁止 write 触碰**，结论写 state.json；扩展在 async-complete 检测 audit-log 最新条目 Date < signature.at → `appendAuditReport` 原子补写元数据条目（tmp+rename，v1.0.48 interrupted 补写同模式）。证明链无空洞。
- **泛化发现独立 gaps.md**（blocker-2，refines D-058）：audit-log 已 40KB 豁免即时生效，`### 泛化发现` section 从此不沉淀 → 泛化四环断流。分离：`gaps.md`（与 chain/audit-log 同目录策略，append-only，mtime 乐观锁原子写）——永远小、持续沉淀；queryGaps 数据源合并（gaps.md + audit-log 存量 findings 兼容）；pair_gaps 查询/复查/沉淀全链路切 gaps.md。
- **D-066 入链**（decision_add 路径）：泛化发现独立 + 豁免补写决策（refines D-058——audit-log 30KB 上限使报告正文沉淀不可靠的环境变化）。
- 测试：appendGeneralization/readGeneralizations 单测（append-only/消毒/同盘）+ queryGaps 合并源测试 + 接线守卫 +3 断言，63/63 通过，tsc 0。

## [1.0.59] - 2026-08-15

reviewer 终审 Low/Note 处理（v1.0.58 全闭环后）：

- **PURE_CHAT_PLACEHOLDER 死 import 删除**（reviewer Low）：v1.0.58 超时过滤并入 helper 后唯一使用点消失，tsconfig 未开 noUnusedLocals 故 tsc 不报——清理。
- **audit-log ≥ 30KB 落盘豁免**（reviewer Note-2 根因修复）：v1.0.57 窗口 blocked 审计未落盘 AUDIT 条目（37KB 文件 write 全量重建压缩风险，审计者临时豁免）→ 协议固化：≥ 30KB 只落盘元数据条目（无正文），结论经 blockers/auditFindings 交付——write 全量重建压缩风险与 chain.md 50KB 禁令同族，防未来空洞。
- **tag 树缩进修正提交**（reviewer Note-3）：v1.0.58 超时路径缩进异常（工作区已修，随本版提交使 tag 与工作区一致）。
- 验证：61/61 通过，tsc 0。

## [1.0.58] - 2026-08-15

审计者 + reviewer 双路同源 blocker 修复（"声称三处统一"只兑现两处）：

- **超时降级路径并入 helper**（双路 blocker）：L1872-1878 手写精确串过滤 → `isPlaceholderFinding(f)`——三处统一（观察器/超时/注入判据）完全兑现，CHANGELOG v1.0.57 声称与实现一致。
- **重复 JSDoc 清理**（双路 blocker-2）：PURE_CHAT_PLACEHOLDER 注释重复两行删除。
- **D-065 入链**（decision_add 路径）：占位判定统一 helper 决策。
- 验证：61/61 通过，tsc 0。

## [1.0.57] - 2026-08-15

reviewer 复核修复（idleTicks 残留 Low + 占位规则三处漂移 Note）：

- **idleTicks 残留清理**（reviewer Low）：stopFindingsObserver 的 root 分支与全清分支补 `idleTicks.delete/clear`——残留计数会让下轮新审计首个 tick 即自停（Low-2 防护以重启形态被击穿）。一行级修复 + 语义回归测试。
- **占位判定统一 helper**（reviewer Note-2）：`isPlaceholderFinding` 导出（lib/chain-store.ts）——观察器 / 超时降级 realFindings / 中间态注入判据三处漂移规则合并（审计开始 / 纯咨询 / 审计未触发 / 审计触发失败）；行为测试 6 断言（含真实核实/收尾反例）。测试新增"审计触发失败"覆盖（includes 宽匹配盲区实证）。
- 验证：61/61 通过，tsc 0。

## [1.0.56] - 2026-08-15

v1.0.55 reviewer 复核修复（Medium-1 回归 + Low ×2 + Note ×2）：

- **呼吸灯秒数回归修复**（reviewer Medium-1）：v1.0.55 编辑误删 `auditBreathStart = Date.now()` 赋值（const 0 残留）→ secs 显示 epoch 秒（17 亿）。修复：恢复赋值 + `let` 声明 + 删重复 setStatus——可观察性主打功能自身先被审出回归，证明链闭环实证。
- **观察器误自停防护**（reviewer Low-2）：findingsObserverTick 单次 `inFlight=false` 即自停——readAuditState 瞬时读失败返回 DEFAULT（inFlight 恒 false）会永久丢失本轮可观察性。修复：连续 3 次才自停（idleTicks 计数）。
- **计数排除占位**（reviewer Low-3）：`已发现 N 项` 用数组全长（含『审计开始』占位）→ 过滤占位后计数（与超时路径同规则）。
- **F-10 自愈同停观察器**（reviewer Note-4）：setStatus 抛错自愈路径补 stopFindingsObserver。
- **D-064 入链**（reviewer Note-5）：结对可观察性用户要求（decision_add 路径）。
- 验证：60/60 通过，tsc 0。

## [1.0.55] - 2026-08-15

结对可观察性（用户实证：审计运行中 119s 完全黑盒，不知道结对在干什么）：

- **findings 观察器**：审计运行中（inFlight）每 20s 轮询 state.json 的 auditFindings 中间态——审计者每完成一步核实就追加 findings（中间态交付是既有设计），现在**有新条目立即轻量 notify**（`结对审计中：<最新一条截断>`，占位过滤）；审计完成（inFlight=false）观察器自停。价值点可观察，流程噪音不呈现（findings 是价值不是流程）。
- **呼吸灯摘要**：`结对审计进行中（Xs）· 已发现 N 项`——findings 计数实时进 footer。
- **生命周期接线**：观察器随呼吸灯启停（startAuditBreath 启动 / stopAuditBreath 汇聚停止——门禁完成/超时/async-complete/shutdown/spawn 失败全出口覆盖；常规轮异步完成由 inFlight 自停兜底）；print/无 UI 模式 notify 降级。
- 测试：接线守卫 +2 组断言（观察器接线 + 生命周期启停），60/60 通过，tsc 0。

## [1.0.54] - 2026-08-15

reviewer 终审 Low/Note 处理（无 Blocker）：

- **任务文本重复 push 修复**（reviewer Low-1）：`buildIncrementalAuditTask` 「两个实证盲区维度」段两行重复（编号 3、3）——删除第二行；接线守卫基于 includes 无法捕获重复，本类回归靠评审（教训：重复行守卫可选加计数断言，暂不）。
- **pair_gaps 回抄风险标注**（reviewer Note-1）：沉淀协议注明「不要直接回抄 pair_gaps 工具输出（其展示带 `[audit]` 前缀，非沉积格式，须按标准格式重写）」。
- **发布门禁固化**（reviewer Medium-1 残余）：`npm run verify`（tsc + test 以 exit code 门禁，杜绝 v1.0.52 `grep | &&` 误放行模式）；发布流程先 verify 后提交。
- 验证：60/60 通过，tsc 0。

## [1.0.53] - 2026-08-15

v1.0.52 发布缺陷补发（测试门禁在 grep 匹配 fail 行时误放行——发布纪律教训：发布命令必须用 exit code 门禁，不得 grep 输出判断）：

- **agent 协议链一致性段补上**：`decision-auditor.md` 链基础检查的「链一致性（v1.0.52）」（悬空引用/传递一致性/临时假设 Confidence 降级）在 v1.0.52 因 edit stale 未应用——接线守卫断言（agentSrc 双关键词）本应拦截，但发布命令 `npm test | grep && git commit` 中 grep 匹配到 fail 行返回 0 误放行。1.0.53 补齐 + 守卫通过。
- 验证：60/60 通过，tsc 0。

## [1.0.52] - 2026-08-15

隔壁 AI 建议审计后的降级落地（3 个 prompt 句，零结构——其余 5 条否决：已有/被否决/违背实证）：

- **链一致性检查**（建议#1/#5 降级）：审计任务 + agent 协议加——① 悬空引用（被 Supersedes 的决策仍被引用 = 偏离）；② 传递一致性（依赖被推翻决策的下游标注『待重审』）；③ 临时假设标注（Context 含未验证假设 → Confidence 降级 + 条件性决策标注）。不建 Depends/Refutes/Subsumes 字段（写负担 > 查询价值，AI 语义可查）、不建 AXIOM 标记体系（依赖主 agent 自觉，违背项目前提）。
- **原语语义聚类**（建议#3 降级）：泛化缺口复查时把语义相近路径归为同一原语（如『局部最优陷阱』『防御纵深』），报告标注原语名+频次——跨场景模式识别；不建原语库 schema（D-058 已否决 patterns.md，frequentPaths 词面统计已有）。
- 否决记录：#2 维度重构（纯重命名，破坏实证校准锚点）、#4 反例构造器（发散核实边界反例已有）、#6 元审计（额外 spawn = 用户否决的开销；复发检测已是隐式召回追踪）、#7 模式压缩（D-058 否决）、#8 跨项目公理库（违背"原语来自本项目实证"）。
- 验证：60/60 通过，tsc 0。⚠ 注（v1.0.55 标注）：发布时实为 59/60——agent 协议链一致性段因 edit stale 未应用 + `npm test | grep &&` 门禁误放行；已由 v1.0.53 补齐、v1.0.54 固化 exit-code 门禁，详见对应条目。

## [1.0.51] - 2026-08-15

reviewer 终审 Note 处理（v1.0.50 双 Blocker 已闭环，终态无残留）：

- **泛化发现行格式强制**（Note-2 类别风险缓解）：解析器-写者对不齐已两次实证（v1.0.49 条目分隔 / v1.0.50 section 头）——任务文本与 agent 协议加「行格式必须严格保持 `- 场景: X | 路径: Y | 来源: Z` 单行形态；不要用粗体头、不要拆多行、不要改字段名」。审计者协议模板统一回 `### 泛化发现` 标准形态。
- **D-062 入链**（Note-1）：声明 D-060 refines D-055（pair_gaps 是 AI 对账的工具化形态，未引入独立解析器）——消除链上字面张力。
- **过程卫生**（Note-4）：audit-verify.mjs 残留脚本删除。
- 验证：60/60 通过，tsc 0。

## [1.0.50] - 2026-08-15

修复轮（审计者 blocker + reviewer 双路复核：parseAuditLog 解析与真实写者对不齐 / 时区比较误报）：

- **泛化发现 section 头放宽**（审计者 blocker，48d 同源复发）：parseAuditLog 只认 `### 泛化发现`，审计者实际输出 `**泛化发现（…）**：` 粗体形态 → findings 恒空。修复：匹配 `/^#{0,3}\s*\*{0,2}\s*泛化发现/m`（兼容两种形态）；测试补 `**泛化发现**` 真实形态 + 完整复现（5 条目含 appendAuditReport 与手写混排，findings 全解析）。
- **决策未审时区比较修复**（reviewer Medium-1）：chain.md 审计者手写 `+08:00` 本地时区 vs audit-log `toISOString` UTC `Z`——字符串比较把本地小时当 UTC 比，真实数据误报 12 条已审决策为未审。修复：`new Date().getTime()` epoch ms 比较；测试补混合时区场景（+08:00 vs Z 不误报）。
- **测试断言残留**（reviewer Blocker）：queryGaps 测试 ⑦ 自相矛盾（`[3]` 正确断言后残留 `[0]` 旧断言）→ 测试红 59/60。修复：删残留断言。
- **agent 文件围栏失衡**（reviewer Medium-3）：`decision-auditor.md` L148 悬空 ``` + L185 未闭合吞文件末行。修复：删悬空围栏、输出格式块补语言标注。
- **Low 清理**：appendAuditReport 重复 throw 死代码删除；`slice(-0)` limit=0 边界；README `End is end` 标点恢复；CHANGELOG 48b 重复行删除；临时验证脚本清理。
- **证明链补全**：D-059（泛化发现四环）/ D-060（pair_gaps 工具）/ D-061（chain.md 重建禁令）经 decision_add 入链（50KB 禁令下主 agent 追加路径）。
- 验证：60/60 通过，tsc 0。

## [1.0.49] - 2026-08-15

parseAuditLog 条目分隔修复（审计者实证 blocker：报告正文的 `## 审计报告（范围…）` 标题被 `indexOf("\n## ")` 误当条目边界 → body 截断、**泛化发现 findings 恒 0**，pair_gaps 的 generalization 查询在真实数据上落空）：

- **修复**：条目分隔改匹配真实条目头 `## AUDIT-<ts>:`（`indexOf("\n## AUDIT-", start)`），正文标题不再截断条目。
- **测试盲区补全**：queryGaps 测试改用审计者真实输出格式（正文含 `## 审计报告` 标题 + `### 泛化发现`），断言 findings 解析 + body 完整性——解析器正则必须与实际写者输出对齐（审计者泛化发现 ①）。
- 验证：60/60 通过，tsc 0。

## [1.0.48] - 2026-08-15

证明链落地（用户设计讨论：审计报告落盘 → 证明缺口机械可判）:

- **审计报告落盘（audit-log.md）**：每次真实审计 append 一条 `## AUDIT-<epoch ms>: <verdict>` 条目（与 chain 同目录策略：默认 `.pi/decision-auditor/audit-log.md`，`PI_PAIR_CHAIN_PUBLIC=1` 时 `docs/decisions/`）。审计者收尾**先报告后签名**（被杀时报告仍在）；扩展在交付轮超时降级时补写 `interrupted` 条目（证明链无空洞）。`lib/chain-store.ts` 新增 `decisionsDir`（chainPath 同源重构）/ `auditLogPath` / `appendAuditReport`（与 appendDecision 同乐观锁纪律：mtime + 唯一 tmp 原子写 + rename 紧前复校验 + 末尾条目验证）。证明链闭环：决策（chain.md）+ 审计（audit-log.md）+ 产物基线（Head 字段）三源对账，缺口（决策未审 / interrupted 空洞未填 / blocked 未闭环）纯机械可判。
- **证明缺口自查（AI 能力，无独立解析器——用户决策：给 pair 的 AI 用就行）**：审计者写报告前顺手对账三处（chain.md 新决策 vs audit-log 最新条目 / 上轮 interrupted 是否补填 / blocked 是否闭环），发现写进报告正文，严重者升级为 blocker。
- **subagent 决策捕获（转述即捕获）**：subagent 不在 convlog，主 agent 转述是唯一可见通道——审计任务文本 + agent 协议加提取规则（转述的 subagent 决策性选择入链并标注来源 run；Context 引用 subagent 报告需独立核实）；主 agent 侧 SKILL 加**转述义务**（不转述 = 该决策在证明链上消失）。
- 测试：接线守卫 +5 组断言（报告落盘路径 / subagent 捕获 / 缺口自查 / interrupted 补写 / agent 收尾协议）+ appendAuditReport 功能测试，58/58 通过，tsc 0 错误。

## [1.0.48b] - 2026-08-15

state.json 截断损坏自愈（algeff 实证：审计者 write 工具截断写被杀半程 → 对象缺 `}`，readAuditState 持续报错刷屏）：

- **读侧自愈**：readAuditState 损坏分支改为「截断补全（raw + `}` 可解析才写回）→ .corrupt 备份恢复（最新 1 份，原子写回）→ 都失败才落 warn + DEFAULT」。损坏窗口内不再持续报错：一次恢复尝试（进程内按 cwd 记忆，防 2s 门禁轮询重复扫描）。
- **根因**：审计者子进程的 write 工具是截断写（无 tmp+rename 能力），被 SIGKILL 落在写中途 = state.json 截断。扩展侧自愈是唯一可行缓解（与 convlog 截断风险同族）。
- 重构：readAuditState 主体解析抽为 `parseAuditState`（恢复路径共用，行为等价）；`atomicWriteState` 原子写回。
- 测试：读侧自愈 3 场景（截断补全 / 备份恢复 / 恢复失败落 DEFAULT），59/59 通过，tsc 0 错误。

## [1.0.48c] - 2026-08-15

泛化发现（pair 的多头注意力沉淀——用户设计决策：不引入第二模型/L2，L1 的维度注意力跨轮累积）：

- **泛化发现沉淀**：发散核实的路径型产出（主 agent 没想到的候选路径：更优替代/跨域范式/边界反例，落不回缺口者）→ 报告正文末尾 `### 泛化发现` section，一行一条（场景|路径|来源）。能落回缺口的仍走 blockers 原通道——不重复、不改变签名语义（附加产出）。
- **泛化缺口复查（查询）**：审计者收尾扫 audit-log 最近 10 条泛化发现做语义比对——同类盲区复发（有产物证据才升级 blocker）/ 同一路径 ≥2 次未采纳（标注蒸馏建议）。**修复轮不执行**（收敛纪律）；纯咨询/轻量退出不写。
- **复用纪律（主 agent）**：SKILL 加「泛化路径复用」——方案取舍前 grep audit-log 泛化发现 + chain 的 Alternatives，命中即考虑并回引（AI 检索，无独立工具）。
- 四环闭环：沉淀（泛化发现 section）→ 复用（开工前 grep）→ 查询（收尾复查 N 条）→ 蒸馏（高频未采纳 → 固化审计维度，实证校准机制出口）。零存储层代码。
- 测试：接线守卫 +4 组断言（泛化沉淀 / 复发+蒸馏 / 修复轮排除 / agent 协议同步），59/59 通过，tsc 0 错误。

## [1.0.48d] - 2026-08-15

pair_gaps 查询工具 + chain.md 全量重建禁令（审计者自身事故：write 全量重建 80KB 链被系统性压缩至 47KB，逐字不可恢复）：

- **pair_gaps 查询工具**：`pair_gaps` MCP 工具（scope: proof/generalization/all + limit）——证明缺口确定性对账（决策未审 / interrupted 空洞 / blocker 未闭环 / 产物未审）+ 泛化发现数据聚合（最近 N 条 + 高频路径统计，语义比对由调用者判定）。主 agent 与审计者共用，纯读不 spawn。数据层 `queryGaps`（lib/chain-store.ts）可测。
- **chain.md 全量重建禁令**：审计者捕获决策**优先经 decision_add 工具**（扩展 appendDecision 乐观锁 + 只追加，无全量重建）；chain.md ≥ 50KB 禁止 write 全量重建（decision_add 不可用时写 auditFindings 由主 agent 追加）。agent 协议同步。
- 测试：queryGaps 6 场景（未审/覆盖清空/空洞/blocked 未闭环/泛化解析/高频路径）+ 接线守卫 +4 组断言（pair_gaps 注册/数据层调用/重建禁令/agent 同步），60/60 通过，tsc 0 错误。

## [1.0.47] - 2026-08-15

v1.0.46 交付 reviewer 复核（Medium-1 + Note-3 可修项）修复：

- **Medium-1：L2 守卫缺失**——D-052 声称"L2 同步同一纪律"，实际修复轮守卫只在 L1（:242），L2 轻量退出分支（:391）无守卫子句。修复：L2 镜像同一守卫（blocked 且 blockers 非空 → 不得轻量退出，先核验闭环）——交付门禁路径纵深防御，兑现"与 L1 同构"承诺。
- **Note-3：审计者 agent 工具白名单含未加载 ctx_\***——`agents/decision-auditor.md` 声明 `ctx_read, ctx_grep, ctx_find, ctx_ls` 但运行时严格 allowlist 拒绝（未加载 lean-ctx 扩展）→ **审计者 run 全量 exitCode=1**（今日 3 次审计全部先标 failed，靠 v1.0.44 failed 纠正兜底）——这是用户原始报障"结果审计经常 low 收不了尾"的又一根因。修复：从白名单移除 ctx_*（审计者实际用 read/grep/find/ls/bash 完成工作，无能力损失）。
- **Note-2（D-052 记录卫生）**：留给下轮审计处理（链 append-only 纪律，审计者职责）。
- 测试：接线守卫 +2 组断言（L2 守卫镜像 / ctx_* 移除），57/57 通过，tsc 0 错误。

## [1.0.46] - 2026-08-15

v1.0.45 双路 reviewer 复核（Medium + 3 Note）修复：

- **Medium：低价值窗口轻量退出未排除修复轮场景**——上轮 `signature.status==="blocked"` 且 blockers 非空时，若修复提交恰为纯文档/格式改动（blocker 是"CHANGELOG 缺记"类文档问题时修复即文档提交，v1.0.44 de70d47 同型），审计者第零步轻量签名 passed **早于**上轮缺口核对执行，绕过"仍成立必重报"不变量。修复：轻量退出分支加**修复轮守卫**——blocked 且 blockers 非空 → 不轻量退出，先核验 blockers 闭环再签名。
- **Note#1：eff70b7 未打 tag/发布**——L2 收敛修复只在 git 仓库，npm 安装的 pi-pair@1.0.45 不含该修复。补发 v1.0.46（本版含 eff70b7 + 修复轮守卫）。
- **Note#2：D-052 入链**——L2 同步低价值窗口纪律为决策级扩展（refines D-051），下轮审计补录。
- **Note#3：latest-audit.md 过期 19h**——跨会话交付文件仍是 run-56820 旧结论（M4 已修），收尾协议补"刷新 latest-audit.md 或标注 superseded"留待下轮评估。
- 测试：接线守卫 +1 组断言（修复轮守卫），57/57 通过，tsc 0 错误。

## [1.0.45] - 2026-08-15

审计唤起收敛（用户报障"审计一直唤起无法收尾"，取舍：n+1 审计链保留，核心是控制无谓唤起）：

- **低价值窗口轻量退出（审计者第零步）**：窗口产物仅文档/格式改动（.md/CHANGELOG/README/package.json 版本号）且无新决策 → 审计者快速签名 passed，不做五维度进攻（文档一致性 1-2 行概述）。实证：v1.0.44 的 de70d47（+1 行 CHANGELOG）触发完整 L1+L2 双路审计——纯文档提交不值得全量成本。**语义判断在审计者 AI 侧，扩展触发逻辑零改动**（门禁"提交=必审"保留，审不审、审多重由审计者定——符合"扩展只做便宜信号"哲学，不做脆弱的文件类型硬编码）。
- **修复轮收敛纪律（审计者立场收窄）**：修复轮（上轮 blocked 后再次唤起）只核验上轮 blockers 是否闭环，不扩大范围主动寻找新问题——新发现仅 blocker 级缺陷升级 blocked，Low/Note/风格/可改进项写入 auditFindings 供下轮参考、**不升级为 blocker**。实证：v1.0.44 修复链（Low#2→Note#1→CHANGELOG 缺记）每轮修复产生新 Note 又催生新提交——对抗式立场只在首轮/新交付启用，修复轮的价值是验证修复、推动收敛。
- **配套纪律（主 agent，非代码）**：一个逻辑变更 = 一个提交——v1.0.44 的 6 个提交（三修主体/biome/Low/L18/Note/CHANGELOG）应合并为 1-2 个，提交次数 = 唤起次数。
- 测试：接线守卫 +2 组断言（低价值窗口轻量退出 / 修复轮收敛纪律），57/57 通过，tsc 0 错误。

### v1.0.45 审计 Note 跟进（L2 reviewer 同步收敛）

- **L2 reviewer 低价值窗口轻量退出**：L1 已收敛但 L2（triggerDeliveryAudit fanout 的 reviewer）对纯文档提交仍全维度深度审查——同步加入同一纪律（窗口仅文档/格式且无新决策 → 简短确认即可，例外条款同 L1）。纯文档交付不再双路全量。
- 测试：接线守卫 +1 组断言（L2 低价值窗口指令），57/57 通过，tsc 0 错误

## [1.0.44] - 2026-08-15

24h 会话审计实证驱动的三修（用户报障：中途审计"没在工作"的观感 + 结果审计 failed 收不了尾 + 审计者从不 contact_supervisor）：

- **failed 误报纠正（async-complete）**：审计者 run 内容完整（签名+报告都落盘）但 pi-subagents 按 `exitCode===0 && !interrupted && !timedOut` 判定 success → deepseek-v4-flash 流式输出中断（`Stream ended without finish_reason`）时 run 标 failed → 用户/主 agent 看到 "Background task failed: pi-pair.decision-auditor" 误判审计没收尾（24h 实证：14:14 之后 13/13 个审计者 run 通知全 failed，尽管内容完整）。扩展 async-complete 处理加纠正判据：事件 `success===false` 但 `signature.at ≥ auditStartedAt`（签名实际完成）→ 轻 notify 纠正（不注入对话）。
- **审计者模型覆盖（PI_PAIR_AUDITOR_MODEL）**：spawn 审计者时透传 model 参数（agent_end 与 /pair-audit 两处），从源头规避 provider 流中断；未设置则继承主会话模型（原行为零变化）。
- **交付通道澄清（agent prompt + 审计任务文本）**：实证 24h 审计者 0 次调用 contact_supervisor，而 blockers 全部经签名 + async-complete sendUserMessage 通道如期交付——prompt 明确**通道分工**：contact_supervisor 仅用于需要即时裁决/澄清的场景；发现 blocker 直接签名即交付（扩展立即 sendUserMessage），不因"联系了没人回"而不写 blockers。
- 测试：接线守卫 +3 组断言（模型透传 / failed 误报纠正判据 / 通道分工文本），57/57 通过，tsc 0 错误。

### v1.0.44 交付审查 reviewer 复核（无 blocker）→ 2 个 Low 顺手修

- **Low#1 降级竞态文案失实**：纠正判据 status 白名单收窄为仅 `passed`/`blocked`——`passed-with-warning`（门禁 300s 超时降级签名，at=降级时刻 ≥ auditStartedAt 恒成立）在竞态窗口下会误触发「实际已完成」文案
- **Low#2 无 runId 身份校验**：纠正判据叠加 `signature.runId === auditRunId`（isAuditCompleted 同语义）——并发/多实例下 run A 失败、run B 完成时 A 的 async-complete 不误触
- **Note#1 严格化（de31013）**：Low#2 的共享槽比对仍存同 cwd 多实例因果错位（B 完成会覆盖 auditRunId 槽）——改为**严格优先**：签名带 runId 时只认 `signature.runId === completedId`（事件 run 与签名 run 直接比对）；无 runId 旧签名走兼容语义（auditRunId 空或事件 run 即槽值）。fail-safe 方向（宁可不触发、不误触发）
- 测试：接线守卫补 1 组断言（status 白名单 + runId 校验），57/57 通过，tsc 0 错误

## [1.0.43] - 2026-08-15

v1.0.42 审计者 blocker（一致性/完备性维度）：注释与 prompt 文本过时残留（与 v1.0.41 blocker 同类模式）：

- **审计者 prompt「主 agent 会同步等你的签名」（L199）**：门禁已改后台轮询——改为「经后台轮询等你的签名（不阻塞）」；顺带去掉 prompt 内「用户提交/发布/merge」信号词（→ 本轮 git HEAD 变化，与 D-022 触发语义一致）
- **「审计阻塞时长/审计阻塞计时起点」（L1191/L1383）**：门禁非阻塞，t0 测审计总时长——改为「审计时长/审计时长计时起点」
- **「门禁轮同步共用」（L473/L1459）**：→「门禁轮后台轮询共用」
- **根因级补丁（审计者误写域）**：v1.0.42 审计者收尾误写 blockedStreak=2（扩展维护域）→ gateComplete 读到 streak=2 递增至 3 → A2 提前降级（blockers 保留，降级时机失真）。prompt 写入纪律补明确：**blockedStreak 是扩展的 A2 连续 blocked 计数域，原样保留**（与 gatedHead/injected* 同列）
- **D-046 入链（v1.0.40 F-13 决策条目，reviewer Low）**：门禁轮询 timer 生命周期双保险（shutdown 清理 + 防御 clear）作为独立决策条目补录——F-13 是 v1.0.39 审计 blocker 的落地实现，上轮审计者裁定 D-044 已覆盖；本轮 reviewer 建议产物↔决策对照可追溯，补录消除分歧
- **接线守卫测试补 F-13 断言（reviewer Low）**：session_shutdown 清理 + agent_end 防御 clear 两处接线断言（防回归，锁 v1.0.40 blocker 场景）
- 复扫：L1540「F5 同步短路」/L1600「原同步完成分支」为历史引用或语义正确，非残留（审计者发散核实确认）
- 测试：57/57 通过（接线守卫测试内 +2 断言），tsc 0 错误

## [1.0.42] - 2026-08-15

v1.0.41 审计者 blocker（完备性维度）：文档同步主题内漏改 3 处直接矛盾残留（en+zh 共 6 处）：

- **Quick start 段（README L51/53 + zh L51/53）**：「sync gate on delivery rounds / 交付轮同步门禁」旧语义 +「On delivery (submit/publish/merge/deploy) / 交付时（提交/发布/merge/部署）」信号词残留（D-022 已改 git HEAD 客观信号）——改为后台轮询门禁 + git HEAD 变化触发
- **L2 门禁描述（README L97 + zh L95）**：「no git diff & no decisions → skip」与代码矛盾——L2 与 L1 同源由 hasNewCommit 触发（decision-chain.ts L1377），提交后 diff 空仍审查；改为「与 L1 门禁同源触发：本轮 git HEAD 变化（无提交不 spawn）」
- **全仓复扫补齐同类残留（8 处）**：README Design philosophy（L37「submit / publish / merge / deploy」信号词）、docs/audit-state-machine.md（L52「await 签名」）、decision-chain.ts 5 处注释块 6 行（L1004/L1029/L1344-1345/L1381/L1539「同步等签名」→「后台轮询等签名」）——代码注释与实现不一致同属机制完整性缺陷，一并修
- 复扫确认：*.md 零残留（CHANGELOG 历史条目如实记录当时行为，不改）
- 测试：57/57 通过，tsc 0 错误

## [1.0.41] - 2026-08-15

v1.0.39/40 复核 reviewer（无 blocker）P2 note——文档同步（项目文档同步纪律，v1.0.31 先例）：

- **README/README.zh-CN/architecture.md 门禁语义同步**：旧文档仍描述「交付轮同步等签名（300s 上限）/ await 签名 / 仅交付轮等签名」——v1.0.39 已改为非阻塞后台轮询 + message_start 用户消息解除等待。9 处替换：README.md（How it works 图 + Fresh-spawn pairing + Lifecycle rules）、README.zh-CN.md（工作原理图 + fresh spawn 结对 + 生命周期规约 + print 模式已知限制）、architecture.md（设计原则 4 + agent_end 转移图）
- **顺带修正 D-022 时代遗留触发描述**：README 两处「delivery rounds (submit/publish/merge/deploy) / L2 交付审查（用户说"提交/发布/merge/部署"）」→ git HEAD 客观信号（v1.0.26 已改触发，文档未同步）
- 跳过（reviewer P3）：取消路径不记录 recordAuditDuration（metrics-only，无行为影响）；D-004/D-044 supersede 交叉指针（D-044 Context 已写明同步门禁失败，实质语义在）
- 测试：57/57 通过，tsc 0 错误

## [1.0.40] - 2026-08-15

v1.0.39 审计者 blocker（机制完整性维度）：门禁轮询 timer 生命周期缺口——跨会话轮询泄漏：

- **session_shutdown 清理 gatePollTimers（根因）**：会话 A 门禁轮询中退出 → timerA 残留常驻进程；新会话 B 门禁轮 `set` 覆盖句柄但 timerA 仍 tick → 双轮询并发：timerA 读到 B 审计者签名 → gateComplete 把 gatedHead 回退旧 head（下轮 hasNewCommit 恒真 → 门禁风暴）；或 timerA 超时 → recordSignature 覆盖 B 审计者真实签名。改：session_shutdown 对本实例 root 的 timer clearInterval + 从 Map 删除（与 inFlightAudits 同域清理）
- **agent_end 启动前防御 clear**：即使泄漏路径（shutdown 未执行/异常退出）残留旧 timer，新门禁轮启动前清旧句柄（幂等，双保险）
- 测试：57/57 通过，tsc 0 错误

## [1.0.39] - 2026-08-15

用户报障（v1.0.38 审计轮同窗口）：门禁同步等待 300s 期间「没法交互，也没法取消审计」——agent_end 事件内 await 轮询，TUI 保持 Working、用户输入排队：

- **门禁等待异步化（根因，D-044）**：agent_end 不再同步等签名——spawn 后立即返回（turn 结束、UI 解锁）。签名经 2s 间隔后台轮询（setInterval + gatePollTimers Map）检测：完成 → 推进 gatedHead + streak 维护 + F3 删条目 + 灭灯；300s 超时 → 原降级放行逻辑（recheck 盲窗 JD #19 + findings 过滤 D-021 + stopRun FP #13 + recordSignature passed-with-warning）。门禁把关语义（提交=交付必审、blocked 交付、超时降级）全部保留
- **用户消息中断等待（取消入口）**：message_start（仅 user role——assistant/toolResult 也触发该事件）→ clear 轮询 + 推进 gatedHead 放行 + notify；不碰 signature、不 stopRun——审计者结论经 async-complete 交付（blocked 即时 followUp，注入路径兜底），用户主动继续即自担风险
- **waitForAuditCompletion/sleep 删除**：唯一调用点（门禁同步等待）移除后无引用；接线守卫测试同步更新（断言新轮询两处 isAuditCompleted 调用形态）
- **session_start 残留灯自愈加固（v1.0.38 reviewer Low）**：reload 后模块级 cachedAuditUi 重置为 null，stopAuditBreath 的 setStatus(undefined) 是 no-op——直接用 handler 的 ctx.ui.setStatus(AUDIT_STATUS_KEY, undefined) 清除，reload 场景同样生效
- 顺手：session_shutdown 两处 async map 回调补显式 return（eslint 强制）
- 跳过：中断后审计者 run 的算力回收依赖 async-complete/TTL stale 清理（≤16min 有界）；显式 /pair-audit-cancel 命令（解锁后非刚需）
- 测试：57/57 通过，tsc 0 错误

## [1.0.38] - 2026-08-15

用户实证报障：footer 常驻「结对审计进行中（17006s）」，但 state.json inFlight=false、签名 passed、审计早已结束——呼吸灯未灭（F-10 同类的多实例短路变体）：

- **多实例短路路径灭灯（根因）**：多实例检测（convlogForeignRuns > 0）的短路 return 位于 stale 锁清理之前——本实例早前 spawn 的审计结束后，灭灯三条路径（async-complete 归属会话过滤 / stale 清理被短路 / session_shutdown 未触发）在此场景全部失效，灯永久常亮且秒数持续增长。改：短路 return 前 `stopAuditBreath(root)` 灭自己的灯（cwd 校验隔离多实例，不误灭他人灯）；不动 state（L4 防护不变——多实例下 state 可能属另一实例的真实审计）
- **残留灯自愈（session_start）**：热重载/异常退出（session_shutdown 未执行）后 timer 与 footer 状态残留，新会话无条件灭本 root 的灯（带 cwd 校验；本会话 spawn 审计时 startAuditBreath 重新亮灯，顺序自洽）
- 跳过：挂起审计者 run 的算力回收在多实例下仍依赖其他实例的 stale 路径（不在本版范围）；async-complete 的 ownsSession 归属过滤为 pi-subagents 行为（事件只通知发起会话）
- 测试：57/57 通过，tsc 0 错误

## [1.0.37] - 2026-08-15

v1.0.36 发布后双路 reviewer 复核（前轮 Medium：head 语义与兜底检测前提冲突）+ 本轮 Low-1/Note-1 同源——异步空洞源头补审：

- **收尾前自查（Medium 源头修复）**：signature.head 是签名时刻 HEAD——审计运行期间落库的中间提交 C 已含入 head → 下轮 HEAD==signature.head → 兜底自查（v1.0.34/36）在纯 gap 场景（C 后无后续提交）检测不到 → C 被两轮窗口永久排除。改：L1 收尾协议（L289）加「收尾前自查」——重新执行建立窗口时的 `git log --since=<窗口起点>`（同一命令形式）与首次结果比对，快照后落库的新提交逐个 `git show` **补审后再签名**；head 照常写签名时刻 `git rev-parse HEAD`（已含补审提交，注入新鲜度检查不受影响；否决「head 钉死窗口计算时刻」方案——会让 blocked 签名 head≠当前 HEAD → 新鲜度检查误判陈旧、blockers 不注入）
- **交叉对照完整列表（Low-1）**：`git log --oneline -5` → 完整 `git log --oneline`（gap 提交深于 5 个时不再漏；L1 L262 + L2 L401 同步）
- **L1 中间句收敛（Note-1）**：删除「HEAD == signature.head 且窗口为空才走审决策质量分支」中间句（字面可误读为充分条件、漏掉未提交 diff 审查）——以句尾完整条件（无新提交且无未提交 diff）为唯一判定
- **L2 收尾自查**：交付审查 prompt 同步加「重新执行窗口 git log 与首次结果比对，运行期间落库的新提交补审后再输出」（多实例同 cwd 并发提交场景同源）
- 跳过：prompt 一致性断言测试（buildIncrementalAuditTask 在扩展工厂内不可单测，抽取到 lib 属过度工程——记录为已知残余）；cwd/runId 未转义（既有模式，注入面低）
- 测试：57/57 通过，tsc 0 错误

## [1.0.36] - 2026-08-15

v1.0.35 发布后安全/健壮性 reviewer 复核（无 blocker）+ 目标一致性 reviewer 独立复现同一混合窗口 note——兜底触发条件完备化：

- **混合窗口兜底（Low-1，双 reviewer 独立指出）**：v1.0.34 兜底只在「窗口为空」时触发——若异步审计运行期间落库的 gap 提交 C（commit date < 上轮签名时间）与窗口内正常提交共存，窗口非空 → 兜底不触发 → C 被两轮窗口同时排除。改：触发条件从「窗口为空」扩展为 **「存在 signature（非首次审计）且 HEAD ≠ signature.head」**（无论窗口是否为空）——用 `git show HEAD` 结合 `git log --oneline -5` 与窗口列表交叉对照，HEAD 侧可见但不在窗口列表内的提交 = 未审提交（正常轮恒触发仅冗余核对 git show HEAD，成本可忽略）；「审决策质量」分支条件（HEAD == signature.head 或首次审计）不变，语义自洽
- **L2 兜底句对齐 L1（Low-2）**：补「存在 signature（非首次审计）」守卫 + `-5` 伴生（v1.0.34 声称对齐但兜底句漏对齐，本版补齐）；两处兜底句统一措辞
- **Note-4 澄清**：兜底句明确「窗口起点 = 已 ÷1000 的 epoch 秒」（防审计者误用 13 位毫秒——实测 `--since=1786724` 返回空窗口）
- 跳过：Note-3（at 小正数垃圾值如 at=1 不触发回退——readAuditState 只清洗非数字，prompt 与扩展 isAuditCompleted 边界一致，需状态文件损坏才触发，记录为共享设计边界）
- 测试：57/57 通过，tsc 0 错误

## [1.0.35] - 2026-08-15

v1.0.34 发布后独立 reviewer 复核（无 blocker；Medium-1 at≤0 边界 + Low-2 措辞已由 v1.0.34 闭合 + Low-3 既有行为接受）：

- **`at ≤ 0` 空窗口（Medium-1，reviewer 实证）**：readAuditState 把缺失/非法 at 清洗为 0（lib/chain-store.ts L406-414），B5 测试（chain-store.test.ts L1451）显式建模 `{status:"passed", at:0}`——审计者漏写 at 在实践发生过。真实 status（passed/blocked）+ at=0 时旧规则窗口起点 = signature.at → `git log --since=0` 空窗口；且空窗口是「预期正常」分支（审决策质量），审计者无怀疑动机，收尾推进 lastAuditAt 后未审产物永久落在未来窗口外。改：回退条件从 `status ∈ {passed-with-warning, failed}` 扩展为 **`at ≤ 0 || status ∈ {passed-with-warning, failed}`**（两处 prompt：L1 L262 + L2 L401；at=0 且 lastAuditAt>0 → 回退 lastAuditAt；双 0 → 首次审计语义最近 20 提交，自洽）
- **Low-2（L2 措辞不对称）**：v1.0.34 已闭合（「无 signature 或回退值 ≤0 → 首次审计语义」两处一致），本版本复核确认无残留
- **Low-3（failed 写覆盖旧 signature，prevBlockers 死数据）**：既有行为（v1.0.24 起），触发面窄（blocked 未注入 + spawn 失败），注入通道只认 blocked/passed-with-warning——不改，记录为已知限制
- 测试：57/57 通过，tsc 0 错误

## [1.0.34] - 2026-08-15

v1.0.33 发布后第四路独立 reviewer 复核（无 blocker；Low Note 1 同类覆盖空洞相邻边界 + Note 4 措辞不对称 + Note 5 日期）：

- **异步审计空洞兜底（Low，reviewer 实证推理）**：`git log --since` 按 commit date 过滤——提交落库于上轮异步常规轮审计运行期间（spawn 后、签名前）时，commit date < 上轮签名时间 → 下轮窗口起点之后 → 被两轮窗口同时排除、永久跳过（v1.0.31 的 4c3d997 同类处境靠审计者自觉 `git show HEAD` 兜底才过审）。改：两处 prompt 加窗口兜底自查——`git log --since` 为空且存在 signature（非首次审计）时对照 signature.head：**HEAD ≠ signature.head = 存在未审提交 → `git show HEAD` 逐个核对**；HEAD == signature.head 才走「窗口内无产物 → 审决策质量」分支
- **L2 措辞对齐 L1（Low）**：L2 的「回退值 ≤0」从降级分支嵌套改为与 L1 一致的「无 signature 或回退值 ≤0 → 首次审计语义：最近 20 个提交」——消除字面读者推出 `--since=0` 的歧义
- **CHANGELOG 日期修正（cosmetic）**：[1.0.32]/[1.0.33] 提交时间为 08-15 00:10/00:15 +0800，日期标 2026-08-15（此前标 08-14 为本地日期差一天）
- 跳过（reviewer 认可可接受）：blockedStreak 溢出路径一次性过度审计（有界无害）；D-020 vs D-039 链语义缺口（D-039 Context 已完整描述新规则，无功能影响）；D-039 目标外扩张（已如实标注「审计者建议发起」）
- 测试：57/57 通过，tsc 0 错误

## [1.0.33] - 2026-08-15

v1.0.32 发布后 L2 双路独立 reviewer 复核（两个 reviewer 结论收敛）——failed 路径同类空窗口 + 回退边界 `--since=0`：

- **failed 签名同类空窗口（Medium，双 reviewer 独立发现）**：spawn 失败路径（agent_end 写 `signature={status:"failed", at:Date.now()}`，不碰 lastAuditAt）——失败写入晚于本轮提交，下轮 failed 重试审计按 signature.at 起窗 → `git log --since` 空窗口、触发失败的提交被跳过（L1350 注释「已提交内容在审计窗口内仍会被审」对该路径不成立）。改：窗口回退条件从 passed-with-warning 扩展为 **passed-with-warning || failed**（两处 prompt：L1 增量审计 L262 + L2 交付审查 L401）；failed 的 at 不参与注入去重/isAuditCompleted（注入只认 blocked/passed-with-warning），无副作用
- **回退边界 `--since=0`（Low）**：从未审计过的新仓库首次交付轮超时降级 → passed-with-warning + lastAuditAt=0 → 回退 `git log --since=0` 恰中 approxidate 空窗口怪癖。改：无 signature 或回退值 ≤0（从未真实审计过）→ 首次审计语义（最近 20 个提交兜底）
- 保留：decision_signoff 路径不更新 lastAuditAt 的 Note（过度审计而非覆盖空洞，无害，不改）；回归测试 Note（prompt 文本无机械锚点，属既有残余风险）
- 测试：57/57 通过，tsc 0 错误

## [1.0.32] - 2026-08-15

审计窗口起点修复（v1.0.31 发布后审计者实证发现，非 blocker 建议 → 根因修复）——降级签名 at 前移导致审计空窗口：

- **审计窗口起点回退（审计覆盖空洞修复）**：signature.status==="passed-with-warning"（交付轮超时降级/连续 blocked 放行，非真实审计完成）时 signature.at 是**降级写入时间**而非审计完成时间——降级晚于产物提交 → 下轮 `git log --since=signature.at` 空窗口、未审产物被跳过（v1.0.31 实证：审计者死于 deepseek 流错误，4c3d997 实为未审产物，靠审计者自觉 git show HEAD 兜底才过审）。改：L1 增量审计任务 + L2 交付审查两处 prompt 的窗口规则——passed-with-warning 时窗口起点回退 lastAuditAt÷1000（上次真实审计边界；正常收尾时 lastAuditAt 与 signature.at 同步，回退无副作用；连续 blocked 放行时 lastAuditAt 即最后真实审计，覆盖正确）
- 测试：57/57 通过，tsc 0 错误

## [1.0.31] - 2026-08-14

L2 交付审查成本收敛（用户要求）：3 个独立 reviewer 并行 fanout → 1 个独立 reviewer 全维度单任务：

- **L2 收敛（成本优化）**：交付轮并行 spawn 3 个 fresh reviewer（正确性 / 目标一致性 / 安全健壮性）改为 1 个 fresh reviewer 一次任务覆盖全部维度（任务内按三节逐项审查）——独立性与审查深度不变，算力成本约降 2/3（3 run → 1 run），孤儿 run 登记/TTL 回收、30min (cwd, head) 冷却防重复等机制原样保留（循环结构未动，仅角度表收敛为单条目）
- 文档：README / README.zh-CN / docs/architecture.md 同步「1 个 fresh reviewer 全维度」
- 测试：57/57 通过，tsc 0 错误

## [1.0.30] - 2026-08-14

v1.0.29 发布后审计者 blocked 回归修复（M4）+ 复审 M1/L1/L2/L4 补齐——v1.0.29 生命周期修复的闭环收尾：

- **M4 stale 锁清理回归（high，审计者 blocked）**：F7 的 `deadStopped &&` 前置在无内存条目（agent_end 中断/崩溃/热重载 → 内存清空但 state.inFlight 残留）时恒 false → shouldClearStaleLock 永不执行 → v1.0.21 修过的 2.5h 假挂起回潮（会话内审计停摆到下次 session_start）。改 `(deadAuditor ? deadStopped : true) && shouldClearStaleLock(...)`——无条目时不受 stop 约束照常清锁（shouldClearStaleLock 自身 auditTooRecent 年龄条件把关，真在跑的审计不会误清）；有条目且 stop 失败（run 可能存活）才不清（保留 F7 防并发双写意图）。接线守卫补断言锁定
- **M1 孤儿定时器 stop 后不清文件锁（中，复审）**：scheduleOrphanStop 定时器到点 stop 成功但 state.inFlight 无人清 → 会话内后续轮 spawn 跳过 + 门禁 LC-03 每轮误报刷屏。改：登记带 cwd，stop 成功后按 F-02 身份守卫（auditRunId 匹配）清文件锁
- **L1 F7 stop 失败会话内无恢复路径（低-中，复审）**：deadAuditor stop 失败（rpc 忙/死）→ 条目已删无法重评估，会话内停摆到下次 session_start。改：stop 失败时孤儿登记重达（rpc 恢复后 TTL 到点重试 stop + M1 清锁复用，有界自愈）
- **L2 async-complete TTL 兜底丢 runId（低，复审）**：fire-and-forget stop 失败即丢 runId（F4/B-2 封堵的泄漏类未覆盖此路径）。改：改用孤儿登记（stop 成功自动清文件锁）
- **L4 B-1 守卫死代码（低）**：`orphanRunId === "" ||` 在外层 if 下恒 false，删除
- 测试：57/57 通过（+M4 接线守卫断言），tsc 0 错误；审计者 blocked 闭环复核（四分支推演验证）

## [1.0.29] - 2026-08-14

生命周期关系修复（v1.0.28 发布后双路独立审查 F1-F13/B-1~B-10 的剩余发现 + 用户架构原则 D-036）——审计生命周期与主会话生命周期的关系错误：

- **D-036 跨会话交付改走项目文件（high，用户原则）**：审计结论/中间态此前经 before_agent_start 注入**新会话对话**（上会话遗留结论串扰无关新任务——用户实证：run-31044 中间态注入规划 pi-follow-me 的新会话）。改：判 auditStartedAt < sessionStartAtWall = 上会话遗留 → 写 `.pi/decision-auditor/latest-audit.md`（原子写，lib writeAuditReport）+ 轻 notify，不注入对话；同会话（本会话 spawn 的审计完成、下轮闭环反馈）照旧 display:true 注入
- **F3 门禁完成分支条目残留（high）**：门禁完成/recheck 分支只推进 gatedHead 不删 inFlightAudits 条目（超时分支删、这两分支漏）→ async-complete 延迟/丢失窗口内新提交被旧签名即时放行（isAuditCompleted 对旧 auditStartedAt 即时成立）+ spawn 跳过 ≤16min 审计空窗。三分支一致删条目
- **F4/B-2 孤儿 run 回收（high）**：session_shutdown 未超 TTL 的 run 只删条目不 stop → runId 随条目丢失、挂起 run 永不可回收（无界算力泄漏）。改：未 stop 的 run 登记孤儿表（scheduleOrphanStop，TTL 剩余到点单发 stop，unref 不阻进程退出）；async-complete 匹配 runId 取消定时器；F9 L2 reviewer 登记时同步挂 TTL 定时器（挂起 reviewer 会话内回收）
- **B-1 agent_end catch 孤儿 run（中）**：catch 删条目前不 stopRun → runId 永久丢失（deadAuditor/async-complete/shutdown 全依赖条目取 runId）。改：先 await stopRun 再删；stop 成功后按 F-02 身份守卫补清文件锁（防会话内审计停摆）
- **F5 failed 重试升级同步门禁（中）**：failed 不推进 gatedHead → hasNewCommit 恒真 → 纯聊天轮也 spawn + 同步等 300s（主会话每轮阻塞 + 错误 notify 刷屏）。改：failed 重试轮（无本轮未提交产物）异步短路；判据**不含** !hasNewCommit（有未覆盖提交时 hasNewCommit 恰为 true，含之则短路恒 false）
- **F6 async-complete 先持久化后交付（中）**：去重标记落盘后 sendUserMessage 失败（print/会话关闭）→ blockers 永久不可见。改：**先交付**，成功才落盘去重；失败由注入路径接管（sendUserMessage 运行时 fire-and-forget，assertActive 抛错可捕获，静默路径由 D-036 文件通道兜底）
- **F7 stale-lock 清理按 stop 结果（中）**：agent_end deadAuditor 分支 fire-and-forget stop + 无条件清文件锁 → stop 失败且 run 存活时锁已清 → 新 spawn 并发双写。改：await stopRun 成功才允许 shouldClearStaleLock（与 F-02 同策略）
- **F8 注入去重内存 set 后置（低-中）**：内存去重标记在 patch 前 set → patch 失败（并发写高频）同会话下轮判据 false → 价值压制到进程重启。改：patch 成功后才 set（sigTriggered/interimTriggered 标志），失败保持未置位可重试
- **F10 session_shutdown 多实例隔离（低）**：shutdown 清空模块级 inFlightAudits 全表 → 同进程其他 cwd 实例条目丢失（runId 无终止路径）。改：只处理本实例 root 条目（entries 过滤 + delete 本 root，不 clear 全表）
- **F12 /pair-audit 锁重置 findings（低）**：/pair-audit 锁 patch 不含 auditFindings:[] → 旧签名结论 + inFlight=true 被误判「被中断审计」注入。与 agent_end JD#23 对齐
- 文档：docs/audit-state-machine.md 同步 v1.0.28 漂移（T5 stopRun 语义/LC-03 归属/failed 拆 spawn 超时保留锁/不变量 6 时钟容差 5min/T4 F-06 顺序/F-07 窗口等）+ v1.0.29 全量
- 测试：57/57 通过（+1：writeAuditReport 跨会话落盘原子写），tsc 0 错误；独立 reviewer 两轮复审闭环（一轮 11 点逐项 + 二轮 3 修正验证）

## [1.0.28] - 2026-08-14

生命周期审计第三轮（函数式专家 F-01~10 + Jeff Dean 系统设计 LC-01~10 双视角独立审查，独立 reviewer 复审闭环）——并发读写、多会话共享私人数据空间（.pi/decision-auditor/）、跨会话串台：

- **F-01 锁劫持根治（high）**：patchAuditState 重试曾把调用方一次性构建的陈旧 patch 值覆盖并发写者（锁获取 patch {inFlight:true, auditStartedAt} 在 attempt 1 用旧 auditStartedAt 覆盖他方已推进值 → 双实例都认为持锁各自 spawn 双审计）。patch 支持函数式重派生 `(latest) => Partial | null`：重试轮从 fresh state 重派生，最新已持锁返回 null 放弃；agent_end 与 /pair-audit 两个锁获取点改函数式（值固定到 lockStartedAtWall 变量，成功落盘后记入内存条目）
- **F-02 会话身份守卫（high）**：session_shutdown 的 inFlight:false 补丁此前无条件清锁——await stopRun（≤10s）窗口内他会话重获新锁会被清掉 → 对方审计无锁运行 + 下轮双审计。补丁加身份守卫：仅当磁盘锁仍属于被 stop 的 run（auditRunId 匹配，或 runId 为空时）才清
- **F-03/LC-05 孤儿 run 闭环（high）**：spawn rpc 900s 客户端超时 ≠ run 终止——catch 立即释放锁 + failed 标记 → 下轮重 spawn 与孤儿 run 并发双审计。改：runId 已知先 stopRun 再释放；runId 未知（rpc 超时，run 可能存活）**保留锁与内存条目**，由 TTL + stale-lock 兜底释放（并发双写转为有界停摆 ≤16min）；failed 写检查返回值——写冲突失败保留内存锁（防 failed 标记丢失 + 锁已释放双缺口）；/pair-audit catch 同策略
- **LC-03 门禁归属校验（high，串台门禁层根治）**：state.inFlight 可能属于另一会话/另一实例，其审计者签名（runId 匹配 auditRunId 单槽）会满足 isAuditCompleted → **B 会话的门禁用 A 会话的审计结论放行**（B 的提交未审即过 + A 的 blockers 注入 B）。agent_end 门禁等待前校验：state.auditStartedAt === 本会话 spawn 时写入值（内存 auditStartedAtWall）才等待；不匹配或内存无条目（跨进程/切会话）→ 不等待不签名，通知后返回（不推进 gatedHead，锁释放后下轮重审）
- **LC-06 时钟容差（中）**：state 内容时间戳由各实例 Date.now 写入，网络盘双机共享时跨主机时钟偏移破坏 at 序（慢钟机签名 at < 快钟机 auditStartedAt → 门禁永不完成 300s 假超时）。isAuditCompleted 加 CLOCK_SKEW_GRACE_MS=5min 容差（runId 身份校验仍独立把关）；测试锁定容差内完成/超容差旧签名未完成
- **LC-07 决策链并发丢条目（high）**：appendDecision 的 expectedMtime 在 readRaw 之后捕获（read→stat 窗口吸收他写者写入）+ verify 无末尾语义（两写者交错 rename 后双方都成功返回、他写者条目被吞）。mtime 先于 readRaw 取；写后验证增加「我的 id 存在且是文件末尾条目」语义校验
- **F-05 中间态注入串台（中）**：shouldInjectInterimFindings 此前只滤纯咨询占位——审计者首写 auditFindings=['审计开始'] 即 inFlight=true，新会话首轮把「在跑审计」误当「被中断审计」注入噪音（超时降级路径 v1.0.27 已前缀过滤，注入路径漏同一过滤）。启动占位 '审计开始…' 前缀过滤（混合真实 findings 仍注入）
- **F-06 注入去重前移（中，串台残留窗口）**：注入后 patch 去重标记失败（审计者并发写 mtime 冲突恰是高频场景）→ 去重只在内存 map，新会话从 state 恢复旧值 → 同签名每个新会话重复注入（「新会话还有泄露」残留窗口）。改：**先**持久化去重标记成功才注入/才 followUp；复审补：回退值用 state 持久化值（防仅中间态注入时把已持久化签名去重标记覆写 null）
- **F-07 多实例守卫时间窗（中）**：convlogForeignRuns 守卫命中一次即会话内永久停摆（外来行永久留在 append-only 文件，无恢复路径，双实例互锁禁用自动审计）。只统计本实例首行之后最近 50 条对话行内的外来行——对方停止后守卫自然恢复，无需重启
- **F-08 L2 冷却键（低）**：deliveryAuditInFlight 30min 冷却以 cwd 为键 → 同进程新会话在冷却期内的新提交被吞 L2（修复轮最需要深度审查的时刻）。冷却键改 (cwd, head)——同 HEAD 防重复，HEAD 推进 = 新交付允许重新 fanout；setTimeout unref()
- **F-09 convLineCache 键（低）**：(mtime,size) 键在粗粒度文件系统（FAT 2s）同 tick 追加且 size 不变时返回陈旧行数 → hasNewConversation 漏判。缓存键加文件尾 64B FNV-1a 弱哈希（命中即重扫，append 场景 size 单调增成本可忽略）
- **LC-08 可观测性（低）**：冲突 warn 带写者 pid（双写者排查可归因）；readAuditState catch 区分 ENOENT（首次静默）与损坏（warn 告警，此前损坏窗口内零告警读到默认值）；agent_end 成功进入审计流程清 lastError（此前只写不清，历史异常永久显示误导诊断）
- **LC-09 损坏重建丢进度（低-中）**：.corrupt 重建此前用调用方快照（损坏时 readAuditState 返回 DEFAULT）→ 进度字段（lastAuditedId/convExtractedLine/signature/gatedHead/injected*）整体归零 → 全量重审 + 门禁基线吞未审提交 + 去重丢失重复注入。改：按 mtime 新→旧扫描全部 .corrupt-* 取第一个可解析的恢复（merge 顺序防 DEFAULT 覆盖备份进度）；「清零类补丁」（inFlight/auditFindings/lastError）总是覆盖备份（failed 释放锁/JD#23 重置生效）；rebuiltFromCorrupt 跳过 rename 前 mtime 复校验（文件已被本人 rename 走，误判冲突会让恢复在重试轮失效）
- **LC-10 projectRoot 惰性复核（低）**：首次解析后终身缓存（仅 session_start 重置）——会话内 cwd 切换时 B 目录对话写入 A 根 convlog（A 的 git 状态审 B 的对话 → 跨项目串台）。每次调用与 resolveProjectRoot 复核，变化即更新缓存（纯函数一次祖先链探测，成本可忽略）
- **F-10 呼吸灯自愈（低）**：setStatus 抛错（会话异常结束/teardown 中断，timer 无 session_shutdown 清理）→ 自清 timer 灭灯，防「审计进行中」永久常亮
- 测试：56/56 通过（+4：F-01 函数式重派生 3 断言 / LC-09 备份恢复 + 清零补丁 / F-07 时间窗 / F-05 占位前缀 / LC-06 时钟容差），tsc 0 错误

## [1.0.27] - 2026-08-14

生命周期泄露审计（v1.0.26 泄露修复的残留资源闭环）——子代理 run / 文件 / 内存状态三类资源：

- **T1 审计者 run 终止闭环（高）**：常规轮异步审计者挂起时，TTL 清理只删内存锁从不 stop run → 算力泄漏 + 迟到写 state 双写竞争。统一 best-effort `stopRun`：① agent_end stale-lock 分支（TTL 过期判定 run 已死 → stop 再清内存锁，先于 hasInFlight 取记录防 runId 丢失）；② async-complete 兜底循环（TTL 过期条目 stop）；③ session_shutdown 遍历全部 in-flight run stop——stop 成功才清文件锁（run 已死不会再写，防新会话 16min 停摆；stop 失败 = run 可能还在收尾 → 保留锁，JD#15 TTL 条件兜底）
- **T2 convlog 无界增长（中）**：convlog 永久追加无滚动截断（实测 428KB/天 ≈ 156MB/年）。超 1MB 重写为头注释 + 最近 1000 条对话行（与 process.md 同模式）；历史 convExtractedLine 超界由 clampConvExtractedLine 钳制不断线；convLineCache 按 (mtime,size) 自动失效；截断只删已提取历史，无审计窗口丢失
- **T3 state 目录垃圾文件累积（低-中）**：`.corrupt-*` 损坏备份永不清理（每次损坏 +1）；崩溃窗口 `.tmp-*` 残留无人清扫。writeAuditState 写前清扫：corrupt 只保留最新 1 份、>24h 的 tmp 残留删除（原子写目录通用 `sweepAtomicWrites`）
- **T4 agent_end 异常路径内存残留（低）**：外层 catch 只落盘 lastError → inFlightAudits 残留 16min 停摆不可观测 + 呼吸灯常亮。补删内存锁 + 灭灯（文件锁不盲清——审计者可能实际在跑，留给 stale-lock TTL 年龄条件兜底）
- **T5 会话级 Map 无界增长（低）**：gatedHead / injectedSignatureAt / injectedInterimAt / nonGitRootWarned 按 root 只增不减，常驻进程长期切项目累积。session_start 清非当前 root 条目（注入去重有 state.json 持久化兜底、gatedHead 有 agent_end 惰性恢复兜底，清内存安全）
- **独立 reviewer 验证闭环修复（fresh-context 4 路交叉复核）**：
  - M1 trimConvlog 游标保底：截断保留量从「固定 1000 行」改为「游标未覆盖行永不删除 + 已覆盖历史按 512KB 字节预算倒推」——游标滞后（纯聊天不 spawn / 审计者挂起）场景未提取行不再被物理删除（D-023 延迟而非丢失承诺在滚动截断下成立）
  - M2 CJK 行宽震荡修复：maxLen=800 字符 ≈ 2.4KB/行（实证：截断后 2.04MB > 1MB 阈值，每次 append 全量重写）→ 字节预算倒推保留行，截断后 ≤512KB 收敛，CJK 回归测试锁定
  - L3 trim 原子化：writeFileSync 直接覆盖是截断写（SIGKILL 窗口可截断整个 convlog）→ 唯一 tmp + rename；mtime 写前校验（多实例共享文件 D-015 的并发 append 窗口放弃本轮）
  - L2 L2 交付 reviewer run 终止（T1 补漏）：triggerDeliveryAudit 的 3 个 reviewer run 此前无记录无终止——登记 deliveryReviewerRuns，async-complete 完成即移除，session_shutdown 对挂起 run stop（reviewer 只读无 state 写，无双写风险）
  - T1 细化：session_shutdown 仅 stop 超 TTL 的 run（刚 spawn 的正常审计者让其在会话结束后收尾，JD#15 语义——pi 运行时实证 await async handler）
- 测试 49/49（+T2 截断游标/CJK 收敛/游标滞后保底 3 回归 +T3 清扫回归），tsc 0
- **本会话双审计（FP 专家 + Jeff Dean）交叉审查修复（1200s 延迟审查轮，3 路发现合并）**：
  - **乐观锁 read→stat TOCTOU（决策审计者 D-028 偏离项，run-55708 同结论）**：expectedMtime 在写时刻捕获而非读时刻——写者落在 read→stat 间隙时 `{...raw, ...state}` 用陈旧快照覆盖 fresh raw、verify-after-write 读回自身 payload 检测不到（08-13 signatureConvLine 改写事故同类）。新增 `readAuditStateWithMtime`（stat 先于 read 配对），patchAuditState/recordSignature 改走配对读；writeAuditState/appendDecision rename 紧前 mtime 复校验（stat→rename 窗口缩到 µs）
  - **appendDecision last-writer-wins 丢失窗口（双路共识 FP#3/JD#1）**：mtime 校验原在 tmp 写前——两写者均通过校验后交错 rename → 先写者条目静默丢失且双方返回成功。复校验移到 renameSync 紧前；补重试路径行为测试（写 tmp 期间 mtime 前拨触发重读重试——JD 审计 #2 指出的重试路径零覆盖）
  - **会话边界门禁覆盖泄露（FP#1）**：TTL 内新会话继承旧审计锁 → 首轮提交门禁被「窗口早于本会话提交」的遗留签名满足（auditRunId 匹配即放行）。resetForSessionStart 保留锁时覆写 auditRunId 为新鲜值 → 遗留签名必不匹配 → 门禁可见降级、下轮全量重审
  - **auditRunId 静默写失败（FP#2a）**：现网 auditRunId=""（spawn 后 patch 冲突静默 / 审计者首写基于旧快照覆盖回空）→ runId 身份校验整段空转。`persistAuditRunId`（返回值检查 + 落盘值验证补写 + warn/lastError 可观测），agent_end 与 /pair-audit 共用
  - **decision_add 字段消毒（FP#5a）**：换行可注入伪条目（parseChain 按行宽容解析）+ 无长度上限 → 链无界增长。appendDecision 单行化 + 截断（summary 200 / context·decision·rationale 1000 / alternatives 500）
  - **超时降级占位噪音（决策审计者实证）**：「审计开始：窗口=…」未命中精确 `"审计开始"` 过滤 → 降级 blockers 当价值点注入用户。改前缀匹配 + 补滤历史「审计触发失败」残留措辞
  - **A2 blockedStreak 路径补齐（FP#5c 核实）**：审计者按协议直写 signature（不走 decision_signoff/recordSignature）→ streak 不递增、A2 门禁（≥3 连续 blocked 降级）对审计结论不响应。门禁完成点按签名状态维护（passed 清零 / blocked 递增，cap 在 MAX 防混合路径双计）
  - **接受项（文档化取舍）**：decision_signoff 无 runId 可完成门禁（semi-by-design——signoff 工具即设计签名通道）；审计者 write 通道无乐观锁（扩展侧不可拦截，纪律约束 + 审计者 prompt 字段保留清单）；recordSignature 幂等对 auditStartedAt=0 恒真（实际调用面不触发）；超时重读 duration 起算点（CI 指标无行为影响）；JD#18 公共链模式排除 docs/decisions 的漏审面（hasNewCommit 覆盖）
- 测试 52/52（49 + 双审计轮 +3：乐观锁重试 / 字段消毒 / 会话边界 auditRunId），tsc 0

## [1.0.26] - 2026-08-14

泄露审计修复（函数式专家 + Jeff Dean 双视角交叉审计，独立 reviewer 验证闭环）：

- **L3 critical：signature.head 单位错配根治**——审计者 prompt 此前要求写 `git rev-parse --short HEAD`（短哈希），扩展 `gitHead()` 返回全哈希，`shouldInjectSignatureFindings` 严格全等比较 → 审计者手写的 blocked/passed-with-warning 签名**恒判定过时、永不注入**（跨会话重注入通道被反向打成永久静默）。统一为全哈希（prompt + agents/decision-auditor.md），head 消毒补 `typeof === "string"` 守卫；回归测试用真实 git 仓库锁定（全哈希注入 / 短哈希不注入）
- **L1 锁兑现：乐观锁从"纸锁"变真锁**——新增 `patchAuditState`（字段级 patch + 读最新 + mtime 冲突重试一次）；extension 全部 9 个写点改走它；锁获取点（agent_end spawn 前置、清残留锁、/pair-audit 前置）检查返回值，冲突失败跳过本轮 spawn 防并发双审计；`writeAuditState` 的 `{...raw, ...state}` 合并写 + `flush:true`（fsync）
- **L2 消毒丢字段 + 损坏覆盖机制修复**——writeAuditState 读磁盘原文合并保留未知字段（新增字段不再被任意写者消毒删除——gatedHead 丢失事故的机制根因）；损坏 state.json 先备份 `state.json.corrupt-<ts>` 再重建，防默认值覆盖真实审计进度
- **L4 auditFindings 双写者分离**——spawn 失败记账文本从审计者拥有的 `auditFindings` 改走扩展属主字段 `signature.reason`（防超时降级把它当价值点注入用户）；降级过滤补历史残留文本
- **minor**：waitForAuditCompletion 双 sleep → 单 sleep（300s 门禁内轮询次数翻倍）；清残留锁点返回值检查；死导入清理
- **双审计（FP 专家 + Jeff Dean）泄露清单全量修复**：
  - **critical#1 共享 tmp 名**：`state.json.tmp` 被所有写者共用 → 双写者交错互相覆盖/rename ENOENT/半成品落盘。tmp 名按写者唯一（`${file}.tmp-<pid>-<时间戳36>-<随机>`），rename 失败按冲突返回 false
  - **high#2 chain.md 无锁编号**：appendDecision read→parse→nextId→append 无乐观锁 → 并发写者重复 D-NNN。加 mtime 校验 + 冲突重试（3 次）+ 写后验证（内容一致 + id 唯一），仍冲突抛错不静默追加
  - **JD#14 门禁完成判定无 run 身份**：完成判定只比 `at ≥ startedAt` → 遗留/并发审计者签名可劫持新会话门禁结论。抽为 `isAuditCompleted` 纯函数：`state.auditRunId`（spawn 后写入）与签名 `runId` 同时存在时必须匹配；failed 永不视为完成；审计者 prompt/agents 收尾协议要求签名带 runId
  - **JD#15/FP#6 锁年龄条件**：resetForSessionStart 与 shouldClearStaleLock 无条件清 inFlight → 热重载后真审计运行中被释放 → 并发双审计。均加 auditStartedAt 年龄条件（仅超 TTL 才清）；IN_FLIGHT_TTL_MS 常量移到 lib 共用
  - **JD#16 mtime 乐观锁写后验证**：rename 后重读磁盘内容 ≠ 本次写入 → 冲突返回 false（patchAuditState 重读最新重试）——单次重试不覆盖检查-写入窗口内到达的写入
  - **JD#17 静默吞错**：agent_end 外层 catch noop → 错误整轮无痕（实证 prevBlockers ReferenceError 被吞）。改 console.error + state 新增 `lastError` 字段落盘
  - **JD#18 公共链自触发循环**：PI_PAIR_CHAIN_PUBLIC=1 时 chain.md 在 docs/decisions/ 未排除 → 每次 append 变脏 → 每轮 spawn。hasUncommittedChanges pathspec 追加 `:(exclude)docs/decisions`（仅公共链模式）
  - **JD#19 超时降级盲写**：300s deadline 与审计者签名间 ≤2s 盲窗 → 真实签名被 passed-with-warning 覆盖、blockers 永久丢失。降级前用 isAuditCompleted 重读再查一次，成立走正常完成分支
  - **JD#20 signoff 幂等**：recordSignature 无条件重写 at + blockedStreak+1 → 重复 signoff 去重键失效 + streak 双计。同轮同结论（status/blockers 相同且 at ≥ auditStartedAt）→ no-op
  - **JD#21 session_start 覆盖门禁基线**：新会话无条件以当前 HEAD 为基线 → 上会话门禁前终止的提交永不过审。保留持久化基线（`st.gatedHead ?? head`）
  - **JD#22 convlog O(n) 扫描**：convLogLineCount 每轮整读 3-6 次（实测 428KB/天）。按 (mtime,size) 进程内缓存，文件未变直接返回
  - **JD#23 中间态注入窗口**：新 spawn 后、审计者写占位前 auditFindings 仍是上轮结论 → 误标「被中断审计」注入。spawn 前置写清空 auditFindings
  - **FP#3 roundDecisionMade 泄漏**：append 前置位 + agent_end 不执行（print 模式/异常）→ 残留误触发。置位移到 append 成功后 + session_start 清零
  - **FP#8 recordSignature 内嵌 git IO**：状态转移内 exec git rev-parse，瞬态失败 → head:null → 兼容注入削弱新鲜度守卫。head 改调用方传入（缺省回退上一签名 head）
  - **FP#10 锁与 spawn 间异常**：patchAuditState 抛错残留内存锁。置锁→spawn 块 try/catch，失败释放双锁
  - **FP#13 门禁超时不终止 run**：超时降级后 rpc("stop") 终止仍挂着的审计者 run（stop 失败不影响降级放行）
  - **FP#7 跨会话 plan 决策丢失**：runId 过滤 vs 共享游标矛盾——其他 run 行中的明显决策仍提取入链（标注来源 run），推导目标仍只用本会话行
  - **FP low 组**：签名消毒重建字段保留（runId/reason/head 已全量）；waitForAuditCompletion 去循环内重复 duration 写；内存锁 TTL 换 performance.now() 单调钟（墙钟跳变不早/晚过期）
- 测试：45/45 通过（+3：isAuditCompleted 完成判定 9 态 / recordSignature 幂等 / appendDecision 无重复编号；接线守卫改断 isAuditCompleted 调用）、tsc 0 错误

## [1.0.25] - 2026-08-14

根治「新会话还有泄露」（用户报障：新会话开头仍自动出现审计结论——即使内容新鲜且属于本项目）：

- **跨会话注入去重持久化**：`injectedSignatureAt`/`injectedInterimAt` 从进程内存改为 state.json 持久化字段——同一审计签名/中间态**只注入一次**（审计完成后首个 turn 或 async-complete followUp 场景），之后所有新会话不再重复弹出；内存 map 优先（同会话去重）、热重载/新会话从 state 恢复（跨会话去重）；审计者 prompt 字段保留清单 + agents/decision-auditor.md 显式要求原样保留（gatedHead 教训复用）
- **followUp 同步记录去重**：async-complete 发送 blocked 缺口 followUp 时立即持久化 injectedSignatureAt——已即时交付的结论不在下个会话再注入一遍
- 测试：去重字段往返 + 消毒 + resetForSessionStart 不清除（跨会话存活）；39/39 测试通过、tsc 0 错误

## [1.0.24] - 2026-08-14

修复跨会话/跨项目审计串台（用户报障「会话刚开始就有个审计结果」+「为什么别的会话的审计会串台」）+ 审计缺口 L1-L7 全量修复（函数式 + 系统设计双视角交叉审计）：

- **注入新鲜度校验（跨会话泄露根治）**：signature 新增 `head` 字段（审计时的产物基线 HEAD）——before_agent_start 注入判据抽为 `shouldInjectSignatureFindings` 纯函数：当前 HEAD 已推进（修复提交落库但再审未跑）→ 签名过时 → 不注入陈旧 blockers；head 缺失（旧签名）兼容注入不丢交付。审计者 prompt + agents/decision-auditor.md 收尾协议要求签名必须带 head
- **failed 重试闭环（L3）**：hasWork 加 `signature.status==="failed"` 分支——提交轮 spawn 失败后产物已落库、uncommitted/newCommit 信号都假，不加此分支 failed 永不重审、产物永不过审
- **failed 保留 blockers（L2/L7）**：spawn 失败写 failed 时保留上轮 blockers（failed 是「未审」不是「无缺口」，整体覆盖会抹掉真实缺口/降级价值点）；findings 去重（L6，重试风暴不无限累积）
- **多实例守卫前移（L4）**：convlogForeignRuns 守卫先于残留锁清理——多实例场景 state.inFlight 可能属于另一实例，非属主实例清锁会让对方审计者收尾写冲突放弃、签名丢失
- **完成判定排除 failed（L5）**：waitForAuditCompletion 只认真实审计签名——多实例下 failed.at 可晚于本轮 auditStartedAt，不排除会劫持门禁完成判定
- **门禁失败可见信号（L1）**：提交轮 spawn 失败 notify 告知「产物未过审」，不静默放行
- **/pair-audit 纳入 inFlight 状态机（L3'）**：手动命令与自动审计共用锁 + 呼吸灯 + async-complete 持续交付（此前命令不写 inFlight → 并发双 spawn、灯被先完成者误灭）
- **gatedHead 审计者保留（reviewer 实证）**：审计者收尾写曾把 gatedHead 字段整个丢掉——prompt 字段合并纪律显式要求原样保留
- **非 git 根守卫（跨项目串台主通道）**：自动解析退化为非 git 目录（典型：home 目录）时 agent_end 跳过自动审计 + 每会话一次警告——审计基线=整个磁盘，无关项目产物被当成一个项目审（实证：fence-check 审计以 `C:\Users\Nuctori` 为根，结论写入 home 根 state 被其他会话注入）。显式 `PI_PAIR_PROJECT_ROOT`（用户权威根）与手动 `/pair-audit` 不受限
- **RUN_ID 会话级（同进程切会话内容混读）**：RUN_ID 从模块顶层移入扩展工厂——pi 的 loader 对同 cwd 缓存扩展工厂、模块顶层只执行一次，模块级 RUN_ID 会让同进程切会话时两会话行混标、A 会话的审计把 B 会话的对话当自己的；三个 prompt 注入点改传参（buildAuditTask/buildIncrementalAuditTask/DELIVERY_ANGLES）
- **convlogForeignRuns 按 pid 判并发**：外来判定从「run 标记不同」改为「pid 不同」——同 pid 不同 run（同进程切会话）不算并发实例，跨进程仍检出；旧格式 run 标记（无 pid 前缀）回退全等判定
- **failed 状态语义（M2）**：spawn 失败改签 failed（非假 blocker「审计触发失败，产物未过审」）——不递增 blockedStreak、不推进 signatureConvLine（产物未被审计覆盖，下轮 hasWork 自动重试）、不注入假缺口；stale 锁清理/TTL 过期同步灭灯（防呼吸灯永久常亮——实证 7220s 卡灯）
- 测试：38/38 通过（shouldInjectSignatureFindings 行为级 7 态 + pid 判定 + 非 git 根守卫/RUN_ID 会话级接线断言 + gatedHead 往返 + failed 语义）、tsc 0 错误

## [1.0.23] - 2026-08-14

修复「陈旧 blocked 签名反复注入每个新会话」根因（用户报障：会话刚开始就有个审计结果——实证为 08-13 修复提交后再审永不触发，已修复的 blockers 在 state.json 挂 14h+ 反复注入）：

- **门禁基线持久化（M5）**：`gatedHead` 从纯内存改为 state.json 持久化字段——扩展热重载（`/reload` / `pi install`）重置内存 map 后，惰性初始化从 state 恢复上次门禁覆盖的 HEAD，不再把热重载后刚提交的修复吞成基线（`hasNewCommit=false` → 修复轮永不自动再审 → 陈旧 blocked 签名跨会话反复注入；实证：08-13 21:04 审计者签 blocked 两缺口 → 21:06 修复提交 2a0b55b → 之后无审计者 spawn，16:28 与次日会话开头各注入一次过期 blockers）。旧状态无字段时回退当前 HEAD（保持「无提交不触发门禁」语义）
- 接线点：session_start 持久化 + agent_end 惰性初始化恢复（先于 hasNewCommit 计算）+ 门禁完成/超时降级后推进
- 测试：gatedHead 读写往返 + 消毒 + M5 位置守卫；35/35 测试通过、tsc 0 错误

## [1.0.22] - 2026-08-13

TUI 审计状态呼吸灯（用户要求：审计在 agent_end 后异步运行，状态无感知）：

- **呼吸灯**：spawn 审计者成功 → TUI footer 显示转圈帧 + 已运行秒数（`- 结对审计进行中（5s）`，1s 刷新）；灭灯出口全覆盖——审计完成（async-complete）/ 门禁签名完成 / 300s 超时降级 / spawn 失败 / 会话结束。用 pi 原生 `ctx.ui.setStatus`，零新依赖（否决 pi-tui 组件：引入依赖 + 复杂度）
- **多语言**：`PI_PAIR_LANG=en` 切英文（最小双语，不引 i18n 框架——现有 notify/findings 文案仍为中文，全量 i18n 另立）；README 中英环境变量表同步
- **cwd 隔离（D2）**：async-complete 灭灯传完成审计的 cwd，仅当与亮灯 cwd 匹配才灭——多实例并发审计时先完成的审计不会误灭后启动审计的灯
- **ASCII 帧（D-026）**：spinner 帧从 braille（⠋⠙⠹）改为经典 `- \ | /`——braille 在部分终端/字体下渲染为方块乱码（用户报障「飙奇怪文字」），ASCII 任何终端零兼容问题
- 34/34 测试通过、tsc 0 错误；D-025/D-026 入链（呼吸灯 + 双语 + ASCII 帧）

## [1.0.21] - 2026-08-13

修复残留锁假挂起（用户报障：自动唤起看似没工作——实证为 17:41:45 提交轮 spawn 中断后 state.json 假 inFlight 挂 2.5h）：

- **残留锁兜底上移**：agent_end 的清残留锁逻辑从 `hasWork` 判断之后移到之前——纯咨询轮 return 前也会清锁（清锁≠spawn，不违反零噪音承诺）；防「spawn 中断后 inFlight=true 永久残留」让 state.json 一直显示假审计中
- **顺带修复旧快照 bug**：清锁后重读 state——原实现清锁后 spawn 分支仍用旧快照（inFlight=true）判断，清锁轮会跳过 spawn（残留锁释放后本轮不审计）
- 31/31 测试通过、tsc 0 错误

## [1.0.20] - 2026-08-12

修复 3 个审计边界（D-017 落地）：

- **边界① 交付检测：词表 → 客观提交信号**：删除 `DELIVERY_SIGNAL_RE` 词表与问句排除——「完工」是语义判断，模式匹配不可靠（v1.0.17 废弃 hasNewDecisionSignals 的同款结论；词表漏检 + 问句误伤「完成了吗」卡 300s 双缺陷）。改为 **git HEAD 变化**（`gitHead` + 会话级 `gatedHead` 基线）：本轮产生了提交 = 交付发生的客观事实，问句/任意措辞天然免疫；门禁与 L2 交付审查同源触发；非 git 仓库无门禁（异步审计照跑）
- **边界② 修复轮 diff 漂移**：审计任务 prompt 加 blockers 可操作规范（文件 + 基线行号 + **独立于行号的问题描述**——行号会漂移，描述是重定位锚点；末尾附 git HEAD 短哈希 + 未提交文件列表作基线）；新增修复轮核对步骤（上轮 blocked → 逐个核对旧 blockers 在新产物中是否仍成立，未修复的重报，不得因产物演进而漏掉）
- **边界③ 会话早结 findings 丢失**：`shouldInjectInterimFindings` 判据放宽——`inFlight===true`（被杀锁残留）或 `signature===null`（审计未收尾，会话早结被杀后新会话 reset 清 inFlight 的跨会话交付）；纯咨询占位（`PURE_CHAT_PLACEHOLDER`）过滤后不算真实中间态（零注入承诺保持）；注入文案标注「可能来自上次会话」
- **边界④（实证修复）审计对象错位**：审计任务第三步的审计对象从「未提交 git diff」改为「上次审计（lastAuditAt）后的已提交窗口 + 未提交 diff」——快节奏每轮提交时未提交 diff 常为空，原定义让已提交产物永不过审（实证：follow_me v22-v28 产物 signature=null）；交付轮等的审计者现在审的是不变的历史窗口 + 当前 diff，不再因产物漂移而过时；超时降级的 blockers 改用审计者已确认的 auditFindings（价值点），无 findings 才给超时提示（实证：InitDeity 8 条真实 findings 曾被「审计超时」流程文案替换）；注入文案区分 passed-with-warning（「部分发现供参考」vs blocked 的「请修复缺口」）
- 文档同步：audit-state-machine.md T1（门禁产物前置）、T2（超时降级 blockers=findings）、T4（新判据）、状态表 auditFindings 占位语义
- 测试：`shouldInjectInterimFindings` 纯咨询模拟改为占位（inFlight=false + 真实 findings 语义已变为跨会话注入）+ 新增 2 态（会话早结残留→注入 / passed 残留→不注入）；`gitHead` 行为（非 git→null / init+commit→HEAD / 新提交→HEAD 变化）
- **审查修复轮（审计者 + 3 reviewer 发现）**：① prompt `--since` 单位矛盾（lastAuditAt 毫秒喂秒 → 空窗口 → 复现边界④缺陷）→ 明确 ÷1000/ISO；② `hasWork` 判据加 `hasNewCommit`——提交后 diff 空 + 审计者可能推进对话游标 → 两便宜信号都 false → 提交轮早退绕过门禁（安全审查 Medium）；③ L2「正确性」reviewer prompt 同步为已提交窗口（L2 层已提交产物永不过审残留）；④ L2 fanout 移到多实例守卫之后（多实例场景不再白跑 3 reviewer）；⑤ `auditFindings` 每轮**替换**为占位（清旧轮陈旧内容——超时降级把 findings 当 blockers 注入时不再污染价值点）；⑥ 审计者收尾前检查主进程降级签名（passed-with-warning 已存在 → 不写签名，防超时竞态覆盖真实结论）；⑦ 陈旧注释清理（词表时代残留/L0 命名/lib 头注释/test 缩进）；D-019~D-022 入链（canGateOldAudit 删除/审计对象重定义/降级 blockers=findings/git HEAD 门禁）
- **发布前修复轮（审计者 + 3 reviewer 终审）**：⑧ `gatedHead` 惰性初始化——扩展热重载（/reload）不重发 session_start → map 空 → 「无提交也触发门禁+L2」误触发（实证：未提交却 spawn 3 reviewer）；首次 agent_end 建基线不门禁；⑨ 门禁等待 UI 告知（提交轮同步等审计时用户可感知，≤300s）；⑩ 审计窗口起点改用 `signature.at`（上次审计完成时间）+ **spawn 块不再覆盖 `lastAuditAt`**（原覆盖为当前时间 → 本轮提交全在窗口外 → HIGH find#1）；⑪ 收尾跳过签名条件收紧为「`passed-with-warning.at ≥ 本轮 auditStartedAt`」（陈旧降级不跳过——否则签名流永久停滞）；⑫ 超时降级 blockers 过滤启动/纯咨询占位；⑬ `gitHead` 加 5s 超时（与 hasUncommittedChanges 一致）；⑭ version bump 1.0.20
- **纯咨询轮零 spawn（用户实测污染）**：对话增量触发收紧为「增量 **且 本轮调用了 decision_add**」——纯咨询问答轮（含非 git 目录如用户主目录）不再 spawn 审计者（此前每轮 spawn + 后台完成通知 = 体验污染；零噪音承诺从「零注入」升级为「零 spawn」，D-006 语义扩展）；git 产物/提交仍无条件触发；plan 决策经 decision_add（skill 既有要求）触发审计者提取入链
- 31/31 测试通过、tsc 0 错误

## [1.0.19] - 2026-08-12

L2 交付审查（3 个 fresh reviewer）复审 v1.0.18 后的修复轮——无 blocker，处理 2 Medium + 4 Low：

- **clamp 落盘竞态（Medium）**：`clampConvExtractedLine` 改为纯读（不落盘）——原实现在谓词求值中做 state.json 读-改-写，与异步审计者进程形成竞态（窄窗口可覆盖刚写入的签名）。钳制落盘合并进 agent_end 的两个既有写点（残留锁释放 / spawn 前全量写）
- **B5 代码级兜底（Medium）**：`waitForAuditCompletion` 完成判定补 `at===0` 分支——审计者手写 signature 漏 `at`（消毒为 0）时，用 `lastAuditAt >= startedAt` 判定刚签名完成（收尾写必置 lastAuditAt；旧轮无 at 签名不会被误判），交付轮不再 300s 超时覆盖真实结论
- **B1 行为级测试**：注入判据抽为 `shouldInjectInterimFindings` 纯函数（lib），扩展 handler 调用它；4 态行为测试（被杀→注入 / 同轮去重 / 纯咨询零注入 / 无 findings）替换字符串守卫
- **中间态 inFlight 保真**：审计任务 prompt + agent 协议明确「中间态写入必须保留 inFlight=true，仅收尾签名写 false」——防止审计者提前释放锁导致被杀后 findings 无法注入交付
- **Low 清理**：CHANGELOG 重复 `# Changelog` 头（v1.0.18 引入的回归）、README 英文设计哲学两处对齐 D-011（chat-only quick-exit 语义）、agents/decision-auditor.md 删除不可达的 decision_signoff 优先推荐（工具不在 tools 列表）
- 30/30 测试通过、tsc 0 错误

## [1.0.18] - 2026-08-11

项目自审修复轮（决策链 D-011~D-015 已捕获 v1.0.16/v1.0.17 变更）——6 个真实缺口：

- **B1 纯咨询轮零注入承诺被打破**：中间态注入判据 `(inFlight || !signature)` 会把纯咨询轮的「本轮纯咨询，无审计对象」占位当作"审计被中断"注入 display:true（signature=null 的新项目首轮咨询必现）。改为 `state.inFlight === true`（审计在跑 = 真中断；纯咨询轮主动写 inFlight=false → 零注入）
- **B2 对话增量触发可静默断线**：convExtractedLine 单位不一致——审计者按 read 文件行号推进、扩展按 convLogLineCount（只计对话行）比较，审计者写超即断线（本仓实证 578>471）。新增 `clampConvExtractedLine`：agent_end 触发前钳制为对话行总数并落盘；审计任务 prompt 两处明确"对话行计数，非文件行号"
- **B3 权威文档自相矛盾**：signatureConvLine 语义代码（recordSignature 恒推进）与文档（blocked 不推进）冲突，且 H2 后 agent_end 已不读 convLine、L140 括号理由失效。统一为"**签名即推进**"（修复走 blockers 注入通道）——改 audit-state-machine.md T2/不变量 1/6、architecture.md、agents/decision-auditor.md、审计任务收尾文案
- **B4 判据文案过期**：README 中英「pure chat → no audit」/「不 spawn 任何 run」、architecture.md「不做 L2 交付审查的分层」与代码保留的 triggerDeliveryAudit 矛盾、lib 注释 entriesSinceLastAudit 残留、CHANGELOG 重复行——全部对齐 v1.0.16 触发判据（git 产物 or 对话增量 → 审计者 AI 判定）
- **B5 审计者手写 signature 缺 at 字段**：扩展按 `signature.at ≥ auditStartedAt` 判定审计完成，但收尾 prompt 未要求写 at → 交付轮会把真实结论误判为超时并覆盖。收尾 prompt + agents/decision-auditor.md 明确 signature 必须带 `at`（= lastAuditAt）
- **P1 自动审计永久停摆（多实例守卫误杀历史会话）**：`convlogForeignRuns` 旧语义统计 convlog 全部历史外来行，而 convlog 按 cwd 永久追加、RUN_ID 每个进程不同 → 第二个会话起守卫恒 >0，agent_end 自动审计（含修复轮复审）永久跳过，blocked 签名永不更新、过期 blockers 反复注入（实证：本仓 165+97 行历史 run 标记导致 B1-B5 修复轮复审从未触发）。修复：只统计本实例首行**之后**的外来行（并发交错窗口）——历史行不算；并发检测一侧命中即足够（先启动方必然看到后者的交错行）。P1 回归测试锁定
- 新增守卫断言（B1/B2/B3/B5 各一条）+ clampConvExtractedLine 单测 + P1 回归用例；29/29 测试通过、tsc 0 错误

## [1.0.17] - 2026-08-11

审计核实升级——两层核实（收敛 + 可控发散）：

- **收敛核实**（原有）：对账——声明的每个事实 vs 代码/仓库一致（不信任记录，事实不符 = 偏离 ✗）。只证明「声明的没错」
- **发散核实**（新增，对抗式的另一半）：在目标/决策/产物三个锚点内主动找未声明的风险，6 类攻击点：a) 未声明的假设 b) 被忽略的替代方案 c) 边界反例 d) 跨层盲区 e) 二阶效应 f) 跨领域知识迁移（把其他领域/项目/范式中同类问题的已知失败模式迁移审视——缓存穿透/竞态/状态机遗漏/规模拐点；与 CAP/ACID/幂等/背压等成熟范式的偏差是有意取舍还是无知）
- **可控边界**：每个发散点必须落回「产物/决策的某个具体缺口」才计为发现（偏离 ✗）；落不回的猜想写进 auditFindings 供参考，不硬算 blocker
- 发散核实与收敛核实同等权重（找到 = 偏离 ✗）；守卫测试锁定两层核实存在
- 28/28 测试通过、tsc 0 错误

## [1.0.16] - 2026-08-11

plan 阶段审计修复——决策信号交给 AI 判定，不做模式匹配：

- **触发判据改为两个便宜信号**：`hasUncommittedChanges(root) || hasNewConversation(root, convExtractedLine)`——git 产物 or 对话增量（无语义理解，任何会话有真实交互都触发）
- **语义判断移给审计者（第零步）**：审计任务先 AI 判定本轮有无值得审计的工作——纯咨询 → 快速退出（推进 convExtractedLine、写 auditFindings=["本轮纯咨询，无审计对象"]、不写 signature、零注入）；plan 阶段（有决策无 git 产物）→ 提取决策入链 + 审决策质量；实现阶段 → 审产物
- **废弃正则信号词判据**：`hasNewDecisionSignals`（PROCESS_SIGNAL_RE 模式匹配）删除——"那我们就用 B 吧"类真实决策不命中信号词会漏检，模式匹配无法可靠识别决策
- **修复 follow_me 式漏审**：非 git 目录有真实开发（src/*.js）→ 对话增量触发 → 审计者审；纯咨询非 git（问答）→ 审计者判无工作退出
- 新增单测：`hasNewConversation`（无对话/有对话/游标推进/新对话四态）+ 守卫断言（第零步判定存在、纯咨询退出路径存在）
- 28/28 测试通过、tsc 0 错误

## [1.0.15] - 2026-08-11

交叉审计修复（发布前）——3 个真缺陷 + 文档残留全清：

- **H1 inFlight 锁泄漏**：`recordSignature` 置 `inFlight=false`（签名=审计结束）——防 decision_signoff 路径泄漏锁导致该 cwd 审计永久停摆
- **H2 blocked 误判超时**：`waitForAuditCompletion` 完成判定改为"本轮新签名（signature.at ≥ auditStartedAt 且 !inFlight）"——blocked 签名（不推进 signatureConvLine）也被识别为本轮结论，交付轮不再把真实 blockers 误判为超时并覆盖
- **M2 交付标记泄漏**：`deliveryRequested.delete` 提前到 agent_end 最前（任何早退路径都不泄漏到下轮）
- **M3 L2 门禁硬编码**：reviewer/审计任务文本的 `docs/decisions/chain.md` 改为动态 `chainPath(cwd)`（默认 `.pi/decision-auditor/chain.md`）
- **M4 残留锁兜底**：agent_end 对"文件锁 inFlight=true 但内存锁无"（审计者被强杀）补释放——防审计永久停摆
- **文档全清**：README 中英（How-it-works/Capabilities/环境变量表/设计要点）、agents/decision-auditor.md（生命周期/查询协议/收尾幽灵字段）、docs/audit-state-machine.md（状态表/T4/T6/测试锁定）、CHANGELOG 内部矛盾段——全部对齐 fresh spawn + 单层审计最终架构
- 26/26 测试通过、tsc 0 错误

## [1.0.14] - 2026-08-10

convlog 会话隔离（多实例混写防护）——修复同 cwd 多 pi 实例共享 convlog 导致审计者把其他会话的对话当本会话决策捕获（实证：D-060~D-062/D-064 的触发来自另一开发会话的用户消息）。

### 会话隔离（D-065 落地 + reviewer 复审修复）

- `appendConv` 行尾 `<!--run:<id>-->` 标记（实例级 RUN_ID = pid+random）；process.md 意图信号同步打标
- 4 处审计/L2 prompt 注入过滤规则：提取决策/推导目标只依据本会话标记行；无标记行（升级前历史）仅作上下文、不提取；其他 run 标记行忽略
- 多实例混写检测 `convlogForeignRuns`：agent_end/agent_settled 检测到其他实例真实对话 → 跳过自动审计 + warning（run 级过滤 vs 全局状态机错配时显式降级，不静默错审）
- 接线守卫静态断言（写入点传 RUN_ID、4 处规则注入、多实例检测接通）+ 新增单测（runId 隔离、外来 run 检测）
- 31/31 测试通过，tsc 0 错误

### 审计预算调整（180s→300s / 720s→600s）+ 伪造标记修复

- 阻塞等待上限 180s→300s，协商关闭窗口 720s→600s（演进中间态；最终架构删除协商窗口——超时直接降级放行，见下方架构重构）
- 文案同步：steer 协商消息、超时 blockers、注释、审计者规约（约 120s→约 300s）、README/SVG 一致化（原 120s 声明 v1.0.12 起即过期）
- `convlogForeignRuns` 正则锚定行尾（`/<!--run:...-->\s*$/`）：真实标记由 appendConv 追加在行尾，防用户正文内嵌伪造标记误判外来实例（可永久关闭审计门禁）；新增回归单测

### 架构重构：单层审计 + fresh spawn（根治机制叠加）

- **砍 L0 独立层**：删除 `spawnL0Audit`/`buildChainAuditTask`/`accumulateRound`/`checkAuditDue`/`AuditConfig`——单层审计一次任务完成"提取决策 + 审产物 + 签名"，agent_end 按真实产物判定直接触发，无累积记账/节流
- **砍常驻 run**：删除 `ensureAuditorInLane`/`residentAuditorRunIds`/resume 复用/`auditorRunId` 字段——每次 fresh spawn（`context:"fork"` 继承主会话上下文），审计完即死，session_shutdown 只清内存锁
- **状态精简**：`AuditState` 从 13 字段减到 9（删 `roundsSinceAudit`/`pendingChars`/`chainFindings`/`auditorRunId`）——单层审计无独立链维护通道
- **L2 前置门禁**：`triggerDeliveryAudit` 前检查真实产物（git 改动 or 决策条目）——无交付物不 spawn reviewer，杜绝 follow_me 式空转（reviewer 无产物反复搜索）
- **注入收敛**：`before_agent_start` 只保留价值点（blockers/auditFindings）`display:true` 注入，删除 chainFindings 内部通道（display:false 分支）
- 代码量：扩展 1114→907 行、lib 712→607 行、测试 32→26（删 L0 记账/节流测试，新增单层架构守卫 + auditFindings 消毒）
- 26/26 测试通过、tsc 0 错误；`docs/architecture.md` 记录目标架构与设计原则

### 体验改造：结对"真实有效、好体验、无感"（根治审计感知过强）

- **真实产物判定**：agent_end 触发判据从"convlog 有增量"改为"git 未提交改动 or 未审计决策条目"——纯咨询/运维会话（无代码产物、无决策）零审计零噪音，消灭"没有产物也走审计"
- **常规轮异步不阻塞**：agent_end 常规轮 spawn 审计者后立即返回（不再 await 300s）；审计者完成写 signature，下一轮开工时经 `before_agent_start` 注入 findings
- **交付轮保留同步门禁**：用户消息含交付信号（提交/发布/merge/交付/收工/上线/部署/推送）→ agent_end 同步等签名（300s 上限）；超时降级放行 + 缺口注入下轮，不再 600s 协商黑洞
- **findings 注入替代刷屏**：blocked/超时结论经注入主 agent，用户不再看到"审计未通过（第 N/3 次）"流程刷屏；签名变化才注入（内存去重）
- 删除 `negotiateStop`（600s 协商窗口）与 `handleBlocked` 的 `sendUserMessage` 刷屏路径；A2 连续 3 次 blocked 降级放行保留
- **持续交付（R5）**：审计者边审边写 `auditFindings` 中间态到 state.json（启动即写占位、每步核实即追加）——中途被杀/超时也交付已确认的价值；审计完成（async-complete）时若 blocked → 立即 `sendUserMessage` 交付主 agent 处理（不等下轮注入）；修复 → 再审 → 直到干净
- **完成即停（R7）**：审计者签名后立即停止（prompt 明确边界），遗留疑问写 blockers/auditFindings 留给下一轮结合用户需求继续
- **状态目录排除（R11）**：`hasUncommittedChanges` 用 pathspec 排除 `.pi/`、`.pi-subagents/`（审计自身写入不算产物，防自触发）
- **价值点可观察**：审计抓出的缺口（blockers/auditFindings）`display:true` 注入——用户感知价值（最终架构：链维护内部通道已随 L0 层删除）
- **状态机文档化**：新增 `docs/audit-state-machine.md` 为权威状态转移定义（T1 触发 / T2 收尾 / T3 持续交付 / T4 注入 / T5 生命周期 / T6 recordSignature + 6 条不变量）；移除死状态 `timeout`（类型、streak 逻辑、测试同步清理——超时直接降级 passed-with-warning）
- 注入去重拆分：signature 结论与中间态各自独立去重 map（防互相覆盖重复注入）
- 新增单测：`hasUncommittedChanges`（非 git/干净/改动/未跟踪/状态目录排除五态）、接线守卫更新（fresh spawn 无 L0/常驻、async-complete 持续交付、完成即停、真实产物判定、交付标记先消费、异步不阻塞、价值点 display:true、L2 真实产物门禁、协商黑洞移除、刷屏移除）

## [1.0.13] - 2026-08-10

收敛回"一个结对审计者"（单一权威 state + L0/L1 同一 run）。

### 背景（用户批评，D-059）

双 state 分裂（C: 与 D: 两棵树各自记账）+ L0/L1 两个独立 spawn——违背"一个持灯人连续在场"的结对语义，成本语义上像"两个 agent"。

### A: 单一权威 state

- `resolveProjectRoot` 支持 `PI_PAIR_PROJECT_ROOT` 显式权威根（跨盘符场景——向上探测限于祖先链，C:\ 会话 + D:\ 项目必须显式指定）
- 扩展层会话级 `projectRoot` 缓存：session_start 解析一次固定，session_shutdown 重置；40 处 handler 调用点统一改用（杜绝同一会话双树）

### B: L0 复用 L1 常驻 run

- `spawnL0Audit` 不再 fresh spawn：`state.auditorRunId` 存在则 `resume` 同一 run（共享 L1 过程上下文 + 命中 prompt 缓存）；首次才 spawn 并记 runId——一个持灯人，两种职责，不新增实例

### 其他

- 协商关闭文案同步 120s→180s（steer 消息 + blockers 文案）

### 测试

- 28 单测通过（新增：resolveProjectRoot 显式权威根测试；接线守卫更新——projectRoot 缓存存在、无裸 resolveProjectRoot(ctx.cwd)、L0 resume 复用、PI_PAIR_PROJECT_ROOT 支持）

## [1.0.12] - 2026-08-10

- 审计预算调整：阻塞等待 120s→180s，协商关闭窗口 30s→720s（尽可能走协商关闭，确保审计真能审出东西）；总预算 900s < 960s TTL

## [1.0.11] - 2026-08-10

- README 社区级重构（中英）：badges/TOC/痛点叙事/快速开始/已知限制/Roadmap

## [1.0.10] - 2026-08-10

审计 prompt 优化（实证盲区维度）+ 路径提示修复。

### 实证盲区校准（同模型审计的教训）

审计系统用两个真实缺陷校准 prompt：①L0 累积断线（机制存在但 message_end 未接线——用户发现）②print 模式 handler 被丢弃（审计不阻塞——CI 跑分发现）。同模型审计均漏掉。

- **维度⑥ 机制完整性**：审含触发机制的产物时，验证触发链路每一环有实际调用点且可达（事件→函数→状态写入），防死代码/断线
- **维度⑦ 运行时行为 vs 声明**：产物声称"阻塞/异步/完成后 X"时，验证 print/TUI/RPC 各模式行为一致或明确标注差异
- 审计者协议 + L1 任务文本同步；接线守卫测试断言两个维度存在（防 prompt 退化）

### 路径提示修复

- 审计任务路径检查增强：指定链路径可能因 cwd 解析不准而缺失，明确引导"用 find 定位真实项目根下的链，实际位置为准"（D-036 审计者标注的遗留）

### 测试

- 27 单测通过（接线守卫 +3 断言）

## [1.0.9] - 2026-08-10

- auditStartedAt 提前到 spawn await 前写（print 模式 handler 可能被丢弃，duration 丢失）+ catch 释放 inFlight 锁
- bench 加进程级耗时测量（process_ms，不依赖扩展 handler 存活）

## [1.0.8] - 2026-08-10

- 审计阻塞时长写入移到 waitForAuditCompletion 轮询循环内（print 模式 handler 尾段不执行，原 recordAuditDuration 写不到）

## [1.0.7] - 2026-08-09

过程日志（意图信号）+ CI 跑分对比——强化 pair 通信，缩短 agent_end 阻塞。

### 背景

agent_end 阻塞的根因：审计者每轮被唤起时只有 convlog（最终回复）+ diff，需要**从产物反推意图**（最耗时）。

### 修复：过程日志（高信号过滤，成本≈0）

- **process.md**：只记 assistant 回复中命中**决策信号词**（决定/采用/放弃/方案/架构/重构/改为/引入/移除 等）的摘要（≤200 字符）；不记工具调用流水（避免膨胀）；超 100 条滚动截断（保留最近 50）
- **频率不变**：不增加审计者唤起次数（L1 每轮 + L0 攒够，同现状）——增加的是单次唤起的通信密度
- **L1 审计任务**加"读 process.md 意图轨迹，审产物时对照过程"步骤——审计者从"反推意图"变"对照意图"，阻塞时间降、准确率升
- `PI_PAIR_PROCESS_LOG=0` 可关闭（CI 跑分基线用）
- **阻塞时长测量**：agent_end 记录 `lastAuditDurationMs`（触发→签名），CI 跑分指标

### CI 跑分

- E2E 加 bench 步骤：同代码库两次跑（PROCESS_LOG=0 基线 vs =1 方案），提取 lastAuditDurationMs 对比
- 单次采样有模型噪声，结论看趋势（快/持平/慢）

### 测试

- 27 单测通过（新增：信号词命中/未命中、200 字符截断、滚动截断、lastAuditDurationMs 消毒、接线守卫补充 process 接线）

## [1.0.6] - 2026-08-09

恢复 L0 分层（链维护批量审计）+ 测试门禁（防断线回归）。

### 背景

1.1.0 设计的"增量累积唤起"（每轮记账、攒够 6 轮/8000 字符才审）自 1.4（agent_end 阻塞门禁）起**断线**：`maybeAutoAudit` 只在 `decision_add` 里被调用，message_end/agent_settled 无自动触发点；且 L1 审计者收尾会清 `roundsSinceAudit/pendingChars`——L0 永远攒不够。

### 修复：L0/L1 分层

- **L0 链维护**（非阻塞、批量）：`message_end` 每轮 `accumulateRound` 记账（零成本）→ `agent_settled`（L1 门禁之后）`checkAuditDue` 达阈值 → spawn 链维护审计：批量捕获增量决策入链 + 对抗式链级复审（五维度）→ findings 写 `chainFindings` → `before_agent_start` 低优先级注入主 agent
- **L1 产物门禁**（每轮、阻塞）：去捕获（决策入链归 L0），只审本轮产物（对抗五维度）+ 签名门禁；收尾**不清** roundsSinceAudit/pendingChars（归 L0 管）
- **L0 独立内存锁**（`l0AuditsInFlight`）：不占 state.inFlight（L1 的锁），避免 L0 抢 L1 阻塞窗口/签名语义混淆
- `decision_add`（手动）force 触发 L0 链维护审计
- `accumulatePending` 拆为 `accumulateRound`（只记账）+ `checkAuditDue`（判断+清零+返回）

### 测试门禁（防再次断线）

- L0 记账+判断：batchRounds / batchChars / minInterval / force / inFlight 全覆盖
- **分层隔离**：L1 收尾不清 L0 记账（roundsSinceAudit/pendingChars 保留）
- chainFindings 读写与消毒
- **接线守卫**：静态断言扩展源码含 message_end→accumulateRound、agent_settled→checkAuditDue+spawnL0Audit、L1 收尾不清记账、decision_add→force L0——断线直接 CI 红
- 23 单测通过（新增 6）

## [1.0.5] - 2026-08-09

对抗审计（优雅性五维度）——普通轮次从验证式升级为对抗式。

### 核心：产物默认有缺陷，逐维度尝试推翻

- **立场**：guilty until proven innocent——不"检查有没有错"，而是主动尝试推翻；五维度全部无法推翻才判 passed
- **五维度进攻清单**：① 原子性（独立评审/回滚？混入无关主题？决策链条目自足？）② 正确性（逻辑/边界/错误路径真的对？事实与仓库一致？）③ 一致性（决策间/实现与决策/既有模式一致？）④ 内聚（一个决策一个主题？职责放对？过度设计？）⑤ 完备（边界/错误/依赖/文档/测试覆盖？关键取舍入链？产物执行了决策？）
- 任一维度找到具体缺陷 → blocked（blockers 可操作）；全维度无法推翻 → passed
- 链基础检查（推理有效性/完整性/校准/Supersedes）保留为前置
- 成本 = 0：同一次审计，检查清单更专业（对抗立场 + 结构化维度，不新增 agent/调用）

### 动机

普通轮次原为验证式（检查产物是否执行决策）——单向、易走流程、同构偏见（审计者与主 agent 同模型共享上下文，天然倾向同意）。对抗立场 + 优雅性维度把审计变成"主动找茬"，收益显著提高。

## [1.0.4] - 2026-08-09

README 中英拆分 + CI E2E 真实路径验证。

### 文档

- `README.md`（英文）+ `README.zh-CN.md`（中文）拆分，顶部互相链接（社区标准做法）
- package.json description 改为英文（国际惯例）

### CI E2E 真实路径验证

- 新增第二个 E2E 场景：主 agent 做真实工作（创建 calculator.py）→ `agent_end` 阻塞审计签名闭环验证：
  - convlog 捕获用户提示 + 助手回复（捕获路径）
  - 审计签名发生（state.signature.status 非空——agent_end → 审计者 → 签名真实跑通）
  - 锁释放（inFlight=false）+ blockedStreak 追踪
- 验证结果：签名 blocked（门禁拦截）→ WARN 不失败（机制工作的证明，非断言目标）

## [1.0.3] - 2026-08-09

协商中止（negotiated stop）：审计超时后不直接 kill。

- 超时（120s）→ steer 通知审计者协商：把当前已发现的问题提前签成 blockers（主 agent 立即修复）——提前获知问题的通道；确认无问题则签名 passed
- 30s 协商收尾窗口；无响应才兜底 stop（防止窗口外继续跑）
- 审计者协议加"协商中止规约"（窗口约束的一部分）

## [1.0.2] - 2026-08-09

严格门禁 + 当场修复循环 + 窗口内通信（A2/B1/C1 设计）。

### 核心：审计是 end 的前提，缺口必须当场修

- **B1 阻塞门禁**：`agent_end` 阻塞等审计结论，**passed 才 end**；blocked → `sendUserMessage(followUp)` 触发当场修复轮 → 修复轮 `agent_end` 再次审计 → 直到 passed。用户不再收到"先完成、后纠正"的假声明——主 agent 一直工作到审计通过。
- **A2 降级退出**：连续 blocked 达 3 次 → 签名降级 `passed-with-warning` 放行（`ctx.ui.notify` 警告）——**end 就是 end**，不无限修复循环。
- **C1 窗口内通信**：审计者只在 agent_end 阻塞窗口内 `contact_supervisor`（60s 未回复即放弃，按证据给结论）；超时后扩展尝试 `stop` 审计者 run（防窗口外唤起主 agent）；跨会话疑问不残留机制——下一轮 AI 有完整上下文，会自己问。
- 审计任务/审计者协议：明确"本轮产物已完整，直接给结论"；修复轮先验证上轮 blockers 是否已修复再判定；blocked 的 blockers 必须具体可操作。

### 新增

- `blockedStreak` 连续 blocked 计数（blocked/timeout +1，passed/降级清零）
- 签名状态 `passed-with-warning`（A2 降级放行）

### 测试

- 19 单测通过（新增 blockedStreak 递增/清零/降级）

## [1.0.0] - 2026-08-09

**首个正式发布**（npm 包名为 `pi-pair`）。此前 1.1~1.6 为内部开发迭代，本版合并为 1.0.0。

提供**常驻结对审计**：每个会话自动带上一个独立审计者（"举灯人"），持续持有目标、对照决策链交叉审计每一轮产物，agent 结束时必须通过审计签名。

### 核心能力

- **常驻审计者（resume 复用）**：首次 spawn 记录 runId，后续 resume 同一个 run（带 session 历史，命中 prompt 缓存，比 fresh 全量重发便宜）
- **产物必须交叉审计**：`agent_end` 阻塞等待审计签名——未经独立审计的工作不能"结束"（120s 上限，spawn 失败标记 blocked 不静默）
- **不靠主 agent 自觉**：决策从对话日志提取（`convExtractedLine` 去重）、事实从仓库核实，审计者独立完成
- **决策链**：默认 `.pi/decision-auditor/chain.md`（私有，不污染 git）；`PI_PAIR_CHAIN_PUBLIC=1` 写 `docs/decisions/chain.md`（团队可见）
- **cwd 自适应**：`resolveProjectRoot` 从任意目录定位真实项目根
- **交付深度审查**：用户说提交/发布/merge 时，并行 fanout 3 个 fresh reviewer（正确性/目标一致性/安全健壮性）
- **工具**：`decision_add` / `decision_list` / `decision_signoff` / `/pair-audit`

### 测试

- 18 单测 + tsc + CI（unit + E2E opencode 免费模型）全绿

### 开发历史（1.1~1.6 迭代要点）

- 1.1 捕获不靠主 agent、增量累积唤起（参数经 205 历史会话校准）
- 1.2 完成前审计阶段（后移除 before_agent_start 注入）
- 1.3 三层触发（L0 捕获 / L1 签名 / L2 交付 fanout）、会话边界隔离
- 1.4 agent_end 阻塞产物审计（修复时序错位）
- 1.5 常驻审计者 resume 复用 + cwd 解析修复
- 1.6 决策链默认私有化（.pi/ 不污染 git）

---

## [1.6.0] - 2026-08-09

决策链默认私有化（不污染项目 git）+ cwd 相关配套。

### 新增：决策链默认写 .pi/ 私有目录

- **问题**：决策链默认写 `docs/decisions/chain.md`，会进项目的 git（用户没要求就多一个文件），违背"插件不越权"
- **修复**：默认写 `<项目根>/.pi/decision-auditor/chain.md`（私有，gitignore 覆盖）；设 `PI_PAIR_CHAIN_PUBLIC=1` 才写 `docs/decisions/chain.md`（团队可见，像 ADR）
- 审计任务模板、SKILL、README 同步更新路径说明

### 测试

- 验证 chainPath 默认/公开两种模式（18 单测全过）

## [1.5.0] - 2026-08-09

常量审计者（resume 复用）+ cwd 解析修复。

### 新增：常量审计者（resume 复用）

- **复用而非每次 spawn**：首次 spawn 审计者时记录 runId（state.json `auditorRunId`）；后续轮次 `resume` 同一个 run（带 session 历史，命中 provider 前缀缓存 → 缓存读取比 fresh 全量重发便宜）
- **缓存经济**：session 随轮膨胀可接受（前缀不变时命中缓存，成本递减）
- **提灯连续**：审计者 resume 后记得之前所有轮的目标/已审发现（不再每次从 convlog 重新考古）

### 修复：cwd 解析

- **问题**（审计者连续 3 次上报）：会话在 `C:\Users\Nuctori` 启动但项目在 `D:\goose`，插件用 `ctx.cwd` 导致 chain.md/state.json 写到错误位置
- **修复**：新增 `resolveProjectRoot`——从 cwd 向上最多 5 层找带仓库根标记（Cargo.toml/package.json/go.mod/.git 等）的目录，退化到 cwd；所有 handler 改用解析后的项目根
- 审计者路径检查提示仍保留（兜底）

### 测试

- 18 单测通过（新增 resolveProjectRoot 仓库根定位）

## [1.4.0] - 2026-08-09

产物交叉审计（agent_end 阻塞签名）——修复架构错位：审计时机从 turn_start（产物不存在）移到 agent_end（产物已存在）。

### 核心修复：产物必须被交叉审计

**问题**：v1.3 预启动审计在 turn_start spawn，但此刻本轮产物还不存在——审计者读的是旧 convlog/空 diff，签名是"形式签名"（只查行号），不保证本轮产物被审过。

**修复**：agent_end 阻塞交叉审计。

- **agent_end 时**：本轮有产物（convlog 新增 / 决策链新条目）→ spawn 审计者 → **await 等待完成**（Pi awaits handler，阻塞生效）
- **审计内容**：捕获本轮决策入链 → 审 git diff 产物忠实性（产物是否真的执行了决策）→ 独立核实 Context 事实
- **签名语义**：产物通过 → passed + signatureConvLine 推进；发现 blocker → blocked + signatureConvLine 不推进（待修复）
- **降低阻塞**：只审本轮增量（不审全链）+ 120s 超时上限（超时标记 blocked，不无限阻塞）+ fresh context 一次 spawn
- **spawn 失败**：产物未过审 → blocked 标记（不静默）

### 移除

- turn_start 预启动（审计时机错位的根源）
- before_agent_start 注入（不影响新一轮对话）

### 测试

- 17 单测通过

## [1.3.0] - 2026-08-09

subagent 交叉审计收敛方案：分层触发 + 会话边界隔离。

### 新增

- **L2 交付审查（fanout）**：用户明确要求交付（提交/发布/merge/交付/收工/上线/部署/推送）时，并行 spawn 3 个 fresh reviewer（正确性/目标一致性/安全健壮性）做产物级深度审查——这是多角度交叉审计的正确位置（交付前一次，不是持续跑）
- **会话边界隔离**：`session_start` 时 `resetForSessionStart` 清跨会话待签名状态（`signatureConvLine` 推进到当前 convlog 行数）——修复"新会话一开始就提醒审计"的跨会话污染；决策链审计进度（lastAuditedId/convExtractedLine）仍跨会话保留

### 架构（三层触发）

| 层 | 触发 | 审计者 | 成本 |
| --- | --- | --- | --- |
| L0 捕获 | convlog 增量累积达阈值（6 轮/8000 字符） | 1 个审计者（捕获+审决策链） | 低 |
| L1 签名 | 用户请求优先 + 未签名工作提醒 | 同上 + 自审计 | 低 |
| L2 交付审查 | 用户确认交付（提交/发布/merge） | 3 个 fresh reviewer 并行 fanout | 高（交付前 1 次） |

### 测试

- 17 单测通过（新增 resetForSessionStart 会话边界）

## [1.2.1] - 2026-08-08

交叉审计修复（基于独立 reviewer 的 3 角度审计发现）。

### 修复（按审计发现）

- **H1 锁生命周期错配**：`IN_FLIGHT_TTL_MS` 从 5min 提到 16min（> spawn 超时 15min），消除审计运行中锁过期导致的并发双审计（chain.md 重复编号 + state.json 互相覆盖）
- **H2 未插值占位符**：增量审计任务文本里 `${auditStatePath(cwd)}` 改为模板字符串（此前字面输出给审计者）
- **H3 字段名错误**：`pendingRounds` → `roundsSinceAudit`（agent 指令 + 任务文本同步）
- **H4 版本不同步**：package.json version 升到 1.2.0
- **M1 签名闭环**：新增 `decision_signoff` 工具（审计通过后签名，避免手写 state.json 整体覆盖）；注入文案改为引导用工具签名
- **M2 口径统一**：`convExtractedLine` 明确为对话行序号（## 👤/## 🤖 计数），任务文本同步
- **M3 RPC ready 探测**：ping 真正订阅 reply，收到即返回（不再固定吃满 5s）
- **M4 spawn 超时**：900s 超时传给 client（`rpc("spawn", params, 900_000)`）而非 params，消除 ACK>30s 的孤儿审计
- **M5 签名消毒**：`readAuditState` 对 signature 字段做类型消毒（坏值 → null，不再渲染 undefined）
- **M6 集成清理**：package.json 移除悬空的 `chains: ["./chains"]` 和误导性 `main`；README 补 v1.2 审计阶段章节 + 更新本地路径说明；prompts 补捕获步骤；SKILL "只读"→"只读代码"
- **M7 强制触发语义**：`accumulatePending` 加 `force` 参数，显式 `decision_add` 跳过 minInterval 节流直接触发
- **spawn 失败回写**：审计 spawn 失败时回写累积计数，避免已攒增量丢失

### 测试

- 16 单测通过（新增 force 跳过 minInterval、recordSignature 字段级写入、坏 signature 消毒）

## [1.2.0] - 2026-08-08

完成前审计阶段（pre-end signoff）：每轮工作开始前，若有未签名工作则注入审计阶段指令。

### 新增：完成前审计阶段（强制签名）

- **阶段注入**：`before_agent_start` 检测到上一轮有未签名工作（`needsSignoff`）时，注入 `pi-pair:audit-phase` 阶段提醒（`customType` 标记，非用户消息，**优先级低于用户请求**）
- **阶段内容**：自审计（agent 对照决策链/目标检查产物）→ 交叉审计（spawn decision-auditor 独立审查）→ 签名（更新 state.json `signature`）
- **优先级**：用户请求始终优先——审计是提醒不是门禁，来不及可在后续轮次补审，但尽量每次回复完成前签名

### 修复

- `convLogLineCount` 只统计对话行（此前头部注释行被误计）
- `needsSignoff` / `recordSignature` 状态机（签名后解除待签名）

### 测试

- 13 单测通过（新增 needsSignoff 状态机 + convLogLineCount）

## [1.1.0] - 2026-08-08

改名 **pi-pair**（原 pi-decision-auditor）+ 捕获机制重做（核心修复）。

### 核心修复：捕获不再依赖主 agent 自觉

**问题**：v1.0 的 `decision_add` 依赖主 agent 主动调用——它不调，链条在第一步就断（实际使用中零调用）。这违背了"主 agent 不可靠"的前提（不可靠的主 agent 也不会可靠地记录决策）。

**修复**：捕获责任转移给审计者。

- **审计者从 convlog 提取决策入链**：被唤起时第一步读对话日志增量（`convExtractedLine` 定位），识别主 agent 实际做的关键决策（方案取舍/架构改动/采纳的用户要求），按四元组 append-only 写入 `chain.md`——不靠主 agent 调用任何工具
- **增量累积唤起**（参数由 205 个历史会话数据校准）：每轮结束零成本记账 convlog 增量，达到阈值才 spawn 审计者，审计变批量、异步、跟随主任务节奏
  - `batchRounds: 6`（累积 5 决策的 p90=9 轮、p50=4 轮 → 6 轮折中）
  - `batchChars: 8000`（累积 3-5 决策字符 p50≈7.7k-9.6k）
  - `minIntervalRounds: 2`（防决策密集时频繁唤起，间距 p50=1）
  - `maxBatchRounds: 15`（决策稀疏兜底，间距 max=15）
  - 决策信号词即时触发**弃用**（54% 轮含信号词 = 开了等于每轮唤起）
- **手动 `decision_add` 仍即时触发**（主 agent 主动记录 = 强信号）
- 全部参数可用环境变量覆盖：`PI_PAIR_BATCH_ROUNDS` / `PI_PAIR_BATCH_CHARS` / `PI_PAIR_MIN_INTERVAL` / `PI_PAIR_MAX_BATCH`

### 实测（本地 + CI 免费模型）

- 主 agent 三步决策（Redis → 本地缓存 supersede → pytest），审计者**自动提取 3 条入链**（四元组完整、supersede 关系正确）并审出全部一致 ✓
- 11 个单测通过（含增量累积 4 条路径）
- CI 用 opencode CLI 免费模型（免 key、免登录）跑通 E2E

### 其他

- 包名/仓库名/agent runtime 名改为 `pi-pair` / `pi-pair.decision-auditor`

## [1.0.0] - 2026-08-08

首个正式发布。

### 核心能力

- **结对式自动唤起**：`decision_add` 落地即自动 spawn 审计者增量审计；每轮结束（`agent_settled`）补审未审决策；去重锁（state.json `inFlight` + 内存 TTL 双保险）防重复 spawn
- **目标推导**：扩展在 `message_end` 确定性写入 `convlog.md`（只记用户提示 + 助手回复，非全文 transcript）；审计者从对话日志独立推导任务目标——主 agent 自述不可信，以对话记录为准
- **漂移检测**：每条决策对照推导目标审漂移，识别目标外扩张
- **决策链审计（五问 + 两新增维度）**：推理有效性 / 完整性 / 链一致性 / 校准 / **正确性**（独立核实 Context 事实，抓虚构数字、过度设计、方案不可行）/ 产物忠实性（`--diff`）
- **独立核实**：审计者用 read/grep/find + 只读 bash（git log/diff、which、`python -c import`、npm ls）验证 Context 中每个可核实事实，不信任记录
- **查询式暴露**：证据不足 → `contact_supervisor(interview_request)` 按需问主会话；链矛盾 → `contact_supervisor(need_decision)` 请求裁决
- **链自愈**：发现矛盾 → 裁决 → 新条目 `Supersedes` 闭合，append-only 全程保持
- **工具**：`decision_add`（自动编号 D-00X、append-only、supersede 声明）、`decision_list`（读链）、`/pair-audit`（手动全量/定向/`--diff` 审计）
- **状态管理**：`lastAuditedId` 记录已审范围，跨会话持久，审计只跑增量

### 组件

- `extensions/decision-chain.ts`：工具 + 自动唤起 + convlog + pi-subagents RPC
- `lib/chain-store.ts`：chain.md / convlog / state.json 存储
- `agents/decision-auditor.md`：审计者协议（fresh context、只读 + state.json 收尾解锁）
- `skills/decision-chain/SKILL.md`：writer 侧纪律
- `prompts/pair-audit.md`：命令帮助

### 已知限制

- 本地路径安装（`pi install ./...`）时 pi-subagents 不自动发现包内 agent，需手动复制到 `~/.pi/agent/agents/`；npm/git 分发自动发现
- shell allowlist 可能拦截审计者的只读命令执行（exit 126），审计者以物理文件核查兜底
- `subagent:async-complete` 内存锁匹配不可靠，依赖 TTL + 文件锁兜底
