// SPDX-License-Identifier: MIT
// 结对决策审计（pi-pair）主扩展
// 提供：decision_add / decision_list 工具、/pair-audit 命令、增量累积自动唤起、链状态轻量注入。

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	appendAuditReport,
	appendConv,
	appendDecision,
	appendProcessSignal,
	auditLogPath,
	auditStatePath,
	backfillAuditLogIfNeeded,
	clampFutureSignatureAt,
	chainPath,
	clampConvExtractedLine,
	convLogLineCount,
	convlogForeignRuns,
	convlogPath,
	generalizationPath,
	gitHead,
	hasNewConversation,
	hasUncommittedChanges,
	IN_FLIGHT_TTL_MS,
	isAuditCompleted,
	isPlaceholderFinding,
	listEntries,
	parseChain,
	processPath,
	readAuditLog,
	readAuditState,
	readProcess,
	readRaw,
	recordSignature,
	queryGaps,
	renderEntry,
	resetForSessionStart,
	resolveProjectRoot,
	shouldClearStaleLock,
	shouldInjectInterimFindings,
	shouldInjectSignatureFindings,
	patchAuditState,
	writeAuditReport,
	auditReportPath,
} from "../lib/chain-store.js";
// ---- pi-subagents RPC 通道（进程内事件总线）----
const RPC_READY = "subagents:rpc:v1:ready";
const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const RPC_VERSION = 1;

interface RpcEnvelope {
	version: number;
	requestId: string;
	method: string;
	params?: unknown;
	success?: boolean;
	data?: unknown;
	error?: { code: string; message: string };
}

/** 最小 RPC client：发请求并等待 reply（超时兜底）。pi-subagents 未启用时报错。 */
function makeRpc(pi: ExtensionAPI) {
	return function rpc<T = unknown>(
		method: string,
		params?: unknown,
		timeoutMs = 30_000,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const requestId = `decision-auditor-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
			let off: (() => void) | undefined;
			const timer = setTimeout(() => {
				if (off)
					try {
						off();
					} catch {
						/* noop */
					}
				reject(
					new Error(
						`pi-subagents RPC '${method}' 超时（${timeoutMs}ms）。确认已安装 pi-subagents 扩展。`,
					),
				);
			}, timeoutMs);
			const handler = (data: unknown) => {
				const env = data as RpcEnvelope | null;
				if (!env || env.requestId !== requestId) return;
				if (off)
					try {
						off();
					} catch {
						/* noop */
					}
				clearTimeout(timer);
				if (env.success) resolve(env.data as T);
				else reject(new Error(env.error?.message ?? `RPC '${method}' 失败`));
			};
			off = pi.events.on(`${RPC_REPLY_PREFIX}${requestId}`, handler);
			pi.events.emit(RPC_REQUEST, {
				version: RPC_VERSION,
				requestId,
				method,
				params,
				source: { extension: "pi-pair" },
			});
		});
	};
}

/** 等待 pi-subagents RPC ready（限时）。ping 真正订阅 reply，收到即返回（不再固定吃满 5s）。 */
function waitForRpcReady(pi: ExtensionAPI, timeoutMs = 5000): Promise<void> {
	return new Promise((resolve) => {
		const requestId = `decision-auditor-ping-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const unsubs: Array<() => void> = [];
		const cleanup = (): void => {
			clearTimeout(timer);
			for (const u of unsubs) {
				try {
					u();
				} catch {
					/* noop */
				}
			}
		};
		const timer = setTimeout(() => {
			cleanup();
			resolve(); // 超时兜底
		}, timeoutMs);
		const offReply = pi.events.on(`${RPC_REPLY_PREFIX}${requestId}`, () => {
			cleanup();
			resolve(); // 收到 ping reply = RPC 就绪
		});
		if (offReply) unsubs.push(offReply);
		const offReady = pi.events.on(RPC_READY, () => {
			cleanup();
			resolve();
		});
		if (offReady) unsubs.push(offReady);
		pi.events.emit(RPC_REQUEST, {
			version: RPC_VERSION,
			requestId,
			method: "ping",
			source: { extension: "pi-pair" },
		});
	});
}

/** 审计触发参数。 */
interface AuditOptions {
	onlyFrom?: string;
	withDiff?: boolean;
	message?: string;
}

/** 从消息 content 提取文本（跳过 tool_use / reasoning 等非文本部分）。 */
function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object") {
			const p = part as { type?: unknown; text?: unknown };
			if (p.type === "text" && typeof p.text === "string") {
				parts.push(p.text.trim());
			}
		}
	}
	return parts.join("\n").trim();
}

/** 审计状态：正在跑的标志（进程内去重，避免同批新条目重复 spawn）。
 *  v1.0.28 双审计（F-01/LC-03）：条目增加 auditStartedAtWall——spawn 时写入 state 的
 *  auditStartedAt 墙钟值，门禁归属校验用（B 会话不得用 A 会话 spawn 的审计签名放行
 *  门禁；见 agent_end 门禁等待前校验）。startedAt 仍为单调钟（TTL 判定不受墙钟跳变）。 */
const inFlightAudits = new Map<
	string,
	{ runId: string; startedAt: number; auditStartedAtWall: number }
>();
const AUDITOR_AGENT = "pi-pair.decision-auditor";

/** 审计者 run 的模型覆盖（v1.0.44）：deepseek-v4-flash 流式输出有
 *  "Stream ended without finish_reason" 中断史（provider 侧瞬时错误）→ 审计者 run
 *  内容完整却标 failed，用户观感"审计没收尾"。设 PI_PAIR_AUDITOR_MODEL 可指定
 *  更稳的模型（如 deepseek-v4-pro / glm-5.2）；未设置则继承主会话模型（原行为）。 */
const AUDITOR_MODEL = process.env.PI_PAIR_AUDITOR_MODEL?.trim() || undefined;

/** cwd 是否有进行中的审计（含 TTL 过期清理）。TTL 用单调钟（performance.now）——
 *  墙钟跳变（NTP 校时/用户改时钟）会让 Date.now 差值早过期（并发双审计）或晚过期
 *  （审计停摆）——FP 审计 low：内存锁 TTL 不受墙钟影响。 */
function hasInFlight(cwd: string): boolean {
	const rec = inFlightAudits.get(cwd);
	if (!rec) return false;
	if (performance.now() - rec.startedAt > IN_FLIGHT_TTL_MS) {
		inFlightAudits.delete(cwd);
		return false;
	}
	return true;
}

/** 用 decision-auditor 审 1 条新决策的审计任务文本。 */
function buildIncrementalAuditTask(cwd: string, runId: string): string {
	const lines: string[] = [];
	lines.push(
		"你是本会话的结对审计者（单层）。本轮工作已完成，你负责：① 从对话提取关键决策入链（不靠主 agent 自觉）② 审计本轮产物并签名。两件事一次完成。",
	);
	lines.push(
		"【窗口约束】常规轮你在 agent_end 之后异步运行（主 agent 已结束本轮，不阻塞等待你）——本轮产物已完整（不会有后续产物），直接给结论；发现 blocker 就给可操作的 blockers。交付轮（本轮 git HEAD 变化）主 agent 经后台轮询等你的签名（不阻塞），此时尽快收尾：若审计超时，主 agent 会降级放行并把你的 blockers 注入下轮。",
	);
	lines.push(
		"【交付通道（v1.0.44 澄清）】发现 blocker **不需要** contact_supervisor——扩展会在你签名后经 async-complete 立即 sendUserMessage 交付 blockers 给主 agent（不等下轮注入）；contact_supervisor 仅用于需要即时裁决/澄清的场景（推理存疑、链矛盾需主会话补数据）。**签名即交付**：放心写 blockers。",
	);
	lines.push(
		"【state 写入纪律（最高优先，事故教训：2026-08-13 reviewer 实证审查期间 signatureConvLine 3139→3159 被并发改写——审计者 write 全量覆盖了 extension 并发推进的字段）】state.json 是共享文件（extension 与审计者子进程并发读写）。每次 write 前**必须 read 最新内容**；write 的 content = **最新原文 + 只修改你负责的字段**（中间态：auditFindings/inFlight；推进：convExtractedLine；收尾：signature/lastAuditedId/lastAuditAt/signatureConvLine；**gatedHead 是扩展的门禁基线字段，无论何时都必须原样保留**——v1.0.24 实证：审计者收尾写曾把 gatedHead 字段整个丢掉，导致热重载后修复提交再被吞；**injectedSignatureAt/injectedInterimAt 是扩展的跨会话注入去重标记，同样原样保留**（v1.0.25：丢则审计结论在每个新会话重复注入——「新会话还有泄露」报障根因）；**blockedStreak 是扩展的 A2 连续 blocked 计数域，同样原样保留**（v1.0.42 实证：误写 blockedStreak=2 触发 streak 2→3 提前 A2 降级——blockers 虽保留但降级时机失真）），**其他字段原样保留**——禁止全量覆盖任何你没在最新 read 里见过的字段；write 后**立即 read 验证**你的字段生效且其他字段未被你的 write 改动；若 read 发现你负责的字段已被 extension 或他人推进（值 > 你 read 时的值）→ 基于最新值继续，绝不回退覆盖。**宁可中间态多写，不可覆盖他人字段**。",
	);
	lines.push(
		"【中间态交付（最重要，任何时刻被杀都要有产出）】用 write 更新 state.json 时**先写中间态再继续**（按【state 写入纪律】：只改 auditFindings/inFlight 两字段，其他字段原样保留）：启动后立即把 auditFindings **替换**为占位（如 ['审计开始']）——**清掉上一轮的旧 findings**（超时降级会把 findings 当 blockers 注入，陈旧/已解决内容会污染价值点）；之后每完成一步核实（推导目标 ✓ / 提取决策 ✓ / 读 diff ✓ / 逐维度进攻 ✓），就把该步的已确认事实与已发现缺口**追加**进 auditFindings。你随时可能被超时终止（SIGINT 强杀，收尾来不及）——已写入的 auditFindings 就是你的部分审计结果，主 agent 下轮会读到并交付给用户。**宁可中间态多写，不可最后一起写**：最后一步签名（passed/blocked）只是收尾，auditFindings 才是价值交付的主通道。**中间态写入必须保留 inFlight=true**（仅收尾签名时写 inFlight=false）——扩展按 inFlight===true 判定「审计被中断」并注入中间态，提前置 false 会让被杀后的 findings 无法交付。",
	);
	lines.push(
		"【完成即停（明确边界）】一旦你写完了最终 signature（passed/blocked），审计即结束——**立即停止，不再追加、不再验证、不再扩大范围**。签名后的一切继续都是浪费。任何遗留疑问写进 blockers/auditFindings，留给下一轮会话结合用户需求再继续。",
	);
	lines.push(`项目目录: ${cwd}`);
	lines.push(`决策链: ${chainPath(cwd)}`);
	lines.push(
		`对话日志: ${convlogPath(cwd)}（只记用户提示与助手最终回复，供你推导目标与提取决策）`,
	);
	lines.push(
		`【会话隔离】convlog 由同一 cwd 下多个 pi 实例共享追加：本会话行 = 带 \`<!--run:${runId}-->\` 标记的行，推导目标/提取决策**优先**依据它们；无标记行（升级前历史/无法归属）仅作上下文理解、不得据此推导；其他 run 标记的行（其他实例的对话、审计者 run 自己的输出）不用于推导目标——但若窗口内它们**含明显的关键决策**（方案取舍/架构决定），仍应提取入链（标注来源 run；v1.0.26：共享游标会越过其他 run 的行，忽略即永失——跨会话 plan 决策静默丢失修复）。`,
	);
	lines.push(
		`审计状态: ${auditStatePath(cwd)}（含签名状态、convExtractedLine 与 auditFindings）`,
	);
	lines.push(
		"【路径检查】若上述决策链/状态文件不存在：用 ls 检查 cwd 是否仓库根（有 src/ Cargo.toml 等），不是则定位真实项目根（向上找 Cargo.toml/package.json/go.mod/.git）再审计；链的实际位置以 find 到的真实文件为准（指定路径可能因 cwd 解析不准而缺失）。",
	);
	lines.push("");
	lines.push("【第零步：判定本轮是否有值得审计的工作（先做这个）】");
	lines.push(
		"用 read 读对话日志增量（convlog 自 convExtractedLine 之后）。判断本轮是否有**决策性工作**（方案取舍/采纳用户要求/架构决定/推翻旧决策）或**产物**（代码改动/文件）。",
	);
	lines.push(
		"**若本轮纯咨询**（如技术对比问答、信息查询，无决策无产物）：**快速退出**——用 write 更新 state.json：inFlight=false、convExtractedLine 推进到当前对话行总数（只数 `## 👤`/`## 🤖` 行，不是文件行号）、auditFindings=['本轮纯咨询，无审计对象']，**不写 signature 不注入任何价值点**（用户零感知）。退出后立即停止。",
	);
	lines.push(
		"**若本轮产物为低价值窗口**（v1.0.45 收敛纪律）：产物仅文档/格式改动（.md/CHANGELOG/README/package.json 版本号等，无代码逻辑改动）**且窗口内无新决策**——**轻量退出**：按收尾流程签名 passed（inFlight=false、convExtractedLine/signatureConvLine 推进），auditFindings=['本轮仅文档/格式改动，无审计对象']，**不做五维度进攻**（文档内容一致性核对可 1-2 行概述）。**轻量退出前置守卫（v1.0.74，reviewer M1/M2 实证：at 换算错误致空窗口 + 兜底被跳过 = 系统性漏审）**：判定'仅文档/格式'前必须① 完成窗口兜底交叉对照（HEAD≠signature.head 时 git show HEAD + 完整 git log 比对，**空 --since 窗口不豁免**——空窗口 + HEAD≠head 时默认走兜底）；② 窗口内全部提交逐个 git show 确认无代码逻辑改动（含兜底对照捕获的提交）；对照结果写进 auditFindings。**at 写法（v1.0.74，M2 根因）**：signature 的 at 必须写**当前 epoch ms（Date.now() 语义）**，不要从可读时间手动换算（LLM 换算常错 +10min → 下轮窗口起点未来 → 漏审；扩展会钳制超差 at，但正确书写优先）。**注意**：若文档改动实际隐含行为/设计决策（如 CHANGELOG 描述功能、README 改架构说明），不得轻量退出——照常全量审计。**修复轮守卫（v1.0.46，reviewer Medium）**：上轮 signature.status==='blocked' 且 blockers 非空时**不得轻量退出**——先执行【上轮缺口核对】核验 blockers 闭环（修复提交恰为纯文档是常见型：blocker 是'CHANGELOG 缺记'类文档问题时修复即文档提交，轻量退出会绕过'仍成立必重报'不变量），核验后再签名。",
	);
	lines.push(
		"**若有决策性工作或产物**：继续以下步骤——提取决策入链 + 审决策/产物质量 + 签名。",
	);
	lines.push("【第一步：提取增量决策入链】");
	lines.push(
		"1. 用 read 读对话日志，从 state.json 的 convExtractedLine 标记的对话行之后开始（convExtractedLine = ## 👤/## 🤖 行计数）。",
	);
	lines.push(
		`2. 识别主 agent 实际做的关键决策（方案取舍/架构改动/采纳的用户要求），**优先用 decision_add 工具追加**（走扩展 appendDecision：mtime 乐观锁 + 只追加，无全量重建）；decision_add 不可用时：read 全文 → write 原文完整内容 + 新条目（一个字符都不能少）。**全量重建禁令（v1.0.48d，事故：2026-08-15 write 全量重建 80KB 链被系统性压缩至 47KB，逐字不可恢复）**：chain.md ≥ 50KB 时**禁止 write 全量重建**——新条目经 decision_add 追加；若 decision_add 不可用，写进 auditFindings 由主 agent 用 decision_add 追加。编号 = 现有最大 D-NNN+1。不记：命名、格式、单文件实现细节。**链写入纪律（事故教训：2026-08-13 曾误用 write 覆盖致 D-001~D-013 丢失）**：必须 = 原文完整内容 + 新条目追加（一个字符都不能少），禁止整体重写/精简/截断；无把握时宁可不写（留 auditFindings）也不要覆盖。`,
	);
	lines.push(
		"3. 用 write 更新 state.json：convExtractedLine 推进到当前对话行总数（单位：只数 `## 👤`/`## 🤖` 开头的行，不是文件行号；写错单位会被扩展钳制，但写对可避免重审）。无决策也推进。（按【state 写入纪律】：只改 convExtractedLine 字段，其他字段原样保留；若 read 发现 convExtractedLine 已被推进 > 你的值 → 基于最新值继续）",
	);
	lines.push(
		"【subagent 决策捕获（v1.0.48）】subagent（writer/reviewer/并行任务）不在 convlog 里，主 agent 转述是其唯一可见通道：① convlog/决策条目中主 agent 转述的 subagent 决策性选择（方案取舍/架构决定/reviewer 建议采纳）→ 提取入链，Context 标注来源（如『来源: subagent writer run-xxx』）；② 链条目 Context 引用 subagent 报告/结论 → 用只读命令独立核实其可验证事实（subagent 结论与主 agent 自述同等不可轻信）；③ 主 agent 未转述 = 无记录可提取——不猜不脑补。",
	);
	lines.push("");
	lines.push("【第二步：推导目标】");
	lines.push(
		"1. 用 read 读对话日志末尾（convlog 最后几条），从用户原话推导本轮任务目标（主 agent 自述不可信）。",
	);
	lines.push(
		`2. 用 read 读过程日志（${processPath(cwd)}）——主 agent 的意图轨迹（决策信号摘要），对照它理解‘为什么这么做’，审产物时核对产物是否偏离了过程中表达的意图。`,
	);
	lines.push(
		"3. 读决策链已有条目（chainPath 下的 chain.md），找与本轮相关的最近决策作为对照基准。",
	);
	lines.push("");
	lines.push("【第三步：审计本轮产物（核心，对抗式）】");
	lines.push(
		"立场：产物默认有缺陷（guilty until proven innocent）。不要‘检查有没有错’——要主动尝试推翻：每个维度找具体缺陷，找到 = 偏离 ✗；五个维度全部无法推翻才判通过。",
	);
	lines.push(
		"1. **审计对象 = 上次审计后的全部产物**：① 自**上次真实审计完成时刻**之后**已提交**的改动——窗口起点 = state.json 的 signature.at（上次审计者签名的 epoch ms，正常收尾时与 lastAuditAt 同步）；**但 signature.at ≤ 0（缺失/非法——readAuditState 清洗为 0，B5 实证审计者曾漏写 at，v1.0.35 补）或 signature.status 为 'passed-with-warning'（交付轮超时降级/连续 blocked 放行）或 'failed'（spawn 失败，v1.0.33 补：失败写入同样在 agent_end、晚于提交）时，signature.at 不是真实审计完成时间（为 0 或晚于产物提交）→ `git log --since=signature.at` 空窗口、未审产物被跳过（v1.0.31 实证：审计者死于流错误降级，4c3d997 靠 git show HEAD 兜底才过审），此时窗口起点回退 lastAuditAt÷1000（上次真实审计边界）**；无 signature 或回退值 ≤0（从未真实审计过）→ 首次审计语义：用最近 20 个提交兜底；用 `git log --since=<窗口起点÷1000 epoch 秒>`（**13 位毫秒必须 ÷1000 转秒**；或用 `git log --since='YYYY-MM-DD HH:MM:SS'` ISO 时间，或 `git log --oneline -20`）定位窗口内提交，`git show <commit>` 逐个审（**勿用 `--since=0`——git approxidate 怪癖会得空窗口**）。**窗口兜底自查（防异步审计空洞，v1.0.34；v1.0.36 触发扩展；v1.0.37 完整列表）**：存在 signature（非首次审计）且 **HEAD ≠ signature.head**（上次审计的产物基线）时——无论窗口是否为空——用 `git show HEAD` 结合完整 `git log --oneline` **与窗口内提交列表交叉对照**：HEAD 侧可见但不在窗口列表内的提交（commit date 早于窗口起点——上轮异步审计运行期间落库 → 被两轮窗口同时排除）= 未审提交，逐个核对后再判定。② 当前未提交 diff（`git diff`）。按五维度逐项进攻①原子性 ②正确性 ③一致性 ④内聚 ⑤完备（详见维度定义）。**窗口内无任何产物（无新提交且无未提交 diff；HEAD == signature.head 或首次审计）**：审决策质量——本轮提取的决策条目是否自足（Context 可验证/Decision 明确/Rationale 由 Context 推出/Alternatives 认真考虑）？决策是否服务于推导出的目标（有无漂移）？",
	);
	lines.push("2. **独立核实（两层，缺一不可）**：");
	lines.push(
		"   ① 收敛核实（对账）：用 read/grep 核实产物/决策中**声明的每个事实**与代码/仓库一致（不信任记录，事实不符 = 偏离 ✗）。——这层只证明「声明的没错」。",
	);
	lines.push(
		"   ② 发散核实（主动找未声明的风险——对抗式的另一半）：在目标/决策/产物三个锚点内**主动发散**，找出产物没声明但影响结果的因素。具体攻击点：a) 未声明的假设——产物依赖了什么隐含前提（数据规模/时序/权限/单写者）？前提不成立会怎样？b) 被忽略的替代方案——还有没有更简单的做法？当前选择是唯一解还是惰性解？c) 边界反例——输入/状态/并发/失败路径的极端情况产物没覆盖？d) 跨层盲区——决策链条目之间、产物与既有模式之间有没有没说破的冲突？e) 二阶效应——这个改动/决策的后续影响（维护成本/迁移/依赖）有没有被忽略？f) 跨领域知识迁移——把**其他领域/项目/范式**中同类问题的已知失败模式迁移过来审视：这个实现/决策在其他语境下犯过的错（缓存穿透/竞态/状态机遗漏/约定冲突/规模拐点）在这里会不会重演？当前方案与成熟范式（CAP/ACID/幂等/背压等）的偏差是有意取舍还是无知？**发散要可控**：能落回「产物/决策某个具体缺口」的 = 偏离 ✗（blockers）；**落不回缺口的路径型发现**（更优替代/跨域范式/边界反例的泛化形态——主 agent 没想到的候选路径，非缺陷）→ 写进报告的【泛化发现与复查】「### 泛化发现」section（一行一条）；无落点的纯猜想仍写 auditFindings 供参考。",
	);
	lines.push(
		"   发散核实抓到的问题与收敛核实同等权重：找到 = 偏离 ✗（blockers 写具体可操作缺口）。",
	);
	lines.push(
		"3. 【两个实证盲区维度，必查】⑥ 机制完整性：若产物含触发机制（事件→函数→状态写入），用 grep 验证每一环有实际调用点且可达——不是死代码/从未被触发（例：声称每轮记账唤起审计，但事件处理里没有调用 = 偏离 ✗）。⑦ 运行时行为 vs 声明：产物声称‘阻塞/异步/完成后 X’时，确认该行为在 print / TUI / RPC 各模式下都成立；模式相关则标注差异（例：print 模式可能不等待扩展 handler 的 async 完成）。",
	);
	lines.push(
		"4. 【链一致性检查（v1.0.52）】① 悬空引用：被 Supersedes 的决策仍被其他条目引用（Context/Alternatives 提及）→ 悬空引用 = 偏离 ✗；② 传递一致性：D-XXX 依赖的决策被推翻后，D-XXX 自动成为缺口候选——标注『待重审』（条件变化需重新评估）；③ 临时假设标注：条目 Context 含未验证假设（无数据/无用户原话支撑）→ Confidence 降级 + 标注『条件性决策，条件变化需重审』。",
	);
	lines.push("");
	lines.push(
		'【上轮缺口核对（修复轮必做）】读 state.json 的 signature：若 status==="blocked" 且 blockers 非空，先逐个核对上轮 blockers 在本轮产物中是否仍成立——已修复的明确标注已解决、从结论中移除；仍成立的**重报**（修复轮不得因产物演进而漏掉未修复缺口）。',
	);
	lines.push(
		"【修复轮收敛纪律（v1.0.45，防审计无限唤起）】本轮若为修复轮（上轮 blocked 后再次被唤起）——**立场收窄：只核验上轮 blockers 是否闭环，不扩大范围主动寻找新问题**。新发现仅限两类：① blocker 级缺陷（会导致数据丢失/状态损坏/安全问题的真缺陷）→ 照常 blocked；② 其余一切（Low/Note/风格/可改进项）→ 写入 auditFindings 供下轮参考，**不升级为 blocker**。修复轮的核心价值是验证修复、推动收敛，不是制造下一轮修复。对抗式立场只在首轮/新交付全量审计时启用。",
	);
	lines.push(
		"【blockers 可操作规范（防 diff 漂移）】每条 blocker 必须含：① 文件路径 ② 审计基线行号（你读到的当前行号）③ 问题描述——描述必须**独立于行号成立**（下一轮修复时产物可能已演进，行号会漂移，描述是重定位锚点）。blockers 末尾附审计基线：git HEAD 全哈希 + 未提交文件列表（用 `git rev-parse HEAD` 与 `git status --porcelain` 获取），供主 agent 判断基线是否已漂移。",
	);
	lines.push("");
	lines.push("【输出】逐条判定（一致 ✓ / 偏离 ✗ / 需裁决 ⚠）+ 产物总评。");
	lines.push(
		`【报告落盘（证明链，先报告后签名）】写 signature **之前**，先把本轮审计报告 append 到 \`${auditLogPath(cwd)}\`（与 chain 同目录策略；write 纪律同 chain.md：read 全文 → content = 原文完整内容 + 新条目，一个字符不少，禁止整体重写）。条目格式：\`## AUDIT-<epoch ms>: <passed|blocked|low-value>\`，字段 Verdict / Head（= \`git rev-parse HEAD\` 全哈希）/ Window（审计窗口概述：决策范围+提交+未提交文件）/ Blockers（无则'无'）/ RunId（= state.json 的 auditRunId）/ Date（ISO），空行后附正文 = 你的审计输出（目标推导+独立核实+逐条判定+总评，多行原样）。真实审计必写；轻量退出写 \`low-value\` 简短条目；纯咨询**不写**（零噪音）。**audit-log ≥ 30KB 落盘豁免（v1.0.60 修正：不用 write 落盘，扩展会原子补写）**：文件 ≥ 30KB 时**禁止 write 触碰 audit-log**（全量重建压缩风险）——你只需把结论写进 state.json（signature/blockers/auditFindings），扩展会在审计完成时用 appendAuditReport（tmp+rename 原子写）补写元数据条目，证明链无空洞。写完报告再写签名——报告是证明链主体，签名是结论；先报告后签名保证你被杀时报告仍在。`,
	);
	lines.push(
		"【证明缺口自查（顺手，不额外 spawn）】写报告前用 read 对账（gap 分析是 AI 能力，不依赖工具）：① chain.md 中 Date 晚于 audit-log 最新条目 Date 的 D-NNN = 决策未审，报告正文记录（非本轮窗口的存量缺口，仅记录不升级）；② audit-log 最近条目为 interrupted（上轮超时降级）→ 本轮报告注明『上轮中断，本轮补填』；③ blocked 后无新条目 = 上轮缺口未闭环，修复轮按【上轮缺口核对】核验即可。",
	);
	lines.push(
		"【泛化发现与复查（v1.0.48c，pair 的多头注意力沉淀）】泛化发现 = 发散核实的路径型产出（主 agent 没想到的候选路径，非缺陷）：\n" +
			"① **沉淀**：发散核实中发现但落不回缺口的路径（更优替代/跨域范式/边界反例的泛化形态）→ **append 到 ${generalizationPath(cwd)}（gaps.md，v1.0.60 独立原语库——audit-log ≥30KB 豁免不殃及泛化通道）**，一行一条 `- 场景: <场景> | 路径: <路径> | 来源: <D-NNN/blocker/AUDIT-id>`；无则省略。**行格式必须严格保持 `- 场景: X | 路径: Y | 来源: Z` 单行形态（v1.0.51，解析器按此解析，偏差即静默丢失——48d/50 已两次实证对不齐）**：不要用粗体头、不要拆多行、不要改字段名；**不要直接回抄 pair_gaps 工具输出**（其展示带 `[audit]` 前缀，非沉积格式，须按标准格式重写）。能落回缺口的仍走 blockers/auditFindings 原通道，不重复。\n" +
			"② **复查（查询泛化缺口）**：用 read 扫 gaps.md **最近 10 条**泛化发现与本轮场景语义比对（只扫尾部，防增长文件全量读）：场景相关且本轮踩了同类盲区 → 报告标注『泛化缺口复发』（有产物证据才升级 blocker）；场景相关未踩 → 不动作；同一路径给出 ≥2 次且决策链无采纳记录 → 标注『建议固化为审计维度』（蒸馏出口）。**原语语义聚类（v1.0.52）**：把语义相近的路径归为同一原语（如『局部最优陷阱』『防御纵深』），报告标注原语名+频次——跨场景模式识别，供主 agent 开工前检索。\n" +
			"③ **边界**：修复轮**不执行**复查（收敛纪律，只核验 blockers）；纯咨询/轻量退出不写泛化 section。签名语义不变——泛化发现是附加产出，不影响 passed/blocked 判定。",
	);
	lines.push("");
	lines.push(
		`【收尾】**收尾前自查（防异步审计空洞，v1.0.37）**：head 是签名时刻 HEAD——审计运行期间落库的中间提交已含入 head，下轮 HEAD==signature.head 时兜底自查检测不到（v1.0.36 复核 Medium），须在源头补审：重新执行你建立窗口时的 \`git log --since=<窗口起点>\`（同一命令形式）与首次执行结果**比对**，新增提交（快照后落库：commit date 晚于窗口起点、早于签名时刻）逐个 \`git show\` **补审后再签名**；head 照常写签名时刻的 \`git rev-parse HEAD\`（已含补审提交，注入新鲜度检查不受影响）。写 signature **之前**先用 read 看 state.json（按【state 写入纪律】：收尾只改 signature/lastAuditedId/lastAuditAt/signatureConvLine 字段，auditFindings 保留原值不删不覆盖；若 read 发现 signatureConvLine 已被 extension 推进（> 你 read 时的值）→ 基于最新值推进，绝不回退覆盖）：若已有 signature 且 status==="passed-with-warning" **且 at ≥ 本轮 auditStartedAt**（at 是本轮内主 agent 才因交付轮超时降级——陈旧降级（上轮遗留/blockedStreak≥3）不跳过，照常签名，否则签名流永久停滞：blockers 只留 findings、下轮被替换占位抹除）→ **不再写签名**（避免覆盖降级结论，仅保留 auditFindings 后停止）。否则用 write 更新 ${auditStatePath(cwd)}：inFlight=false，lastAuditedId 推进，lastAuditAt 置当前。产物通过 → signature={status:"passed", at:<当前 epoch ms>}、signatureConvLine 推进到当前对话行总数；发现 blocker → signature={status:"blocked", at:<当前 epoch ms>, blockers:[...具体可操作缺口]}（**blockers 必填非空（v1.0.68 强化，v1.0.66 实证：审计者漏写致修复轮守卫/价值注入/补写条目全部失效）**——无 blockers 的 blocked 不完整）、signatureConvLine 同样推进（签名即推进——修复走 blockers 注入通道，不靠 convLine 滞后）。**signature 必须带 at 字段**（值 = lastAuditAt，epoch ms）——扩展按 signature.at ≥ auditStartedAt 判定审计完成，缺 at 会被交付轮误判为超时。**signature 必须带 head 字段**（值 = \`git rev-parse HEAD\` 输出，你审计时的产物基线全哈希，与扩展 gitHead() 同格式）——扩展按 head 与当前 HEAD 是否一致校验注入新鲜度，缺 head 时陈旧签名会在后续会话反复注入（跨会话泄露，v1.0.24）。**signature 必须带 runId 字段**（值 = 你 read 到的 state.json 的 auditRunId）——扩展按 runId 与本次 spawn 匹配校验门禁完成身份，缺 runId 时遗留/并发审计者的签名可能劫持门禁结论（v1.0.26）。**保留本轮 auditFindings（不删）**。写完后立即停止。`,
	);
	lines.push(
		"写权限仅限：append chain.md + append audit-log.md（报告）+ 改 state.json。禁止修改任何其他文件。",
	);
	return lines.join("\n");
}

/** A2 门禁：连续 blocked 达到该次数后降级放行（end 就是 end，不再触发修复轮）。 */
const MAX_BLOCKED_STREAK = 3;
/** F-12（v1.0.39）：门禁等待超时上限（同步等待 300s 语义保留，改后台轮询）。 */
const GATE_TIMEOUT_MS = 300_000;
/** F-12：门禁后台轮询 timer（root → interval）——message_start 用户消息中断等待用。 */
const gatePollTimers = new Map<string, ReturnType<typeof setInterval>>();

function buildAuditTask(
	cwd: string,
	opts: AuditOptions,
	runId: string,
): string {
	const lines: string[] = [];
	lines.push("你是本会话的结对决策审计者（只读）。");
	lines.push(`项目目录: ${cwd}`);
	lines.push(`决策链: ${chainPath(cwd)}`);
	lines.push(
		`对话日志: ${convlogPath(cwd)}（只记用户提示与助手最终回复，供你推导任务目标）`,
	);
	lines.push(
		`【会话隔离】convlog 由同一 cwd 下多个 pi 实例共享追加：本会话行 = 带 \`<!--run:${runId}-->\` 标记的行，推导目标/提取决策**优先**依据它们；无标记行（升级前历史/无法归属）仅作上下文理解、不得据此推导目标；其他 run 标记的行（其他实例的对话、审计者 run 自己的输出）不用于推导目标——但若其中含明显的关键决策（方案取舍/架构决定），仍应提取入链（v1.0.26：共享游标会越过其他 run 的行，忽略即永失）。`,
	);
	lines.push(
		"【路径检查】若上述决策链不存在：用 ls 检查 cwd 是否为仓库根（有 src/ Cargo.toml 等）；不是则定位真实项目根，链的实际位置以 find 到的真实文件为准（默认 .pi/decision-auditor/chain.md，PI_PAIR_CHAIN_PUBLIC=1 时在 docs/decisions/chain.md）。",
	);
	if (opts.onlyFrom) {
		lines.push(`审计范围: 自 ${opts.onlyFrom} 起的新增决策（含该条）`);
	} else {
		lines.push("审计范围: 决策链全部条目（若链很长，优先最近未审过的）");
	}
	lines.push("");
	lines.push("按审计协议执行：");
	lines.push(
		"0. 先推导目标：用 read 读对话日志，从用户提示中推导任务目标（用户要什么、约束是什么）。主 agent 自述不可信，以对话记录为准。",
	);
	lines.push(
		"0.5 再对照目标审漂移：每条决策是否服务于推导出的目标？还是主 agent 在做目标之外的事？",
	);
	lines.push(
		"0.7 独立核实：用 read/grep/find + 只读 bash（git log/diff、which、python -c import、npm ls 等）去仓库核实 Context 里每个可核实事实（文件/依赖/数字/用户原话）。禁止任何写命令（不 install/commit/rm/写文件）。不信任记录，事实不符 = 偏离 ✗。",
	);
	lines.push(
		"1. 逐条审推理链（Context/Decision/Rationale/Alternatives/Confidence）；",
	);
	lines.push(
		"2. 推理存疑、证据不足 → contact_supervisor(interview_request) 问主会话要真实上下文；",
	);
	lines.push("3. 发现链矛盾 → contact_supervisor(need_decision) 请求裁决；");
	lines.push(
		"4. 正确性：决策本身对吗——事实与仓库一致？收益现实？过度设计？方案技术可行？",
	);
	lines.push("5. 输出逐条判定（一致 ✓ / 偏离 ✗ / 需裁决 ⚠）+ 链健康度总评。");
	lines.push(`禁止修改代码和 ${chainPath(cwd)}。`);
	if (opts.withDiff) {
		lines.push("");
		lines.push(
			"额外要求：读取当前产物 diff（git diff），对照决策链检查产物是否忠实执行了每条决策。",
		);
	}
	if (opts.message) {
		lines.push("");
		lines.push(`主会话补充要求: ${opts.message}`);
	}
	return lines.join("\n");
}

/** L2 交付审查：spawn 1 个 fresh reviewer 做产物级全维度深度审查（交付前一次；v1.0.31 成本收敛：原 3 角度并行 → 单审查者一次任务覆盖全部维度）。 */
const DELIVERY_ANGLES: Array<{
	name: string;
	prompt: (cwd: string, runId: string) => string;
}> = [
	{
		name: "全维度",
		prompt: (cwd, runId) =>
			`你是交付前独立审查者（全维度：正确性/回归 + 目标一致性/漂移 + 安全/健壮性）。项目: ${cwd}。\n` +
			`审自上次真实审计（.pi/decision-auditor/state.json 的 signature.at——上次审计完成时间；**signature.at ≤ 0（缺失/非法——readAuditState 清洗为 0）或 signature.status 为 passed-with-warning（超时降级/连续 blocked 放行）或 failed（spawn 失败）时 signature.at 不是真实审计完成时间 → --since 空窗口、未审产物被跳过，窗口起点回退 lastAuditAt÷1000；无 signature 或回退值 ≤0（从未真实审计过）→ 首次审计语义：最近 20 个提交**，勿用 --since=0——git approxidate 怪癖会得空窗口）之后**已提交**的改动（git log --since + git show 逐个提交，13 位毫秒必须 ÷1000 转秒）与当前未提交 diff（git diff）；**窗口兜底：存在 signature（非首次审计）且 HEAD ≠ signature.head（上次审计基线）时——无论窗口是否为空——用 \`git show HEAD\` 结合完整 \`git log --oneline\` 与窗口列表交叉对照**（commit date 早于窗口起点的提交——上轮异步审计运行期间落库——被两轮窗口同时排除，会在 HEAD 侧可见而不在窗口列表内）；**收尾自查：重新执行窗口 git log 与首次结果比对，审计运行期间落库的新提交逐个 \`git show\` 补审后再输出**，以及 ${chainPath(cwd)}（默认 .pi/decision-auditor/chain.md，PI_PAIR_CHAIN_PUBLIC=1 时在 docs/decisions/chain.md）：\n` +
			`1. 正确性/回归：改动是否有 bug、边界错误、回归风险；实现是否忠实执行了决策链中的每条决策（产物 vs 决策对照）；决策链有无矛盾/悬空 supersede。\n` +
			`2. 目标一致性/漂移：读 .pi/decision-auditor/convlog.md（用户提示记录）推导任务目标。注意 convlog 由同一 cwd 下多个 pi 实例共享追加——本会话行 = 带 \`<!--run:${runId}-->\` 标记的行，推导目标只依据它们；无标记行（升级前历史/无法归属）仅作上下文、不得据此推导；其他 run 标记行（其他实例/审计者输出）忽略。当前改动是否服务于推导出的用户目标？有无目标外扩张？决策链条目是否与用户实际要求一致？主 agent 自述不可信，以 convlog 用户原话为准。\n` +
			`3. 安全/健壮性：注入/越界/未处理错误/竞态等安全问题；状态损坏路径（如审计状态文件、并发写）；不变量破坏（append-only、supersede 语义等）。\n` +
			`输出：按严重度排序的问题清单（文件:行号 + 建议）。只读，不改文件。\n` +
			`【低价值窗口轻量退出（v1.0.45 收敛纪律，与 L1 同构）】窗口内提交/未提交改动仅文档/格式（.md/CHANGELOG/README/package.json 版本号，无代码逻辑改动）且无新决策 → 输出简短确认（1-2 行概述文档一致性核对结果）即可，不做全维度深度审查。**轻量退出前置守卫（v1.0.77，与 L1 同构——reviewer M1/M2 实证：at 换算错误致空窗口 + 兜底被跳过 = 系统性漏审，L2 交付门禁路径同风险）**：判定'仅文档/格式'前必须① 完成窗口兜底交叉对照（HEAD≠signature.head 时 git show HEAD + 完整 git log 比对，**空 --since 窗口不豁免**）；② 窗口内全部提交逐个 git show 确认无代码逻辑改动；对照结果写进输出。**例外**：文档改动隐含行为/设计决策（CHANGELOG 描述功能、README 改架构说明）→ 照常深度审查。**修复轮守卫（v1.0.46，与 L1 同构）**：读 state.json 若上轮 signature.status==='blocked' 且 blockers 非空 → 不得轻量退出——先逐条核验 blockers 是否已修复闭环（修复提交恰为纯文档是常见型：blocker 是'CHANGELOG 缺记'类文档问题时修复即文档提交，轻量退出会绕过'仍成立必重报'不变量），核验后再输出。`,
	},
];

/** 触发 L2 交付审查：spawn 1 个 fresh reviewer（全维度单任务）。
 *  v1.0.28 双审计 F-08：防重复键从 cwd 改为 (cwd, head)——30min 冷却曾以 cwd 为键，
 * 同进程同 cwd 新会话在冷却期内的新提交被吞 L2（修复轮最需要深度审查的时刻）；
 * 冷却只针对同 HEAD（同一次交付），HEAD 已推进（新提交）视为新交付允许重新 fanout。 */
async function triggerDeliveryAudit(
	pi: ExtensionAPI,
	rpc: ReturnType<typeof makeRpc>,
	readyPromise: Promise<void>,
	cwd: string,
	runId: string,
	head: string,
): Promise<void> {
	// 防重复：同一 HEAD 的交付审查进行中不再触发（HEAD 推进 = 新交付 → 重新 fanout）
	const key = `${cwd}:${head}`;
	if (deliveryAuditInFlight.has(key)) return;
	deliveryAuditInFlight.add(key);
	try {
		await readyPromise;
		for (const angle of DELIVERY_ANGLES) {
			try {
				const result = await rpc<{ runId?: string; asyncId?: string }>(
					"spawn",
					{
						agent: "reviewer", // 内置 reviewer（fresh，独立）
						task: angle.prompt(cwd, runId),
						async: true,
						context: "fresh",
					},
					900_000,
				);
				// L2 reviewer run 登记（T1 补漏）：spawn 的 reviewer 此前无记录无终止——
				// 挂起 = 算力泄漏（reviewer 只读无 state 写，无双写风险）。登记后：
				// async-complete 完成即移除；session_shutdown 对剩余挂起 run stop。
				const rid = result?.runId ?? result?.asyncId ?? "";
				if (rid) {
					deliveryReviewerRuns.add(rid);
					// F9（v1.0.29 双审计）：reviewer 挂起此前只在 async-complete 移除或
					// session_shutdown stop——整场会话无界泄漏。登记时挂 TTL 定时器：
					// 超 TTL 未完成即 stop（async-complete 到达时 cancelOrphanStop 取消）。
					// 本函数为模块级（工厂内 stopRun 不可见）——定时器回调直接用 rpc 参数。
					if (!orphanRunTimers.has(rid)) {
						const timer = setTimeout(() => {
							orphanRunTimers.delete(rid);
							void rpc("stop", { runId: rid }, 10_000).catch(() => {
								/* noop */
							});
						}, IN_FLIGHT_TTL_MS);
						timer.unref?.();
						orphanRunTimers.set(rid, timer);
					}
				}
			} catch {
				/* 单个角度失败不阻塞其他 */
			}
		}
	} finally {
		setTimeout(() => deliveryAuditInFlight.delete(key), 30 * 60 * 1000).unref();
	}
}

const deliveryAuditInFlight = new Set<string>();
/** 在跑（未完成）的 L2 交付 reviewer runId（T1 补漏）：async-complete 移除，session_shutdown 终止。 */
const deliveryReviewerRuns = new Set<string>();
/**
 * 孤儿 run 回收定时器表（v1.0.29 双审计 F4/B-2）：session_shutdown 时未 stop 的
 * 审计者 run（未超 TTL 让其收尾 / stop 失败）在此登记，TTL 到期单发 stop——
 * 会话结束 ≠ run 结束，条目清空后 runId 不能随之丢失（挂起 run 永不可回收 =
 * 无界算力泄漏）。unref：不阻止进程退出（扩展宿主在线时到期触发）。
 */
const orphanRunTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ---- 审计状态呼吸灯（TUI footer 常驻指示）：spawn 亮、完成/失败/超时灭 ----
// setStatus(key, text) 是 footer 持久状态（传 undefined 清除）；无 i18n 框架，
// 最小双语：PI_PAIR_LANG=en 切英文，默认中文（与现有 notify 文案一致）。
const UI_LANG: "zh" | "en" = process.env.PI_PAIR_LANG === "en" ? "en" : "zh";
const AUDIT_STATUS_KEY = "pi-pair-audit";
// 呼吸帧（ASCII spinner）：braille 帧（⠋⠙⠹）在部分终端/字体下渲染为方块乱码
// （用户报障「飙奇怪文字」）——用经典 `- \ | /`，任何终端/字体零兼容问题（D-026）
const AUDIT_BREATH_FRAMES = ["-", "\\", "|", "/"];
// 缓存 ui 引用：async-complete 回调无 ctx（只有 data），需在 spawn 时保存
let cachedAuditUi: ExtensionUIContext | null = null;
let auditBreathTimer: ReturnType<typeof setInterval> | null = null;
let auditBreathStart = 0;
let auditBreathCwd: string | null = null; // cwd 隔离：多实例并发审计时只灭自己的灯（D2）

function auditStatusText(secs: number, findings: number): string {
	const frame =
		AUDIT_BREATH_FRAMES[Math.floor(secs) % AUDIT_BREATH_FRAMES.length];
	if (findings > 0) {
		return UI_LANG === "en"
			? `${frame} pair audit in progress (${secs}s) · ${findings} findings`
			: `${frame} 结对审计进行中（${secs}s）· 已发现 ${findings} 项`;
	}
	return UI_LANG === "en"
		? `${frame} pair audit in progress (${secs}s)`
		: `${frame} 结对审计进行中（${secs}s）`;
}

/** 亮灯：spawn 审计者后调用（常规轮异步/门禁轮后台轮询共用）。 */
function startAuditBreath(ui: ExtensionUIContext, cwd: string): void {
	cachedAuditUi = ui;
	auditBreathCwd = cwd;
	auditBreathStart = Date.now();
	try {
		ui.setStatus(AUDIT_STATUS_KEY, auditStatusText(0, 0));
	} catch {
		/* print/无 UI 模式降级 */
	}
	startFindingsObserver(ui, cwd);
	if (auditBreathTimer) clearInterval(auditBreathTimer);
	auditBreathTimer = setInterval(() => {
		const secs = Math.round((Date.now() - auditBreathStart) / 1000);
		try {
			cachedAuditUi?.setStatus(
				AUDIT_STATUS_KEY,
				auditStatusText(
					secs,
					auditBreathCwd ? (findingsCount.get(auditBreathCwd) ?? 0) : 0,
				),
			);
		} catch {
			// F-10（v1.0.28 双审计）：setStatus 抛错 = ui 已失效（会话异常结束/
			// teardown 中断，timer 无 session_shutdown 清理）——继续每秒空转写 stale
			// ui 纯浪费。自愈：清 timer 灭灯，防“审计进行中”永久常亮。
			try {
				cachedAuditUi?.setStatus(AUDIT_STATUS_KEY, undefined);
			} catch {
				/* noop */
			}
			if (auditBreathTimer) {
				clearInterval(auditBreathTimer);
				auditBreathTimer = null;
			}
			cachedAuditUi = null;
			stopFindingsObserver(auditBreathCwd ?? undefined); // F-10 自愈：观察器同停（reviewer Note-4）
			auditBreathCwd = null;
		}
	}, 1000);
}

/**
 * 灭灯：审计完成（签名/async-complete）/ 超时降级 / spawn 失败 / 会话结束。
 * cwd 可选：async-complete 传完成审计的 cwd，仅当与亮灯 cwd 匹配才灭（多实例隔离，D2）；
 * 其余出口（门禁完成/超时/spawn 失败/会话结束）不传 = 无条件灭。
 */
function stopAuditBreath(cwd?: string): void {
	if (cwd !== undefined && auditBreathCwd !== null && cwd !== auditBreathCwd) {
		return; // 完成的是其他 cwd 的审计，不动当前灯（多实例并发）
	}
	if (auditBreathTimer) {
		clearInterval(auditBreathTimer);
		auditBreathTimer = null;
	}
	stopFindingsObserver(auditBreathCwd ?? undefined);
	try {
		cachedAuditUi?.setStatus(AUDIT_STATUS_KEY, undefined);
	} catch {
		/* noop */
	}
	cachedAuditUi = null;
	auditBreathCwd = null;
}

// ---- 结对可观察性（v1.0.55）：审计运行中轮询 findings 增量，轻量 notify + 呼吸灯摘要 ----
// 审计者边审边写 auditFindings（中间态交付），此前只在被杀/下轮注入——运行中黑盒
// （用户实证：119s 完全不知道结对在干什么）。20s 轮询 state.json：有新条目 → notify
// （价值点，非流程噪音——符合"价值可观察、流程隐藏"）；审计完成（inFlight=false）→ 自停。
const findingsObservers = new Map<string, ReturnType<typeof setInterval>>();
const lastFindingsJson = new Map<string, string>();
const findingsCount = new Map<string, number>();
/** 连续读到 inFlight=false 的次数（Low-2：防瞬时读失败误自停） */
const idleTicks = new Map<string, number>();

function findingsObserverTick(ui: ExtensionUIContext, root: string): void {
	try {
		const st = readAuditState(root);
		// 连续 3 次 inFlight=false 才自停（reviewer Low-2：瞬时读失败返回 DEFAULT
		// 时 inFlight 恒 false，单次即停会永久丢失本轮可观察性）
		if (!st.inFlight) {
			const n = (idleTicks.get(root) ?? 0) + 1;
			if (n >= 3) {
				stopFindingsObserver(root); // 审计完成：观察器自停
				stopAuditBreath(root); // F-13：观察器是纯 state 轮询——事件通道
				// （async-complete）丢失时唯一可靠的灭灯兜底。F-11 修过多实例短路
				// 场景的常亮（实证 17006s），但 event 未达 + 无并发实例时 agent_end
				// 三条通道全部空转（state 已干净 → stale 清理/短路判据不成立）→
				// 灯常亮数小时（实证 12085s）。观察器每 20s 读 state，inFlight=false
				// 即审计完成——与 stopFindingsObserver 同点灭灯，事件无关。
				// （编号 F-13：F-12 已为 v1.0.39 门禁等待超时上限占用——审计者观察）
				return;
			}
			idleTicks.set(root, n);
			return;
		}
		idleTicks.delete(root);
		const json = JSON.stringify(st.auditFindings);
		const last = st.auditFindings[st.auditFindings.length - 1];
		const isPlaceholder = !last || isPlaceholderFinding(last);
		// 计数排除占位（reviewer Low-3：审计开始占位不算发现）
		const realCount = st.auditFindings.filter(
			(f) => !isPlaceholderFinding(f),
		).length;
		if (realCount > 0) findingsCount.set(root, realCount);
		if (json !== lastFindingsJson.get(root) && !isPlaceholder) {
			lastFindingsJson.set(root, json);
			const clip = last.length > 60 ? last.slice(0, 60) + "…" : last;
			try {
				ui.notify(
					UI_LANG === "en" ? `pair audit: ${clip}` : `结对审计中：${clip}`,
					"info",
				);
			} catch {
				/* print/无 UI 模式降级 */
			}
		}
	} catch {
		/* noop */
	}
}

function startFindingsObserver(ui: ExtensionUIContext, root: string): void {
	stopFindingsObserver(root);
	try {
		lastFindingsJson.set(
			root,
			JSON.stringify(readAuditState(root).auditFindings ?? []),
		);
	} catch {
		lastFindingsJson.set(root, "[]");
	}
	const t = setInterval(() => findingsObserverTick(ui, root), 20_000);
	t.unref?.();
	findingsObservers.set(root, t);
	findingsObserverTick(ui, root); // 立即一次：已有 findings 时马上可见
}

function stopFindingsObserver(root?: string | null): void {
	if (root) {
		const t = findingsObservers.get(root);
		if (t) {
			clearInterval(t);
			findingsObservers.delete(root);
			findingsCount.delete(root);
			lastFindingsJson.delete(root);
			idleTicks.delete(root); // reviewer Low：残留计数会让下轮首个 tick 误自停
		}
		return;
	}
	for (const t of findingsObservers.values()) clearInterval(t);
	findingsObservers.clear();
	findingsCount.clear();
	lastFindingsJson.clear();
	idleTicks.clear();
}

export default function (pi: ExtensionAPI): void {
	const rpc = makeRpc(pi);
	const readyPromise = waitForRpcReady(pi);

	/** best-effort 终止审计者 run（T1 生命周期泄露修复）：
	 *  TTL 过期/会话结束判定 run 已死时调用——挂起的审计者 run 不终止 = 算力泄漏 +
	 *  迟到写 state 双写竞争。stop 失败（rpc 通道已死/run 已自然结束）不阻塞清理路径。 */
	const stopRun = async (runId: string): Promise<boolean> => {
		if (!runId) return false;
		try {
			await rpc("stop", { runId }, 10_000);
			return true;
		} catch {
			return false;
		}
	};

	/**
	 * 登记孤儿 run（v1.0.29 F4/B-2）：TTL 剩余时间后 best-effort stopRun。重复登记幂等。
	 * cwd 必传：stop 成功后按 F-02 身份守卫清文件锁（M1 集成缺口修复，v1.0.30 审计者
	 * blocked）——定时器到点 run 已死但 state.inFlight 无人清 → 会话内后续轮 spawn
	 * 跳过 + 门禁 LC-03 误报「属于其他会话」每轮刷屏，停摆到下次 session_start。
	 */
	function scheduleOrphanStop(
		cwd: string,
		runId: string,
		remainingMs: number,
	): void {
		if (!runId || orphanRunTimers.has(runId)) return;
		const timer = setTimeout(
			() => {
				orphanRunTimers.delete(runId);
				void (async () => {
					const stopped = await stopRun(runId); // TTL 到期：run 判定已死，stop 防迟到写竞争
					if (!stopped) return;
					try {
						const st = readAuditState(cwd);
						if (st.inFlight && (runId === "" || st.auditRunId === runId)) {
							patchAuditState(cwd, { inFlight: false });
						}
					} catch {
						/* noop */
					}
				})();
			},
			Math.max(remainingMs, 1000),
		);
		timer.unref?.();
		orphanRunTimers.set(runId, timer);
	}

	/** 取消孤儿回收（run 已自然完成/被 stop）：async-complete 匹配到 runId 时调用。 */
	function cancelOrphanStop(runId: string): void {
		const t = orphanRunTimers.get(runId);
		if (t) {
			clearTimeout(t);
			orphanRunTimers.delete(runId);
		}
	}
	// 本会话唯一标识（进程 + 随机）：convlog 按 cwd 多实例共享追加的隔离键。
	// 会话级（非模块级——loader 对同 cwd 缓存扩展工厂，模块顶层只执行一次，模块级
	// RUN_ID 会让同进程切会话时两个会话行混标，A 会话的审计把 B 会话的对话当自己的）。
	// 审计者凭 `<!--run:${RUN_ID}-->` 过滤出本会话的对话行，排除同 cwd 下其他实例。
	const RUN_ID = `run-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	// D-036（v1.0.29）：本会话开始时刻（墙钟）——before_agent_start 用它区分
	// 「本会话 spawn 的审计结论」（auditStartedAt ≥ 此值 → 同会话交付，注入对话）
	// 与「上会话遗留结论」（auditStartedAt < 此值 → 跨会话交付，写项目文件不注入）
	let sessionStartAtWall = 0;

	// ---- 会话级单一项目根（单一权威 state 的关键）：惰性复核 + 缓存 ----
	// v1.0.28 双审计 LC-10：不再「首次解析后终身固定」——每次调用与 resolveProjectRoot
	// 复核，cwd 切换（会话内路径变化/工具切换目录）时重解析并更新缓存，防 B 目录对话
	// 写入 A 根的 convlog（A 的 git 状态审 B 的对话 → 跨项目串台）。resolveProjectRoot
	// 为纯函数（一次祖先链探测，成本可忽略）。
	let cachedProjectRoot: string | null = null;
	const projectRoot = (cwd: string): string => {
		const root = resolveProjectRoot(cwd);
		if (root && root !== cachedProjectRoot) cachedProjectRoot = root;
		return cachedProjectRoot ?? root;
	};

	// ---- 会话边界：新会话重置根缓存（重新解析）+ 清跨会话待签名状态 ----
	// 目标架构：fresh spawn（无常驻 run、无生命周期登记）——session_shutdown 只清内存锁
	pi.on("session_start", (event, ctx) => {
		try {
			sessionStartAtWall = Date.now(); // D-036：跨会话交付判定的会话边界
			cachedProjectRoot = null; // 新会话重新解析（或读 PI_PAIR_PROJECT_ROOT）
			const root = projectRoot(ctx.cwd);
			// T5：会话级 Map 只保留当前 root 条目——常驻进程长期切换项目防无界增长
			// （injected* 去重有 state.json 持久化兜底；gatedHead 有 agent_end 惰性恢复兜底；
			// nonGitRootWarned 仅一次性提示去重，清掉让新会话可重新提示）
			for (const k of injectedSignatureAt.keys()) {
				if (k !== root) injectedSignatureAt.delete(k);
			}
			for (const k of injectedInterimAt.keys()) {
				if (k !== root) injectedInterimAt.delete(k);
			}
			for (const k of gatedHead.keys()) {
				if (k !== root) gatedHead.delete(k);
			}
			for (const k of nonGitRootWarned) {
				if (k !== root) nonGitRootWarned.delete(k);
			}
			resetForSessionStart(root);
			// F-11（v1.0.38）残留灯自愈：热重载/异常退出后 timer 与 footer 状态可能残留
			// （session_shutdown 未执行路径），新会话无 spawn 语义——无条件灭本 root 的灯
			// （cwd 校验：同进程其他 cwd 实例的亮灯不受影响）。审计由本会话 spawn 时
			// startAuditBreath 会重新亮灯，顺序自洽。
			stopAuditBreath(root);
			// F-12（v1.0.39，reviewer Low）：reload 后模块级 cachedAuditUi 重置为 null，
			// stopAuditBreath 的 setStatus(undefined) 成 no-op（清不到 footer 残留）——
			// 直接用当前 handler 的 ctx.ui 清除，reload 场景同样生效。
			try {
				ctx.ui.setStatus(AUDIT_STATUS_KEY, undefined);
			} catch {
				/* print/无 UI 模式降级 */
			}
			// 决策信号清零（FP 审计 #3：print 模式 agent_end 可能不执行，防跨会话残留误触发）
			roundDecisionMade = false;
			// 交付门禁基线：会话起始 HEAD（非 git 仓库 → 无门禁）；持久化——
			// 扩展热重载（/reload / pi install）不重发 session_start，内存基线丢失后
			// 惰性初始化从 state 恢复（v1.0.23：防热重载把刚提交的修复吞成基线）
			// 保留持久化基线（JD 审计 #21）：上会话门禁执行前被终止的提交不得被
			// 新会话基线吞掉（hasNewCommit=false → 永不过审）——仅无基线时才回退当前 HEAD
			const head = gitHead(root);
			if (head !== null) {
				const st = readAuditState(root);
				const baseline = st.gatedHead ?? head;
				gatedHead.set(root, baseline);
				persistGatedHead(root, baseline);
			}
		} catch {
			/* noop */
		}
	});
	pi.on("session_shutdown", async () => {
		// T1：会话结束 = 挂起审计者 run 无存在意义（中间态 findings 已按纪律落盘）——
		// best-effort stop 超 TTL 的 in-flight run 防算力泄漏；stop 成功（run 已死）才清文件锁，
		// 防新会话 16min 停摆（JD#15 并发双写风险随 run 终止而消失；stop 失败 = run 可能
		// 还在收尾 → 保留锁让遗留审计者先写，resetForSessionStart 的 TTL 条件兜底）
		// 未超 TTL 的 run 不杀：刚 spawn 的正常审计者让其继续收尾（JD#15 语义）
		const now = performance.now();
		// F10（v1.0.29 双审计）：只处理本实例 root 的条目——inFlightAudits 是模块级
		// map，同进程多 cwd 实例共享；全量遍历会把其他实例（B）的 in-flight 条目
		// stop/清空，B 的挂起 run 失去追踪（runId 丢失 + 归属校验跳过）。cachedProjectRoot
		// 是本实例最后解析的 root（shutdown 时未清，最后才置 null）。
		const entries = [...inFlightAudits.entries()].filter(
			([cwd]) => cwd === cachedProjectRoot,
		);
		// F-13（v1.0.40，v1.0.39 审计者 blocker）：门禁轮询 timer 随会话清理——
		// 残留 timer（本实例 root）在常驻进程跨会话存活，新会话门禁轮 set 覆盖句柄
		// 后旧 timer 仍 tick → 双轮询并发竞态（旧轮询回退 gatedHead / 覆盖新签名）。
		const staleGateTimer = gatePollTimers.get(cachedProjectRoot ?? "");
		if (staleGateTimer) {
			clearInterval(staleGateTimer);
			gatePollTimers.delete(cachedProjectRoot ?? "");
		}
		// L2 reviewer run（T1 补漏）：只读无 state 写，会话结束直接全部 stop（挂起 = 纯泄漏）
		await Promise.allSettled([
			...entries.map(async ([cwd, rec]) => {
				const expired = now - rec.startedAt > IN_FLIGHT_TTL_MS;
				const stopped = expired ? await stopRun(rec.runId) : false;
				// F4/B-2（v1.0.29）：未 stop 的 run（未超 TTL 让收尾 / stop 失败）登记
				// 孤儿表——条目随后清空，runId 不随之丢失；TTL 剩余时间到点单发 stop，
				// 挂起 run 不再无界消耗算力（此前 runId 随条目清除永久丢失 = 泄漏）
				if (!stopped && rec.runId) {
					scheduleOrphanStop(
						cwd,
						rec.runId,
						IN_FLIGHT_TTL_MS - (now - rec.startedAt),
					);
				}
				inFlightAudits.delete(cwd);
				if (stopped) {
					try {
						// 身份守卫（v1.0.28 双审计 F-02）：inFlight:false 补丁不得盲清——
						// await stopRun（≤10s）窗口内他会话可能已重获锁（新 spawn 覆写
						// auditRunId/auditStartedAt），盲清会把对方的新锁清掉 → 对方审计
						// 无锁运行 + 下轮再 spawn 双审计。仅当磁盘锁仍属于被 stop 的这个
						// run（auditRunId 匹配）才清；不匹配（锁已被新审计重获）跳过。
						const st = readAuditState(cwd);
						if (
							st.inFlight &&
							(rec.runId === "" || st.auditRunId === rec.runId)
						) {
							patchAuditState(cwd, { inFlight: false });
						}
					} catch {
						/* noop */
					}
				}
				return;
			}),
			(async () => {
				const ids = [...deliveryReviewerRuns];
				deliveryReviewerRuns.clear();
				// F9（v1.0.29）：stop 后取消孤儿定时器（幂等，timer 已在回调中删除）
				await Promise.allSettled(
					ids.map(async (rid) => {
						await stopRun(rid);
						cancelOrphanStop(rid);
						return;
					}),
				);
			})(),
		]);
		// F10（v1.0.29 复审风险 2）：只删本实例 root 的条目，**不 clear() 全表**——
		// 模块级 map 含同进程其他 cwd 实例的 in-flight 条目，全清会让对方 runId
		// 丢失（无终止路径 + stale 锁不可经 deadAuditor 清理）。非本 root 条目保留
		// 由对方实例自己的 shutdown / TTL 兜底处理。
		if (cachedProjectRoot) {
			inFlightAudits.delete(cachedProjectRoot);
		}
		cachedProjectRoot = null;
		stopAuditBreath(); // 呼吸灯灭（会话结束）
	});

	// ---- 工具：decision_add（写链，agent 模式）----
	pi.registerTool({
		name: "decision_add",
		label: "Decision Add",
		description:
			"把当前会话的一个关键决策追加到决策链（自动编号、append-only、可声明 supersede）。" +
			"适用于：选择了方案 A 而非 B、架构/依赖/实现方式的关键取舍、被采纳的用户要求。只记录决策本身，代码细节不记。",
		parameters: Type.Object({
			summary: Type.String({
				description: "决策标题，如「采用 Redis 做读缓存」",
			}),
			context: Type.String({
				description: "可验证的事实背景（带数字/来源），不是观点",
			}),
			decision: Type.String({
				description: "选择的内容，如「引入 Redis 缓存读路径」",
			}),
			rationale: Type.String({
				description: "推理：为什么这个选择由 Context 推出",
			}),
			alternatives: Type.Optional(
				Type.String({
					description:
						"考虑过的替代方案与否决理由，如「Memcached（否决：功能少）；本地内存（否决：不可跨实例）」",
				}),
			),
			confidence: Type.Optional(
				Type.Union(
					[Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")],
					{ description: "置信度（默认 medium）" },
				),
			),
			supersedes: Type.Optional(
				Type.Array(Type.String(), {
					description: '被本条取代的旧决策 id 列表，如 ["D-001"]',
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const entry = appendDecision(projectRoot(ctx.cwd), {
				summary: params.summary,
				context: params.context,
				decision: params.decision,
				rationale: params.rationale,
				alternatives: params.alternatives,
				confidence: params.confidence ?? "medium",
				supersedes: params.supersedes,
			});
			// 本轮决策信号：对话增量触发审计的门控（纯咨询轮零 spawn——用户实测污染：
			// 每轮问答都 spawn 审计者 + 后台完成通知；decision_add 调用 = plan/决策的客观信号）
			// 置位在 append 成功之后（FP 审计 #3：append 抛错时标志不得残留 true
			// 到 agent_end 误触发 spawn）
			roundDecisionMade = true;
			// 单层审计：新决策落地即触发审计（agent_end 时统一 spawn，这里不额外唤起）
			return {
				content: [
					{
						type: "text",
						text: `已追加 ${entry.id}: ${entry.summary} → ${chainPath(projectRoot(ctx.cwd))}`,
					},
				],
				details: { entry: renderEntry(entry) },
			};
		},
	});

	// ---- 工具：decision_list（读链）----
	pi.registerTool({
		name: "decision_list",
		label: "Decision List",
		description:
			"读取决策链（默认 .pi/decision-auditor/chain.md）。可选 onlyFrom 只看某 id 起的新增条目。审计者与主会话共用。",
		parameters: Type.Object({
			onlyFrom: Type.Optional(
				Type.String({ description: "只列出该 id（含）起的条目，如 D-002" }),
			),
			raw: Type.Optional(
				Type.Boolean({ description: "返回原文而非解析条目（默认 false）" }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (params.raw) {
				return {
					content: [{ type: "text", text: readRaw(projectRoot(ctx.cwd)) }],
					details: {},
				};
			}
			const entries = listEntries(projectRoot(ctx.cwd), params.onlyFrom);
			if (entries.length === 0) {
				return {
					content: [{ type: "text", text: "决策链为空（或指定范围无条目）。" }],
					details: {},
				};
			}
			const text = entries.map(renderEntry).join("\n\n");
			return {
				content: [{ type: "text", text }],
				details: { count: entries.length },
			};
		},
	});

	// ---- 工具：decision_signoff（签名——解除完成前审计阶段待签名状态）----
	pi.registerTool({
		name: "decision_signoff",
		label: "Decision Signoff",
		description:
			"完成前审计阶段的签名工具。审计通过后调用它把 signature 置为 passed（或 blocked+blockers），解除 needsSignoff 待签名状态。优先用此工具而非手写 state.json。",
		parameters: Type.Object({
			status: Type.Union([Type.Literal("passed"), Type.Literal("blocked")], {
				description: "passed=审计通过；blocked=发现问题（附 blockers）",
			}),
			blockers: Type.Optional(
				Type.Array(Type.String(), {
					description: "blocked 时的发现问题列表",
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			recordSignature(projectRoot(ctx.cwd), {
				status: params.status,
				...(params.blockers && params.blockers.length > 0
					? { blockers: params.blockers }
					: {}),
			});
			const sig = readAuditState(projectRoot(ctx.cwd)).signature;
			return {
				content: [
					{
						type: "text",
						text: `已签名: ${params.status}${params.blockers?.length ? `（${params.blockers.length} 项 blocker）` : ""} → 完成前审计阶段待签名状态已解除。`,
					},
				],
				details: { signature: sig },
			};
		},
	});

	// ---- 工具：pair_gaps（查询证明缺口 + 泛化缺口，审计者与主会话共用）----
	pi.registerTool({
		name: "pair_gaps",
		label: "Pair Gaps",
		description:
			"查询证明缺口（确定性对账：决策未审 / interrupted 空洞 / blocker 未闭环 / 产物未审）与泛化缺口（最近 N 条泛化发现 + 高频路径——数据聚合，语义比对由调用者判定）。纯读，不 spawn、不写文件。",
		parameters: Type.Object({
			scope: Type.Optional(
				Type.Union(
					[
						Type.Literal("proof"),
						Type.Literal("generalization"),
						Type.Literal("all"),
					],
					{ description: "查询范围（默认 all）" },
				),
			),
			limit: Type.Optional(
				Type.Number({ description: "泛化发现返回最近 N 条（默认 10）" }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const root = projectRoot(ctx.cwd);
			const gaps = queryGaps(root, { limit: params.limit ?? 10 });
			const scope = params.scope ?? "all";
			const lines: string[] = [];
			if (scope === "proof" || scope === "all") {
				const p = gaps.proofGaps;
				lines.push("## 证明缺口");
				if (gaps.latestAudit) {
					lines.push(
						`最新审计: ${gaps.latestAudit.id} (${gaps.latestAudit.verdict}, head=${gaps.latestAudit.head.slice(0, 8)})`,
					);
				} else {
					lines.push("最新审计: 无（从未审计）");
				}
				lines.push(
					`决策未审: ${p.unreviewedDecisions.length > 0 ? p.unreviewedDecisions.map((d) => `${d.id}「${d.summary.slice(0, 24)}」`).join("; ") : "无"}`,
				);
				lines.push(
					`interrupted 空洞: ${p.interruptedHole ? "有（最近条目为超时降级，待补填）" : "无"}`,
				);
				lines.push(
					`blocker 未闭环: ${p.unclosedBlockers.length > 0 ? `${p.unclosedBlockers.length} 条待修复轮核验` : "无"}`,
				);
				lines.push(
					`产物未审: ${p.unauditedArtifacts ? "有（HEAD 或新提交晚于最新审计，待审）" : "无"}`,
				);
			}
			if (scope === "generalization" || scope === "all") {
				const g = gaps.generalization;
				lines.push(
					"## 泛化发现（最近 " +
						(params.limit ?? 10) +
						" 条，语义比对由你判定）",
				);
				if (g.recentFindings.length === 0) {
					lines.push("无（audit-log 尚无泛化发现沉淀）");
				} else {
					for (const f of g.recentFindings) {
						lines.push(
							`- [${f.audit}] 场景: ${f.scene} | 路径: ${f.path} | 来源: ${f.source}`,
						);
					}
				}
				lines.push(
					`高频路径（≥2 次，未采纳候选）: ${g.frequentPaths.length > 0 ? g.frequentPaths.map((f) => `${f.path}(${f.count}次)`).join("; ") : "无"}`,
				);
			}
			const text = lines.join("\n");
			return {
				content: [{ type: "text", text }],
				details: gaps,
			};
		},
	});

	// ---- 命令：/pair-audit 触发结对审计 ----
	pi.registerCommand("pair-audit", {
		description:
			"触发结对决策审计：spawn decision-auditor 子代理，只读决策链并按审计协议审推理链。参数: [onlyFrom=D-00X] [--diff] [消息]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const opts: AuditOptions = {};
			let rest = (args ?? "").trim();
			const diffMatch = rest.match(/--diff\b/);
			if (diffMatch) {
				opts.withDiff = true;
				rest = rest.replace(/--diff\b/, "").trim();
			}
			const onlyFromMatch = rest.match(/\bD-\d{3,}\b/);
			if (onlyFromMatch) {
				opts.onlyFrom = onlyFromMatch[0];
				rest = rest.replace(onlyFromMatch[0], "").trim();
			}
			if (rest) opts.message = rest;
			const root = projectRoot(ctx.cwd);
			const task = buildAuditTask(root, opts, RUN_ID);
			// 手动命令与 agent_end 自动审计共用 inFlight 状态机（v1.0.24，审计缺口 L3'）：
			// 之前命令不写 state.inFlight / inFlightAudits → 命令审计与自动审计并发双 spawn、
			// 呼吸灯被先完成者误灭、M3 双写者冲突。现走同一套锁 + 灯 + async-complete 持续交付。
			const st = readAuditState(root);
			if (st.inFlight || hasInFlight(root)) {
				ctx.ui.notify(
					"已有审计在跑（inFlight），/pair-audit 已跳过——审计完成后再触发。",
					"warning",
				);
				return;
			}
			try {
				await readyPromise;
				// v1.0.28（F-01，与 agent_end 锁获取同策略）：函数式重派生 + 归属记录
				const lockStartedAtWall = Date.now();
				inFlightAudits.set(root, {
					runId: "",
					startedAt: performance.now(),
					auditStartedAtWall: lockStartedAtWall,
				});
				// 锁获取点兑现返回值：写失败（他写者并发）→ 跳过 spawn，防并发双审计（L1）
				// F12（v1.0.29 双审计）：锁 patch 同步清空 auditFindings（与 agent_end
				// JD#23 对齐）——/pair-audit 触发且审计者首写延迟时，旧轮已签名结论 +
				// inFlight=true 会被 shouldInjectInterimFindings 误判「被中断审计」注入
				if (
					!patchAuditState(root, (latest) =>
						latest.inFlight
							? null // 他写者已持锁 → 放弃（防劫持，F-01）
							: {
									inFlight: true,
									auditStartedAt: lockStartedAtWall,
									auditFindings: [],
								},
					)
				) {
					inFlightAudits.delete(root);
					ctx.ui.notify(
						"审计状态写冲突，本轮 /pair-audit 已跳过（防并发双审计）",
						"warning",
					);
					return;
				}
				const result = await rpc<{ runId?: string; asyncId?: string }>(
					"spawn",
					{
						agent: "pi-pair.decision-auditor",
						task,
						async: true,
						context: "fresh",
						// v1.0.44：模型覆盖（PI_PAIR_AUDITOR_MODEL）——同 agent_end spawn
						...(AUDITOR_MODEL ? { model: AUDITOR_MODEL } : {}),
					},
					900_000, // client 超时
				);
				const runId = result?.runId ?? result?.asyncId ?? "";
				inFlightAudits.set(root, {
					runId,
					startedAt: performance.now(),
					auditStartedAtWall: lockStartedAtWall,
				});
				// run 身份锚点（JD #14，同 agent_end 路径；v1.0.27 返回值检查 + 落盘验证）
				if (runId) {
					persistAuditRunId(root, runId);
				}
				startAuditBreath(ctx.ui, root); // 亮灯（与自动审计同一语义）
				ctx.ui.notify(
					`决策审计已启动（async）${runId ? ` run=${runId}` : ""}。完成后会唤醒本会话。`,
					"info",
				);
			} catch (err) {
				// v1.0.28 双审计 F-03（与 agent_end spawn catch 同策略）：
				// runId 已知 → stopRun 再释放锁；runId 未知（rpc 超时，run 可能存活）
				// → 保留锁与内存条目，TTL 兜底释放（防下轮重 spawn 双审计）
				const rec0 = inFlightAudits.get(root);
				const knownRunId = rec0?.runId ?? "";
				if (knownRunId) {
					await stopRun(knownRunId);
				}
				if (!knownRunId) {
					stopAuditBreath(root);
					ctx.ui.notify(
						"⚠ 审计 spawn 超时（run 可能仍在运行），已保留审计锁——16 分钟内不重复 spawn，TTL 到期自动清理。",
						"warning",
					);
					return;
				}
				inFlightAudits.delete(root);
				stopAuditBreath(root); // spawn 失败：灭灯
				try {
					patchAuditState(root, { inFlight: false });
				} catch {
					/* noop */
				}
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(
					`无法启动审计: ${message}\n\n请改用 subagent 工具直接调用: subagent({ agent: "pi-pair.decision-auditor", task: ${JSON.stringify(task)}, async: true, context: "fresh" })`,
					"error",
				);
			}
		},
	});

	// ---- 交付门禁：git HEAD 变化（客观信号）→ agent_end 启动后台轮询等签名（门禁），常规轮异步 ----
	// 不用词表/模式匹配判定「完工」（语义判断不可靠——v1.0.17 废弃正则信号词的先例）；
	// 本轮产生了 git 提交 = 交付发生的客观事实。gatedHead 记录上次门禁覆盖的 HEAD。
	const gatedHead = new Map<string, string>();
	/** 持久化门禁基线到 state.json（热重载后惰性初始化恢复用——不把热重载后刚提交的修复吞成基线）。
	 *  失败静默（M3 mtime 冲突放弃，下轮 agent_end 重试）。 */
	const persistGatedHead = (root: string, baseline: string): void => {
		try {
			patchAuditState(root, { gatedHead: baseline });
		} catch {
			/* noop */
		}
	};
	// 本轮决策信号（decision_add 调用置位，agent_end 消费）——对话增量触发审计的门控
	// 会话级（非模块级）：session_start 清零（print 模式 agent_end 可能不执行，
	// 标志残留跨会话会误触发下轮 spawn——FP 审计 #3）
	let roundDecisionMade = false;
	// 非 git 根守卫去重：每个根每会话只警告一次（避免每轮 decision 轮重复刷屏）
	const nonGitRootWarned = new Set<string>();
	// ---- findings 注入去重：两个独立 map 防互相覆盖（D1）----
	// signature 结论注入去重（记录已注入的 signature.at，变化才再注入）
	const injectedSignatureAt = new Map<string, number>();
	// 中间态注入去重（记录已注入的 auditStartedAt，同轮审计只注入一次）
	const injectedInterimAt = new Map<string, number>();

	// ---- 产物交叉审计（agent_end）：本轮有真实产物 → spawn 审计者；交付轮后台轮询等签名，常规轮异步不阻塞 ----
	// ---- findings 注入：上一轮审计的结论/中间态带给主 agent（低优先级，不阻塞）----
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const root = projectRoot(ctx.cwd);
			const state = readAuditState(root);
			// v1.0.74（reviewer M2 根因）：审计者 LLM 换算 at 常错 +10min → 下轮窗口起点
			// 未来 → 系统性漏审路径。每轮起点钳制未来签名 at（审计者 spawn 前修正落盘）。
			try {
				clampFutureSignatureAt(root, state);
			} catch {
				/* noop */
			}
			// v1.0.63 豁免补写轮询兜底（双保险）：事件路径（async-complete）失败时，
			// 下轮开始自动补上一轮审计的洞（审计者 blocker 实证：v1.0.61/62 报告未落盘
			// 且补写未生效——单点事件路径不可靠）。幂等：补写后判定覆盖不再补。
			try {
				backfillAuditLogIfNeeded(root, state);
			} catch {
				/* noop：补写失败不影响注入 */
			}
			// 跨会话注入去重（v1.0.25，用户报障「为什么新会话还有泄露」）：
			// injectedSignatureAt/injectedInterimAt 持久化到 state.json——同一签名/中间态
			// 只注入一次（审计完成后首个 turn / followUp 场景），之后所有新会话不再重复弹出；
			// 内存 map 优先（同会话内去重），热重载/新会话从 state 恢复（跨会话去重）
			const injectedSig =
				injectedSignatureAt.get(root) ?? state.injectedSignatureAt;
			const injectedInterim =
				injectedInterimAt.get(root) ?? state.injectedInterimAt;
			// 价值点注入（用户可观察）：blockers 结论与中间态发现——审计抓出的
			// 具体缺口是价值，必须让用户看到（可感知），而非流程噪音（等待/计数/协商才隐藏）
			const valueMsgs: string[] = [];
			// F8（v1.0.29 双审计）：触发标志——内存去重标记移到 patch 成功之后才 set；
			// 此前 set 在 push 时（patch 前），patch 失败（审计者并发写 mtime 冲突——
			// F-06 针对的高频场景）→ return 不注入但内存已设 → 同会话下轮判据 false
			// → 价值点压制到进程重启（注释声称的「下轮重试」不成立）
			let sigTriggered = false;
			let interimTriggered = false;
			// 审计结论注入（价值点，用户可观察）：判据 = shouldInjectSignatureFindings 纯函数
			// （行为级测试锁定）：blocked/passed-with-warning + blockers + 同签名未注入过 + 新鲜度
			// （v1.0.24：签名带审计时 HEAD，当前 HEAD 已推进 = 签名可能过时 → 不注入陈旧 blockers）
			if (
				shouldInjectSignatureFindings(
					state,
					injectedSig ?? undefined,
					gitHead(root),
				)
			) {
				valueMsgs.push(
					state.signature!.status === "passed-with-warning"
						? `结对审计未完成（超时降级），已确认的部分发现（价值点）：\n${state.signature!.blockers!.map((b) => `- ${b}`).join("\n")}\n\n供参考，可据此继续处理。`
						: `结对审计发现 ${state.signature!.blockers!.length} 个缺口（价值点）：\n${state.signature!.blockers!.map((b) => `- ${b}`).join("\n")}\n\n请修复这些缺口（修复后下轮自动再审）；若无法修复请说明。`,
				);
				sigTriggered = true;
			}
			// 审计中间态注入（价值点，用户可观察）：审计进行中被杀/超时时留下的部分结果 → 交付价值而非丢弃；
			// 判据 = shouldInjectInterimFindings 纯函数（行为级测试锁定）：inFlight===true（审计仍在跑 = 中断；
			// 纯咨询轮审计者主动写 inFlight=false，不注入——零注入承诺，D-006）；同轮去重（injectedInterimAt）
			if (shouldInjectInterimFindings(state, injectedInterim ?? undefined)) {
				valueMsgs.push(
					`结对审计被中断/未完成（可能来自上次会话），已确认的部分发现（价值点）：\n${state.auditFindings.map((f) => `- ${f}`).join("\n")}\n\n供参考，可据此继续处理。`,
				);
				interimTriggered = true;
			}
			// 价值点 → display:true（用户可观察）；**先**持久化去重标记成功才注入
			// （v1.0.28 双审计 F-06）：此前「注入后再 patch 去重」失败（审计者并发写
			// 导致的 mtime 冲突恰是高频场景）时去重只在内存 map——新会话从 state 恢复
			// 旧值/空 → 同一签名每个新会话重复注入（「新会话还有泄露」报障的残留窗口）。
			// 前移后：patch 失败 → 本轮不注入（内存 map 值已设，同会话不再重复；
			// 跨会话下轮重试时 state 仍未持久化 → 继续判定 → 直到某次 patch 成功才注入）。
			if (valueMsgs.length > 0) {
				// D-036（v1.0.29 用户原则）：**跨会话交付写项目文件，不注入新会话对话**——
				// 判据：审计启动早于本会话开始（auditStartedAt < sessionStartAtWall）=
				// 结论来自上一会话的审计（用户实证：run-31044 中间态注入无关新会话干扰
				// 新任务）。跨会话 → 落盘 .pi/decision-auditor/latest-audit.md + 轻 notify
				// （用户可随时读文件，价值保留、零干扰）；同会话（本会话 spawn 的审计
				// 完成、下轮开工注入闭环反馈）→ 照旧 display:true 注入对话。
				const crossSession =
					sessionStartAtWall > 0 &&
					state.auditStartedAt !== 0 &&
					state.auditStartedAt < sessionStartAtWall;
				if (crossSession) {
					try {
						const report = [
							"# 结对审计报告（跨会话交付）",
							"",
							`- 审计启动：${new Date(state.auditStartedAt).toISOString()}`,
							`- 生成会话：${RUN_ID}`,
							"",
							"## 结论与发现",
							"",
							...valueMsgs
								.join("\n\n")
								.split("\n")
								.map((l) => `> ${l}`),
							"",
						].join("\n");
						if (!writeAuditReport(root, report)) {
							return; // 报告写失败：不注入（下轮重试），防价值双通道
						}
					} catch {
						return;
					}
					try {
						ctx.ui.notify(
							`审计结论（来自上次会话）已写入 ${auditReportPath(root)}，供随时查阅。`,
							"info",
						);
					} catch {
						/* print/无 UI 模式降级 */
					}
					// 跨会话交付完成：仍持久化去重标记（防重复写文件/重复 notify）
					try {
						if (
							!patchAuditState(root, {
								injectedSignatureAt: sigTriggered
									? state.signature!.at || Date.now() // R5-F1：at=0（审计者漏写）用当前时间持久化，防 0 撞键
									: (injectedSignatureAt.get(root) ??
										state.injectedSignatureAt),
								injectedInterimAt: interimTriggered
									? state.auditStartedAt || Date.now() // R5-F1（中间态孪生）：auditStartedAt=0 防 0 撞键
									: (injectedInterimAt.get(root) ?? state.injectedInterimAt),
							})
						) {
							return;
						}
					} catch {
						return;
					}
					// F8：patch 成功后才 set 内存（失败则保持未置位，同会话下轮可重试）
					if (sigTriggered) {
						injectedSignatureAt.set(root, state.signature!.at || Date.now()); // R5-F1：at=0 用当前时间，防 0 撞键
					}
					if (interimTriggered) {
						injectedInterimAt.set(root, state.auditStartedAt || Date.now()); // R5-F1（中间态孪生）
					}
					return; // 跨会话：不注入对话（D-036）
				}
				try {
					if (
						!patchAuditState(root, {
							// 复审 Finding 4（既有问题）：仅中间态注入触发而签名注入未触发时，
							// `?? null` 会把已持久化的 injectedSignatureAt 覆写为 null →
							// 跨会话去重失效重注入。回退到 state 持久化值（非 null 清空）
							injectedSignatureAt: sigTriggered
								? state.signature!.at || Date.now() // R5-F1：at=0（审计者漏写）用当前时间持久化，防 0 撞键
								: (injectedSignatureAt.get(root) ?? state.injectedSignatureAt),
							injectedInterimAt: interimTriggered
								? state.auditStartedAt || Date.now() // R5-F1（中间态孪生）：auditStartedAt=0 防 0 撞键
								: (injectedInterimAt.get(root) ?? state.injectedInterimAt),
						})
					) {
						return; // 去重标记持久化冲突 → 本轮不注入，下轮重试（防重复注入）
					}
				} catch {
					return; // patch 抛错同样不注入（防重复注入优先于注入及时性）
				}
				// F8：patch 成功后才 set 内存（失败则保持未置位，同会话下轮可重试）
				if (sigTriggered) {
					injectedSignatureAt.set(root, state.signature!.at || Date.now()); // R5-F1：at=0 用当前时间，防 0 撞键
				}
				if (interimTriggered) {
					injectedInterimAt.set(root, state.auditStartedAt || Date.now()); // R5-F1（中间态孪生）
				}
				return {
					message: {
						customType: "pi-pair-findings",
						content: valueMsgs.join("\n\n"),
						display: true, // 审计抓出的价值点：用户必须感知（可观察）
					},
				};
			}
		} catch {
			/* noop */
		}
	});

	/** 记录审计时长（agent_end 从触发到签名，CI 跑分用）。 */
	function recordAuditDuration(cwd: string, t0: number): void {
		try {
			patchAuditState(cwd, { lastAuditDurationMs: Date.now() - t0 });
		} catch {
			/* noop */
		}
	}

	/** run 身份锚点落盘（JD #14 身份校验的数据源）：spawn 返回的 runId 写入 state。
	 *  v1.0.27（FP #2a）：检查返回值 + 验证落盘值——patch 静默失败（他写者并发）
	 *  或审计者首写基于旧快照把 auditRunId 覆盖回空（读-写竞态）时，runId 身份校验
	 *  整段空转 = 遗留/并发审计者签名劫持面回到修复前；失败 warn + lastError 落盘（可观测）。 */
	function persistAuditRunId(root: string, runId: string): void {
		try {
			let ok = patchAuditState(root, { auditRunId: runId });
			// 审计者首写可能基于旧快照（auditRunId=""）→ 验证落盘值，被覆盖则补写一次
			if (ok && readAuditState(root).auditRunId !== runId) {
				ok = patchAuditState(root, { auditRunId: runId });
			}
			if (!ok) {
				console.warn(
					`[pi-pair] auditRunId 落盘失败（${runId}），本轮门禁 run 身份校验降级为兼容模式`,
				);
				patchAuditState(root, {
					lastError: `auditRunId 落盘失败: ${runId}`,
				});
			}
		} catch {
			/* noop */
		}
	}

	pi.on("agent_end", async (event, ctx) => {
		try {
			const root = projectRoot(ctx.cwd);
			let state = readAuditState(root);
			// 本轮决策信号消费（decision_add 置位）——对话增量触发审计的门控
			const decisionThisRound = roundDecisionMade;
			roundDecisionMade = false;
			// 交付门禁 = 本轮产生了 git 提交（HEAD ≠ 上次门禁覆盖的 HEAD）——
			// 客观信号，无词表/模式匹配（完工语义判断不可靠，v1.0.17 先例）；
			// 问句/任意措辞天然免疫（不产生提交就不触发）
			const head = gitHead(root);
			// gatedHead 惰性初始化：扩展热重载（/reload / pi install）不重发 session_start → map 空 →
			// 从 state 恢复持久化基线（v1.0.23）：热重载发生在修复轮中途时，当前 HEAD 已是刚提交的
			// 修复——若把当前 HEAD 建为基线，本轮修复提交被吞（hasNewCommit=false），再审永不触发，
			// 陈旧 blocked 签名反复注入每个新会话（实证：08-13 21:07 修复提交后无审计者 spawn）。
			// state 无基线（旧版本首次升级）→ 回退当前 HEAD 并持久化（本轮不门禁，杜绝
			// 「无提交也触发门禁+L2」误触发；后续热重载恢复该基线）
			if (head !== null && !gatedHead.has(root)) {
				const st = readAuditState(root);
				const baseline = st.gatedHead ?? head;
				gatedHead.set(root, baseline);
				persistGatedHead(root, baseline);
			}
			const hasNewCommit = head !== null && gatedHead.get(root) !== head;
			// 多实例混写检测（v1.0.24 前移：必须先于残留锁清理——多实例场景 state.inFlight
			// 可能属于另一实例的真实审计，非属主实例清锁会让对方审计者收尾写冲突放弃、
			// 签名丢失（实证审计缺口 L4）；守卫命中直接 return，不动 state）
			if (convlogForeignRuns(root, RUN_ID) > 0) {
				// F-11（v1.0.38，实证 F-10 同类）：短路 return 先于 stale 清理（L1268）——
				// 本实例早前 spawn 的审计结束后，灭灯三条路径（async-complete 归属会话过滤 /
				// stale 清理短路 / session_shutdown 未触发）在此场景全部失效，呼吸灯永久常亮
				// （实证：state.inFlight=false 且签名 passed，footer 仍显示「结对审计进行中
				// 17006s」≈4.7h）。return 前灭自己的灯（cwd 校验隔离多实例，不误灭他人灯）；
				// 不动 state——多实例下 state 可能属另一实例的真实审计（L4 防护不变）。
				stopAuditBreath(root);
				try {
					ctx.ui.notify(
						"⚠ 检测到同一 cwd 下多个 pi 实例共享 convlog（存在其他实例的真实对话），本轮自动审计已跳过——多实例场景下审计会错审。在不同目录运行或设 PI_PAIR_PROJECT_ROOT 指向单一项目根后恢复。",
						"warning",
					);
				} catch {
					/* print/无 UI 模式降级 */
				}
				return;
			}
			// 残留锁兜底（先于 hasWork 判断：纯咨询轮也清残留锁——清锁≠spawn，不违反零噪音承诺；
			// 防「agent_end 中断后 inFlight=true 假挂起」永久残留——实证：17:41:45 提交轮 spawn 中断，
			// state.json 假 inFlight 挂 2.5h，纯咨询轮 return 前无人清）
			// 清锁后重读 state：spawn 分支必须用干净快照（旧快照 inFlight=true 会让本轮 spawn 被跳过）
			// T1：TTL 过期判定为死的挂起审计者 run → best-effort stop（防 run 算力泄漏 + 迟到写
			// 双写竞争）。必须在 hasInFlight() 之前取记录：hasInFlight 惰性清理会删条目丢 runId
			const deadAuditor = inFlightAudits.get(root);
			let deadStopped = false;
			if (
				deadAuditor &&
				performance.now() - deadAuditor.startedAt > IN_FLIGHT_TTL_MS
			) {
				inFlightAudits.delete(root);
				// F7（v1.0.29 双审计，与 F-02 同策略）：await stopRun 按结果决定清文件锁——
				// 此前 fire-and-forget + 无条件清锁：stop 失败（rpc 通道忙/死）且 run 仍存活
				// 时文件锁已清 → 下轮新 spawn 与旧 run 并发写 state（F-01 根治的同类双审计
				// 在 stale 路径回潮）。stop 成功（run 已死不会再写）才允许 shouldClearStaleLock。
				deadStopped = await stopRun(deadAuditor.runId);
				// L1（v1.0.30 复审）：stop 失败（rpc 忙/死）→ 孤儿登记重达——条目已删后
				// deadAuditor=undefined 无法重评估，会话内停摆到下次 session_start；
				// 登记后 rpc 恢复时 TTL 到点重试 stop + M1 清锁逻辑复用（有界自愈）
				if (!deadStopped && deadAuditor.runId) {
					scheduleOrphanStop(
						root,
						deadAuditor.runId,
						Math.max(
							IN_FLIGHT_TTL_MS - (performance.now() - deadAuditor.startedAt),
							1000,
						),
					);
				}
			}
			// M4 回归修正（v1.0.30 审计者 blocked）：**无内存条目时不得短路**——
			// deadAuditor 为 undefined（agent_end 中断后条目丢失、文件锁残留的 M4 场景）
			// 时 deadStopped 恒 false → `deadStopped &&` 会让 stale 锁同会话内永不清
			// （v1.0.21 修过的 2.5h 假挂起回潮）。有条目 → 要求 stop 成功；
			// 无条目 → 直接走 shouldClearStaleLock（其 auditTooRecent 年龄判据独立把关：
			// 真在跑的审计 auditStartedAt 新近 → 不清锁，安全）。
			if (
				(deadAuditor ? deadStopped : true) &&
				shouldClearStaleLock(state, hasInFlight(root))
			) {
				// v1.0.26（L1）：清锁写也检查返回值——失败（他写者并发）→ 不动 state、不灭灯，
				// 下轮 agent_end 自愈；成功才重读快照并灭灯
				if (
					patchAuditState(root, {
						inFlight: false,
						convExtractedLine: clampConvExtractedLine(root),
					})
				) {
					state = readAuditState(root);
					stopAuditBreath(root); // stale 锁清理（审计者被强杀未收尾）：灯灭，防“审计进行中”永久常亮
				}
			}
			// 工作判据（便宜信号 + 决策信号，无需语义理解——语义判断交给审计者 AI）：
			// 1. 有代码产物（git 未提交改动）或 本轮有提交 → 必审
			// 2. 对话增量 **且 本轮调用了 decision_add**（决策信号）→ spawn 审计者审决策——
			//    纯咨询轮零 spawn（用户实测污染：每轮问答都 spawn 审计者 + 后台完成通知；
			//    零噪音承诺从「零注入」升级为「零 spawn」，D-006 语义扩展）
			// 3. failed 签名（上次 spawn 失败，产物未被审计覆盖）→ 必重试（v1.0.24：
			//    提交轮 spawn 失败后产物已落库，uncommitted/newCommit 信号都假，
			//    不加此分支则 failed 永不重审，产物永不过审——实证审计缺口 L3）
			// convExtractedLine 先经单位钳制（审计者可能写文件行号，超界会让增量触发断线——B2）
			// v1.0.28（LC-08）：成功进入审计流程即清 lastError——此前只写不清，
			// 一次历史异常让 state 长期显示过期错误（诊断者误判「扩展仍异常」）
			if (state.lastError !== null) {
				patchAuditState(root, { lastError: null });
			}
			const hasWork =
				hasUncommittedChanges(root) ||
				hasNewCommit ||
				state.signature?.status === "failed" ||
				(hasNewConversation(root, clampConvExtractedLine(root)) &&
					decisionThisRound);
			// F5（v1.0.29 双审计）：failed 重试轮（上次 spawn 失败、本轮无未提交产物）
			// 是「补审」不是「交付」——不得升级为 300s 门禁轮询（failed 不推进
			// gatedHead → hasNewCommit 持续为真 → 纯聊天轮也 spawn + 门禁轮询 300s，
			// 主会话每轮被阻塞 + 错误 notify 刷屏）。异步 spawn 后即 return，
			// 结论经 async-complete / 下轮注入通道交付。
			// 注意：**不能**含 !hasNewCommit——有未覆盖提交的 failed 重试轮
			// hasNewCommit 恰为 true（门禁轮 spawn 失败后 gatedHead 不推进），
			// 含它会让短路恒 false（复审风险 1：行为等价 no-op）。判据只认
			// 「无未提交产物」：已提交内容在审计窗口内（git log --since）仍会被审。
			const failedRetry =
				state.signature?.status === "failed" && !hasUncommittedChanges(root);
			if (!hasWork) return;

			// 非 git 根守卫（跨项目串台源头，v1.0.24）：自动解析退化为非 git 目录（典型：
			// home 目录）时跳过自动审计——审计基线=整个磁盘，无关项目产物被当成一个项目审
			// （实证：fence-check 审计以 C:\Users\Nuctori 为根，结论写入 home 根 state 被其他
			// 会话注入）。显式 PI_PAIR_PROJECT_ROOT（用户权威根）与手动 /pair-audit 不受限。
			if (head === null && !process.env.PI_PAIR_PROJECT_ROOT) {
				if (!nonGitRootWarned.has(root)) {
					nonGitRootWarned.add(root);
					try {
						ctx.ui.notify(
							`⚠ 项目根 ${root} 不是 git 仓库：自动结对审计已跳过（避免以整个目录为审计基线、跨项目串台）。设 PI_PAIR_PROJECT_ROOT 显式指定项目根，或手动 /pair-audit 触发。`,
							"warning",
						);
					} catch {
						/* print/无 UI 模式降级 */
					}
				}
				return; // 非 git 根：跳过自动审计（return 必须在 if 内——否则 git 根的 agent_end 也被短路）
			}

			// L2 交付审查（3 reviewer fanout）：与新提交同源触发（无词表——交付 = 客观提交信号）；
			// v1.0.28（F-08）：传 head 做冷却键（同 HEAD 防重复，新 HEAD 允许重新 fanout）
			if (hasNewCommit) {
				void triggerDeliveryAudit(pi, rpc, readyPromise, root, RUN_ID, head);
			}

			// 交付轮（本轮有新提交 = 产物落库）→ 后台轮询等签名（硬门禁，不阻塞）；
			// 常规轮 → 异步 spawn，不阻塞——审计者完成写 signature，findings 下轮注入
			const t0 = Date.now(); // 审计时长计时起点

			// 已有审计在跑（inFlight）→ 等待它完成；否则 fresh spawn 审计者
			// （残留锁兜底已上移到 hasWork 判断之前；此处 state 已是清锁后的最新快照）
			if (!state.inFlight && !hasInFlight(root)) {
				// auditStartedAt 在 spawn 的 rpc await **之前**写：
				// print 模式下 handler 可能在 rpc await 处被丢弃，写在之后会丢（CI 跑分 duration=0）
				// convExtractedLine 钳制合并进这个写点（spawn 前唯一全量写，无审计者并发）
				// 注意：**不写 lastAuditAt**——它必须是「上次审计收尾时间」（审计窗口起点，
				// prompt 用 signature.at / lastAuditAt 定位 git log --since）；spawn 时覆盖为
				// 当前时间会让本轮提交全在窗口外（安全审查 HIGH find#1）
				// 锁获取点兑现返回值：写失败（他写者并发）→ 本轮不 spawn，下轮重试（L1）
				// 异常保护（FP #10）：patchAuditState 抛错（fs 异常）时不得残留内存锁——
				// 置锁→spawn 之间任何异常都先释放双锁再走外层 failed 语义
				// v1.0.28 双审计 F-01（锁劫持根治）：锁获取改**函数式重派生**——
				// patch 为 (latest) => 值，重试轮从 fresh state 重派生：latest.inFlight
				// 已为 true（他写者抢到锁）→ 返回 null 放弃本轮，杜绝 stale patch 把
				// 他方 auditStartedAt 覆盖成自己的、双实例都认为持锁各自 spawn。
				// auditStartedAt 值先固定到变量：成功写盘后记入内存条目（LC-03 归属校验用）
				const lockStartedAtWall = Date.now();
				let lockOk = false;
				try {
					lockOk = patchAuditState(root, (latest) => {
						if (latest.inFlight) return null; // 他写者已持锁 → 放弃（防劫持）
						return {
							inFlight: true,
							auditStartedAt: lockStartedAtWall,
							convExtractedLine: clampConvExtractedLine(root),
							// 清空旧 findings（JD #23）：新审计 spawn 后、审计者写入占位前，
							// auditFindings 仍是上轮已签名结论——before_agent_start 会把它
							// 误标「被中断审计」注入。spawn 即重置，注入判据只认本轮内容。
							auditFindings: [],
						};
					});
				} catch {
					lockOk = false;
				}
				if (!lockOk) {
					inFlightAudits.delete(root);
					return; // 下轮 agent_end 重试（有产物信号仍在）
				}
				inFlightAudits.set(root, {
					runId: "",
					startedAt: performance.now(),
					auditStartedAtWall: lockStartedAtWall,
				});
				try {
					await readyPromise;
					const task = buildIncrementalAuditTask(root, RUN_ID);
					// fresh spawn（不常驻）+ context:"fork" 继承主会话上下文——
					// 审计者理解"同一会话"在做什么，而非从零开始
					const result = await rpc<{ runId?: string; asyncId?: string }>(
						"spawn",
						{
							agent: AUDITOR_AGENT,
							task,
							async: true,
							context: "fork",
							// v1.0.44：模型覆盖（PI_PAIR_AUDITOR_MODEL）——deepseek-v4-flash
							// 流中断史导致审计者 run 内容完整却标 failed（见 AUDITOR_MODEL 注释）
							...(AUDITOR_MODEL ? { model: AUDITOR_MODEL } : {}),
						},
						900_000,
					);
					const runId = result?.runId ?? result?.asyncId ?? "";
					inFlightAudits.set(root, {
						runId,
						startedAt: performance.now(),
						// LC-03 归属校验：保留锁获取时的 auditStartedAt（spawn 后不得覆盖
						// 为其他值——门禁等待用它判定「这个 in-flight 是不是我 spawn 的」）
						auditStartedAtWall: lockStartedAtWall,
					});
					// run 身份锚点（JD #14）：spawn 返回的 runId 落盘，isAuditCompleted
					// 校验签名 runId 与之匹配——遗留/并发审计者的签名不得劫持本会话门禁。
					// v1.0.27（FP #2a）：返回值检查 + 落盘值验证（审计者首写竞态覆盖），
					// 失败可观测（warn + lastError），不再静默空转。
					if (runId) {
						persistAuditRunId(root, runId);
					}
					// 呼吸灯亮：审计已 spawn（常规轮异步/门禁轮后台轮询共用）
					startAuditBreath(ctx.ui, root);
				} catch (err) {
					// v1.0.28 双审计 F-03/LC-05：spawn 失败/超时不得无差别释放锁——
					// rpc 900s 客户端超时 ≠ run 终止（服务端 run 可能仍活着）：立即释放
					// 锁 + failed 标记 → 下轮 hasWork（failed 分支）重新 spawn → 新旧
					// 两个审计者并发写 state/chain（双审计）。策略：
					// ① runId 已知（spawn 返回后 persistAuditRunId 前出错）→ stopRun
					//    终止它再释放锁（run 已死不会再写）；
					// ② runId 未知（rpc 超时，run 可能存活）→ **保留锁与内存条目**
					//    （inFlightAudits 不删、state.inFlight 不清），由 hasInFlight 的
					//    TTL 过期 + stale-lock 兜底路径释放——并发双写转为有界停摆
					//    （≤16min），不释放锁就不会重 spawn。
					const rec0 = inFlightAudits.get(root);
					const knownRunId = rec0?.runId ?? "";
					if (knownRunId) {
						await stopRun(knownRunId); // best-effort：终止孤儿 run 防迟到写
					}
					if (!knownRunId) {
						// 无 runId：run 可能还活着（rpc 超时）——保留锁，TTL 兜底释放
						// （保留 startedAt 让 hasInFlight 继续为 true，下轮不重 spawn）
						stopAuditBreath(root);
						try {
							ctx.ui.notify(
								"⚠ 审计 spawn 超时（run 可能仍在运行），已保留审计锁——16 分钟内不重复 spawn，TTL 到期自动清理。",
								"warning",
							);
						} catch {
							/* print/无 UI 模式降级 */
						}
						return;
					}
					inFlightAudits.delete(root);
					stopAuditBreath(root); // spawn 失败：灭自己的灯（cwd 校验——多实例不误灭他人灯，D2 语义）
					// spawn 失败：释放 inFlight 锁 + 标记 failed（非 blocked）——
					// 审计未触发 ≠ 产物有问题：不递增 blockedStreak、不推进 signatureConvLine、
					// 不注入假 blocker（每轮“审计触发失败，产物未过审”即此假缺口）。
					// v1.0.24 加固：
					// ① 保留上轮 blockers——failed 是「未审」不是「无缺口」，整体覆盖会抹掉真实
					//    blockers/降级价值点（注入判据只认 blocked/passed-with-warning，永久丢失）；
					// v1.0.26（L4）：记账文本不再 append 进审计者拥有的 auditFindings（双写者混合，
					// 超时降级会把它当价值点注入用户）——改走 signature.reason（扩展属主字段）。
					// v1.0.28（F-03）：failed 写检查返回值——写冲突失败（他写者并发）则**不
					// 清内存锁**（保留 inFlight 交给 stale-lock TTL 兜底，防「failed 标记丢失 +
					// 锁已释放」双缺口：hasWork 的 failed 重试分支失效 + 新 spawn 并发）。
					const fresh = readAuditState(root);
					const prevBlockers = fresh.signature?.blockers;
					const failedOk = patchAuditState(root, {
						inFlight: false,
						signature: {
							status: "failed",
							reason: "审计触发失败：spawn 失败，下轮重试",
							at: Date.now(),
							...(prevBlockers && prevBlockers.length > 0
								? { blockers: prevBlockers }
								: {}),
						},
					});
					if (!failedOk) {
						inFlightAudits.set(root, {
							runId: "",
							startedAt: performance.now(),
							auditStartedAtWall: lockStartedAtWall,
						}); // 写冲突：保留内存锁（TTL 兜底），防下轮重 spawn 双审计
					}
					if (hasNewCommit) {
						try {
							ctx.ui.notify(
								"⚠ 本轮有提交但审计 spawn 失败（产物未过审），已标记 failed 下轮自动重试；缺口仍保留在 state.json。",
								"warning",
							);
						} catch {
							/* print/无 UI 模式降级 */
						}
					}
					return;
				}
			}

			// 常规轮：异步审计不阻塞——end 就是 end，审计者完成签名后下轮注入 findings；
			// 交付门禁：本轮有新提交（产物落库 = 交付）→ 后台轮询等签名
			// F5（v1.0.29）：failed 重试轮（无本轮新提交/无未提交产物）同步短路——
			// 已异步 spawn，审计结论经 async-complete / 下轮注入交付，不阻塞主会话
			if (!hasNewCommit || failedRetry) return;

			// 门禁归属校验（v1.0.28 双审计 LC-03）：交付轮等待前确认「在跑审计是本会话
			// spawn 的」——state.inFlight 可能属于另一会话/另一实例（多窗口同项目、
			// 残留锁），其审计者签名（runId 匹配 auditRunId 单槽）会满足 isAuditCompleted
			// → **B 的门禁用 A 的审计结论放行**（B 的提交未审即过 + A 的 blockers 注入 B）。
			// 归属判定：本会话 spawn 时写入 state 的 auditStartedAt（内存 auditStartedAtWall）
			// 与 state.auditStartedAt 一致才算本会话的审计；不匹配 → 不等待不签名，
			// 本轮降级返回（不推进 gatedHead——下轮 hasNewCommit 仍真，锁被对方释放/
			// TTL 清理后本会话重新 spawn 自己的审计者再审）。比 300s 空等更优：
			// 不消费时间、不被他人结论劫持。
			// v1.0.28 复审 Finding 1：ownAudit 缺失（跨进程实例/切会话后 map 已清）
			// 时同样视为「非本会话审计」——内存条目不在 = 不可能是本会话 spawn 的
			// 在跑审计（async-complete 清条目时 run 已签名完成，不会误拦正常门禁）。
			const ownAudit = inFlightAudits.get(root);
			if (
				state.inFlight &&
				(!ownAudit || state.auditStartedAt !== ownAudit.auditStartedAtWall)
			) {
				try {
					ctx.ui.notify(
						"⚠ 检测到进行中的审计属于其他会话/实例（非本会话 spawn）——本轮提交门禁跳过，待其完成或锁超时后自动重审。",
						"warning",
					);
				} catch {
					/* print/无 UI 模式降级 */
				}
				return; // 不推进 gatedHead：下轮重试，防 B 的提交被 A 的签名放行
			}

			// 门禁等待告知（F-12：后台轮询不阻塞——用户可继续对话，也可发消息解除等待）
			try {
				ctx.ui.notify(
					"本轮有提交，结对审计进行中（≤300s；等待期间可继续对话，结论到达后放行；发新消息可解除门禁等待）",
					"info",
				);
			} catch {
				/* print/无 UI 模式降级 */
			}

			// F-12（v1.0.39）：门禁同步等待改后台轮询——agent_end 不再阻塞（此前
			// 300s 内 TUI 保持 Working、用户无法输入/取消，实证报障）。spawn 后立即
			// 返回；签名经 2s 间隔轮询检测：完成→放行（streak 维护 + F3 删条目）；
			// 300s 超时→降级放行（原逻辑）；用户发新消息（message_start）→中断等待
			// 放行，结论仍经 async-complete 交付（blocked 即时 followUp，注入兜底）。
			const gateStartedAt = readAuditState(root).auditStartedAt || 0;
			const gateDeadline = Date.now() + GATE_TIMEOUT_MS;
			/** 门禁完成（签名到达）：推进基线 + F3 删条目 + 灭灯 + streak 维护。 */
			const gateComplete = (st: ReturnType<typeof readAuditState>): void => {
				recordAuditDuration(root, t0);
				const sig = st.signature!;
				gatedHead.set(root, head);
				persistGatedHead(root, head);
				// F3（v1.0.29）：签名已写、run 已收尾——删条目防 async-complete 延迟窗口内
				// 新提交被旧签名即时放行 + 后续轮 spawn 跳过（≤16min 审计空窗）；blocked
				// 交付若随条目删除丢失，由 before_agent_start 注入路径兜底（去重未落盘）
				inFlightAudits.delete(root);
				stopAuditBreath(); // 门禁轮完成：灯灭
				// streak 维护（原同步完成分支语义）：passed 清零 / blocked 递增 / 超限降级
				if (sig.status === "passed" || sig.status === "passed-with-warning") {
					const s0 = readAuditState(root);
					if (s0.blockedStreak !== 0) {
						patchAuditState(root, { blockedStreak: 0 });
					}
					return;
				}
				const s = readAuditState(root);
				if (sig.status === "blocked" && s.blockedStreak < MAX_BLOCKED_STREAK) {
					patchAuditState(root, { blockedStreak: s.blockedStreak + 1 });
				}
				const s2 = readAuditState(root);
				if (s2.blockedStreak >= MAX_BLOCKED_STREAK) {
					recordSignature(
						root,
						{
							status: "passed-with-warning",
							blockers: s2.signature?.blockers,
						},
						head,
					);
				}
			};
			const gateTimer = setInterval(() => {
				try {
					const st = readAuditState(root);
					if (isAuditCompleted(st, gateStartedAt)) {
						clearInterval(gateTimer);
						gatePollTimers.delete(root);
						gateComplete(st);
						return;
					}
					if (Date.now() >= gateDeadline) {
						clearInterval(gateTimer);
						gatePollTimers.delete(root);
						// 超时降级前重读（JD #19）：deadline 盲窗内审计者可能恰好完成——
						// 直接降级会整体覆盖真实结论、blockers 永久丢失（同完成判定再查一次）
						const recheck = readAuditState(root);
						if (isAuditCompleted(recheck, recheck.auditStartedAt || 0)) {
							gateComplete(recheck);
							return;
						}
						// 终止仍挂着的审计者 run（FP #13）：超时只降级不终止 run =
						// 资源泄露 + 迟到写竞争；stop 失败不影响降级放行
						const rec = inFlightAudits.get(root);
						if (rec?.runId) {
							void stopRun(rec.runId);
						}
						inFlightAudits.delete(root);
						recordAuditDuration(root, t0);
						// 超时：不再 600s 协商黑洞——降级放行；blockers 用审计者已确认的
						// findings（价值点），无 findings 才给流程提示（D-021）
						const timeoutState = readAuditState(root);
						const realFindings = timeoutState.auditFindings.filter(
							(f) => !isPlaceholderFinding(f),
						);
						// 证明链补写（v1.0.48）：审计者超时未签名 → 扩展补写 interrupted 报告条目，
						// 防该轮在 audit-log 无记录（证明链空洞）；失败不影响降级放行
						try {
							appendAuditReport(root, {
								verdict: "interrupted",
								head,
								window: `审计超时（${GATE_TIMEOUT_MS / 1000}s），审计者未完成签名`,
								blockers: realFindings,
								runId: timeoutState.auditRunId ?? "",
								body: "扩展补写：交付轮门禁超时降级放行（passed-with-warning），审计者报告未落盘。",
							});
						} catch {
							/* noop：报告补写失败不影响降级 */
						}
						recordSignature(
							root,
							{
								status: "passed-with-warning",
								blockers:
									realFindings.length > 0
										? realFindings
										: [
												"审计超时（300s），已降级放行；上轮审计未完成，缺口将在下轮注入",
											],
							},
							head,
						);
						gatedHead.set(root, head);
						persistGatedHead(root, head);
						stopAuditBreath(); // 超时降级：灯灭
						return;
					}
				} catch {
					/* noop：单 tick 异常不阻塞后续轮询 */
				}
			}, 2000);
			// F-13（v1.0.40，v1.0.39 审计者 blocker）：防御 clear——跨会话泄漏的旧轮询
			// timer（session_shutdown 前泄漏路径）会与新轮询并发 tick：旧 timer 读到
			// 新审计者签名 → gateComplete 把 gatedHead 回退旧 head（下轮 hasNewCommit
			// 恒真 → 门禁风暴）或超时 recordSignature 覆盖新审计者签名。启动前清旧句柄。
			const staleGate = gatePollTimers.get(root);
			if (staleGate) clearInterval(staleGate);
			gateTimer.unref?.();
			gatePollTimers.set(root, gateTimer);
		} catch (err) {
			// 不崩溃，但不得静默吞错（JD #17）：核心路径异常整轮无痕 = 状态停摆不可观测
			// （实证：prevBlockers ReferenceError 被吞 → inFlight 残留、门禁不推进、零通知）
			console.error("[pi-pair] agent_end 审计逻辑异常:", err);
			try {
				const root = projectRoot(ctx.cwd);
				patchAuditState(root, {
					lastError: `agent_end: ${err instanceof Error ? err.message : String(err)}`,
				});
				// T4：异常路径也清内存锁+灭灯（防 16min 停摆不可观测 + 呼吸灯常亮）。
				// 文件锁不盲清——审计者可能实际在跑（异常发生在 spawn 之后），盲清会并发
				// 双写；文件锁留给 stale-lock TTL 兜底（shouldClearStaleLock 年龄条件）
				// B-1（v1.0.29 双审计）：删条目前先 best-effort stopRun——否则 runId
				// 随条目丢失，挂起审计者失去全部终止路径（deadAuditor/async-complete/
				// shutdown 均依赖条目取 runId）= 孤儿 run 算力泄漏 + 16min 后新 spawn
				// 与仍活的旧 run 并发写 state（F-03 防的双审计在 catch 路径回潮）
				const orphan = inFlightAudits.get(root);
				let orphanStopped = false;
				if (orphan?.runId) {
					try {
						orphanStopped = await stopRun(orphan.runId);
					} catch {
						/* noop：stop 失败不阻塞清理 */
					}
				}
				// B-1 复审风险 4：stop 成功后按 F-02 身份守卫补清文件锁——否则被 catch
				// 停掉的 run 的文件锁（inFlight=true）在会话内无任何路径清理（stale-lock
				// 的 deadAuditor 路径依赖内存条目，此处已删）→ 会话内审计停摆到跨会话
				// resetForSessionStart。守卫：磁盘锁仍属被 stop 的 run 才清（防误清新锁）。
				const orphanRunId = orphan?.runId ?? "";
				if (orphanStopped && orphanRunId) {
					try {
						const st = readAuditState(root);
						if (st.inFlight && st.auditRunId === orphanRunId) {
							patchAuditState(root, { inFlight: false });
						}
					} catch {
						/* noop */
					}
				}
				inFlightAudits.delete(root);
				stopAuditBreath(root);
			} catch {
				/* noop：日志失败不阻塞 */
			}
		}
	});

	// ---- 审计完成：清除内存中 in-flight（TTL 兜底在 hasInFlight）+ R5 持续交付 ----
	// 通过共享事件总线订阅 pi-subagents 的 async-complete 事件
	// R5 持续交付：审计者完成（async-complete）时若已写 blocked signature → 立即交付主 agent
	// （sendUserMessage followUp，不等下轮注入）——blocker 第一时间给主 agent 处理，直到没问题
	pi.events.on("subagent:async-complete", (data: unknown) => {
		const env = data as {
			asyncId?: string;
			runId?: string;
			success?: boolean;
		} | null;
		const completedId = env?.runId ?? env?.asyncId ?? "";
		// L2 reviewer run 完成即移除（T1 补漏）：Set 只保留挂起 run，session_shutdown 有界
		if (completedId) {
			deliveryReviewerRuns.delete(completedId);
			cancelOrphanStop(completedId); // F4/B-2：run 已自然完成，取消孤儿定时器
		}
		let completedCwd: string | null = null;
		for (const [cwd, rec] of inFlightAudits) {
			if (completedId && rec.runId === completedId) {
				inFlightAudits.delete(cwd);
				completedCwd = cwd;
			}
		}
		// 持续交付：找到完成审计的 cwd → 若审计者已写 blocked → 立即交付主 agent
		if (completedCwd) {
			// v1.0.44 修复：failed 误报纠正——审计者 run 内容完整（签名已写）但进程
			// 退出码非 0（实证：deepseek-v4-flash 流式输出 "Stream ended without
			// finish_reason"）→ pi-subagents 按 exitCode≠0 标 failed，主 agent/用户
			// 误判"审计没收尾"。这里先捕获 ui（stopAuditBreath 会清 cachedAuditUi），
			// 读到签名完成后发轻 notify 纠正——不注入对话，仅消除误报观感。
			const uiBeforeStop = cachedAuditUi;
			stopAuditBreath(completedCwd); // 异步轮审计完成：灯灭（cwd 隔离，D2）
			try {
				const st = readAuditState(completedCwd);
				// 纠正判据（v1.0.44 + reviewer Low 修复）：
				// ① 事件标 failed 但签名已写且 at ≥ 本轮审计启动（= 审计实际完成）
				// ② status 白名单仅 passed/blocked——排除 passed-with-warning（门禁 300s
				//    超时降级签名 at=降级时刻 ≥ auditStartedAt 恒成立，竞态窗口下误触发
				//    「实际已完成」文案失实；reviewer Low#1）
				// 纠正判据③ runId 身份校验（reviewer Note#1 严格化）：
				// 签名带 runId（新流程）→ 只认事件 completedId 与签名 runId 直接比对——
				// 同 cwd 多实例交叉（A run 失败、B run 完成写签名、auditRunId 共享槽被
				// B 覆盖）时 A 的 async-complete 不触发"退出码误报"纠正（状态真实但因果错位）；
				// 签名无 runId（旧签名/手动写）→ 兼容语义：auditRunId 空或事件 run 即槽值。
				const sigCompleted =
					st.signature &&
					st.auditStartedAt &&
					st.signature.at >= st.auditStartedAt &&
					(st.signature.status === "passed" ||
						st.signature.status === "blocked");
				const sigOwned = st.signature?.runId
					? st.signature.runId === completedId
					: !st.auditRunId || completedId === st.auditRunId;
				// v1.0.63 豁免补写统一入口（事件路径）：审计者按 audit-log ≥30KB 豁免未落盘 →
				// 扩展原子补写元数据（v1.0.60 同模式）；判定见 shouldBackfillAuditLog。
				// 事件路径失败（匹配/版本）由 before_agent_start 轮询兜底（双保险）。
				if (sigCompleted && sigOwned) {
					try {
						backfillAuditLogIfNeeded(completedCwd, st);
					} catch {
						/* noop：补写失败不阻塞交付 */
					}
				}
				if (env?.success === false && sigCompleted && sigOwned) {
					const doneStatus = st.signature?.status ?? "passed";
					try {
						uiBeforeStop?.notify(
							`结对审计实际已完成（failed 通知为进程退出码误报，如 provider 流中断）——${doneStatus}，结论已签名。`,
							"info",
						);
					} catch {
						/* print/无 UI 模式降级 */
					}
				}
				if (
					st.signature?.status === "blocked" &&
					st.signature.blockers &&
					st.signature.blockers.length > 0
				) {
					// F6（v1.0.29 双审计）：**先交付、后持久化去重**——v1.0.28 的「先持久化
					// 成功才交付」在 sendUserMessage 失败（print 模式/会话已关闭/无活动
					// 会话）时，去重标记已落盘 → 此后所有会话 injectedSignatureAt ==
					// sig.at → before_agent_start 永不注入 → blockers 永久不可见（价值
					// 丢失）。改序后：交付失败 → 不落盘 → 注入路径接管（下轮/下会话
					// before_agent_start 仍判定未注入，价值经 display 通道交付）。
					// patch 失败（并发写）→ 不交付，留给注入路径——防同一签名
					// followUp + 注入双通道重复。
					let delivered = false;
					try {
						pi.sendUserMessage(
							`结对审计发现缺口（请处理，处理后下轮自动再审）：\n${st.signature.blockers.map((b) => `- ${b}`).join("\n")}`,
							{ deliverAs: "followUp" },
						);
						delivered = true;
					} catch {
						/* 交付失败：不落盘去重，注入路径接管 */
					}
					// 复审风险 3（已知限制）：pi.sendUserMessage 运行时为 fire-and-forget
					// （loader.js 包装 .catch 吞异步失败），try/catch 仅捕获 assertActive
					// 抛错（会话已失效）。静默失败（print 模式 no-op）时 delivered 恒 true
					// 去重照常落盘——但该场景无 UI 也无注入通道，价值本不可见；跨会话
					// 场景由 D-036 项目文件通道兜底（shutdown 删条目 → async-complete
					// 找不到 completedCwd → 不对话交付，统一走 latest-audit.md）。
					if (!delivered) return;
					try {
						const dedupOk = patchAuditState(completedCwd, {
							injectedSignatureAt:
								injectedSignatureAt.get(completedCwd) ??
								st.signature.at ??
								null,
						});
						if (!dedupOk) return; // 去重持久化冲突：下轮注入路径接管
					} catch {
						return;
					}
					// followUp 已交付 → 记录跨会话去重（v1.0.25：避免新会话 before_agent_start
					// 再次注入同一签名——「新会话还有泄露」根治；v1.0.28：持久化已前置；v1.0.29：交付成功后才落盘）
					injectedSignatureAt.set(completedCwd, st.signature.at || Date.now()); // R5-F1：at=0 用当前时间，防 0 撞键
				}
			} catch {
				/* noop */
			}
		}
		// 无法匹配 runId：清除所有已过 TTL 的条目（兜底）——同时灭灯，防“审计进行中”永久常亮
		for (const [cwd, rec] of inFlightAudits) {
			if (performance.now() - rec.startedAt > IN_FLIGHT_TTL_MS) {
				inFlightAudits.delete(cwd);
				stopAuditBreath(cwd);
				// T1：TTL 判定 run 已死（TTL 16min > spawn 超时 15min）→ stop 挂起 run
				// 防算力泄漏 + 迟到写 state 双写竞争（v1.0.27）
				// L2（v1.0.30 复审）：fire-and-forget stop 失败即丢 runId（正是 F4/B-2
				// 封堵的泄漏类）——改用孤儿登记（stop 成功自动清文件锁，M1 修复复用）
				void scheduleOrphanStop(cwd, rec.runId, 0);
			}
		}
	});

	// ---- 门禁等待中断（F-12，v1.0.39）：用户发新消息 = 主动继续，解除门禁等待 ----
	// 不碰 signature、不 stopRun——审计者结论经 async-complete 交付（blocked 即时
	// followUp，注入路径兜底）；gatedHead 推进使下轮不重复门禁（用户已主动继续）。
	// message_start 对 user/assistant/toolResult 消息都触发，只处理 user 消息。
	pi.on("message_start", (event, ctx) => {
		try {
			const msg = event.message as { role?: string } | null;
			if (!msg || msg.role !== "user") return;
			const root = projectRoot(ctx.cwd);
			const timer = gatePollTimers.get(root);
			if (!timer) return;
			clearInterval(timer);
			gatePollTimers.delete(root);
			const head = gitHead(root);
			if (head !== null) {
				gatedHead.set(root, head);
				persistGatedHead(root, head);
			}
			try {
				ctx.ui.notify(
					"门禁等待已解除（检测到新消息，按你的节奏继续）；审计结论到达后仍会通知你。",
					"info",
				);
			} catch {
				/* print/无 UI 模式降级 */
			}
		} catch {
			/* noop */
		}
	});

	// ---- 对话流日志：确定性记录用户提示与助手最终回复（不靠主 agent 自记）----
	pi.on("message_end", (event, ctx) => {
		try {
			const msg = event.message as { role?: string; content?: unknown } | null;
			if (!msg) return;
			if (msg.role === "user") {
				const text = extractText(msg.content);
				if (text) appendConv(projectRoot(ctx.cwd), "user", text, RUN_ID);
				// 交付检测已删除：完工是语义判断，不用词表/模式匹配（v1.0.17 先例）；
				// 门禁与 L2 改由 agent_end 的 git HEAD 变化（客观提交信号）触发
			} else if (msg.role === "assistant") {
				const text = extractText(msg.content);
				if (text) {
					appendConv(projectRoot(ctx.cwd), "assistant", text, RUN_ID);
					// 意图信号记录（高信号过滤，≤200 字符；PI_PAIR_PROCESS_LOG=0 关闭——CI 跑分基线用）
					if (process.env.PI_PAIR_PROCESS_LOG !== "0") {
						appendProcessSignal(projectRoot(ctx.cwd), text, RUN_ID);
					}
				}
			}
		} catch {
			/* noop：日志失败不阻塞会话 */
		}
	});
}

// 供命令 handler 使用的类型
type ExtensionCommandContext = Parameters<
	Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]
>[1];
