// SPDX-License-Identifier: MIT
// chain-store 单元测试：解析、编号、append-only、supersede、审计状态、convlog。
// 运行: node --import tsx --test test/chain-store.test.ts
// 或: npx tsx --test test/chain-store.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import fsModule from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
	appendDecision,
	appendConv,
	appendProcessSignal,
	auditStateMtime,
	auditStatePath,
	appendAuditReport,
	appendGeneralization,
	readGeneralizations,
	auditLogPath,
	auditReportPath,
	writeAuditReport,
	backfillAuditLogIfNeeded,
	clampFutureSignatureAt,
	isPlaceholderFinding,
	chainPath,
	readAuditLog,
	clampConvExtractedLine,
	convLogLineCount,
	convlogForeignRuns,
	convlogPath,
	entriesSinceLastAudit,
	generalizationPath,
	gitHead,
	hasNewConversation,
	hasUncommittedChanges,
	IN_FLIGHT_TTL_MS,
	isAuditCompleted,
	listEntries,
	needsSignoff,
	parseChain,
	processPath,
	queryGaps,
	readAuditState,
	readConvTail,
	readProcess,
	readRaw,
	recordSignature,
	shouldBackfillAuditLog,
	resetForSessionStart,
	resolveProjectRoot,
	shouldClearStaleLock,
	shouldInjectInterimFindings,
	shouldInjectSignatureFindings,
	patchAuditState,
	writeAuditState,
} from "../lib/chain-store.js";
import type { AuditSignature, AuditState } from "../lib/chain-store.js";
function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "chain-store-test-"));
}

test("appendDecision 自动编号与完整字段", () => {
	const dir = tmpDir();
	const e1 = appendDecision(dir, {
		summary: "采用 Redis 做读缓存",
		context: "QPS 峰值 2k；PG 读路径 60ms",
		decision: "引入 Redis 缓存读路径",
		rationale: "缓存命中 <5ms",
		alternatives: "Memcached（否决：功能少）",
		confidence: "high",
	});
	assert.equal(e1.id, "D-001");
	assert.equal(e1.status, "Accepted");
	assert.ok(e1.date.length > 0);

	const e2 = appendDecision(dir, {
		summary: "改用本地缓存",
		context: "单机部署",
		decision: "放弃 Redis",
		rationale: "无分布式需求",
		confidence: "low",
		supersedes: ["D-001"],
	});
	assert.equal(e2.id, "D-002");
	assert.deepEqual(e2.supersedes, ["D-001"]);

	// 文件存在且 append-only
	assert.ok(fs.existsSync(chainPath(dir)));
	const raw = readRaw(dir);
	assert.ok(raw.includes("D-001"));
	assert.ok(raw.includes("D-002"));
});

test("parseChain 解析全部字段与 supersede", () => {
	const dir = tmpDir();
	appendDecision(dir, {
		summary: "A",
		context: "C1",
		decision: "D1",
		rationale: "R1",
		alternatives: "Alt1（否决：理由）",
		confidence: "medium",
	});
	appendDecision(dir, {
		summary: "B",
		context: "C2",
		decision: "D2",
		rationale: "R2",
		confidence: "low",
		supersedes: ["D-001"],
	});
	const entries = parseChain(readRaw(dir));
	assert.equal(entries.length, 2);
	assert.equal(entries[0].id, "D-001");
	assert.equal(entries[0].alternatives, "Alt1（否决：理由）");
	assert.equal(entries[0].confidence, "medium");
	assert.deepEqual(entries[1].supersedes, ["D-001"]);
	assert.equal(entries[1].confidence, "low");
});

test("append-only：旧条目不被修改", () => {
	const dir = tmpDir();
	appendDecision(dir, {
		summary: "A",
		context: "C",
		decision: "D",
		rationale: "R",
	});
	const before = readRaw(dir);
	appendDecision(dir, {
		summary: "B",
		context: "C2",
		decision: "D2",
		rationale: "R2",
	});
	const after = readRaw(dir);
	// 第一条的原文必须完整保留（append-only）
	assert.ok(after.includes(before.trim()));
});

test("listEntries onlyFrom 过滤", () => {
	const dir = tmpDir();
	appendDecision(dir, {
		summary: "A",
		context: "C",
		decision: "D",
		rationale: "R",
	});
	appendDecision(dir, {
		summary: "B",
		context: "C",
		decision: "D",
		rationale: "R",
	});
	const entries = listEntries(dir, "D-002");
	assert.equal(entries.length, 1);
	assert.equal(entries[0].id, "D-002");
	// 不存在的 id → 空
	assert.equal(listEntries(dir, "D-999").length, 0);
});

test("审计状态读写与 entriesSinceLastAudit", () => {
	const dir = tmpDir();
	appendDecision(dir, {
		summary: "A",
		context: "C",
		decision: "D",
		rationale: "R",
	});
	appendDecision(dir, {
		summary: "B",
		context: "C",
		decision: "D",
		rationale: "R",
	});
	appendDecision(dir, {
		summary: "C",
		context: "C",
		decision: "D",
		rationale: "R",
	});

	// 从未审计 → 全部
	assert.equal(entriesSinceLastAudit(dir).length, 3);

	// 审到 D-002 → 只返回 D-003
	writeAuditState(dir, {
		...readAuditState(dir),
		lastAuditedId: "D-002",
		inFlight: false,
	});
	const fresh = entriesSinceLastAudit(dir);
	assert.equal(fresh.length, 1);
	assert.equal(fresh[0].id, "D-003");

	// 状态持久化
	const state = readAuditState(dir);
	assert.equal(state.lastAuditedId, "D-002");
	assert.equal(state.inFlight, false);
	assert.ok(fs.existsSync(auditStatePath(dir)));
});

test("injectedSignatureAt/injectedInterimAt：跨会话注入去重持久化（v1.0.25 新会话泄露根治）", () => {
	const dir = tmpDir();
	// 旧状态/首次升级 → null（不注入去重，首次注入放行）
	const st0 = readAuditState(dir);
	assert.equal(st0.injectedSignatureAt, null);
	assert.equal(st0.injectedInterimAt, null);
	// 写去重标记 → 读回（新会话 before_agent_start 依赖此值跳过已注入签名）
	writeAuditState(dir, {
		...readAuditState(dir),
		injectedSignatureAt: 1000,
		injectedInterimAt: 2000,
	});
	const st1 = readAuditState(dir);
	assert.equal(st1.injectedSignatureAt, 1000);
	assert.equal(st1.injectedInterimAt, 2000);
	// 非数值 → 消毒为 null（不污染去重判定）
	writeAuditState(dir, {
		...readAuditState(dir),
		injectedSignatureAt: "bad" as unknown as number,
	});
	assert.equal(readAuditState(dir).injectedSignatureAt, null);
	// resetForSessionStart 不清去重标记（跨会话去重必须持久存活）
	resetForSessionStart(dir);
	assert.equal(readAuditState(dir).injectedSignatureAt, null); // 上面消毒后已是 null
	writeAuditState(dir, { ...readAuditState(dir), injectedSignatureAt: 3000 });
	resetForSessionStart(dir);
	assert.equal(readAuditState(dir).injectedSignatureAt, 3000);
});

test("gatedHead：门禁基线持久化（扩展热重载恢复，v1.0.23）", () => {
	const dir = tmpDir();
	// 旧状态文件/首次升级 → null（回退当前 HEAD 兜底）
	assert.equal(readAuditState(dir).gatedHead, null);
	// 写基线 → 读回（热重载后惰性初始化依赖此值，防吞修复提交）
	writeAuditState(dir, {
		...readAuditState(dir),
		gatedHead: "2a0b55b",
	});
	assert.equal(readAuditState(dir).gatedHead, "2a0b55b");
	// 非字符串值 → 消毒为 null（不污染基线判定）
	writeAuditState(dir, {
		...readAuditState(dir),
		gatedHead: 123 as unknown as string,
	});
	assert.equal(readAuditState(dir).gatedHead, null);
});

test("convlog 追加与截断", () => {
	const dir = tmpDir();
	appendConv(dir, "user", "请给 calc.py 加一个除法函数");
	appendConv(dir, "assistant", "已完成。");
	const tail = readConvTail(dir);
	assert.ok(tail.includes("用户"));
	assert.ok(tail.includes("除法函数"));
	assert.ok(fs.existsSync(convlogPath(dir)));

	// 超长截断
	const long = "x".repeat(2000);
	appendConv(dir, "user", long);
	const tail2 = readConvTail(dir);
	// 单条被截断到 maxLen，不会整段超长
	assert.ok(!tail2.includes(long));
});

test("convlog 多实例 runId 标记：按 run 隔离对话行", () => {
	const dir = tmpDir();
	// 实例 A（本会话）与实例 B（其他会话）并发写同一 convlog
	appendConv(dir, "user", "A 的决策请求", "run-a");
	appendConv(dir, "user", "B 的 ctx_knowledge 讨论", "run-b");
	appendConv(dir, "assistant", "A 的回复", "run-a");
	appendConv(dir, "assistant", "B 的回复", "run-b");

	const raw = fs.readFileSync(convlogPath(dir), "utf-8");
	const lines = raw.split(/\r?\n/);
	const aLines = lines.filter((l) => l.includes("<!--run:run-a-->"));
	const bLines = lines.filter((l) => l.includes("<!--run:run-b-->"));
	// 各自只有自己的行（无交叉、无混入）
	assert.equal(aLines.length, 2);
	assert.equal(bLines.length, 2);
	assert.ok(aLines.every((l) => !l.includes("ctx_knowledge")));
	assert.ok(bLines.every((l) => !l.includes("决策请求")));

	// 无 runId（旧格式/历史行）不产生标记
	appendConv(dir, "user", "旧格式行");
	const raw2 = fs.readFileSync(convlogPath(dir), "utf-8");
	assert.ok(!/旧格式行.*<!--run:/.test(raw2));

	// 对话行计数不受标记影响（带标记的行照常计入）
	assert.equal(convLogLineCount(dir), 5);
});

test("坏状态文件容错", () => {
	const dir = tmpDir();
	fs.mkdirSync(path.dirname(auditStatePath(dir)), { recursive: true });
	fs.writeFileSync(auditStatePath(dir), "{corrupt json", "utf-8");
	const state = readAuditState(dir);
	assert.equal(state.lastAuditedId, null);
	assert.equal(state.inFlight, false);
	assert.equal(state.convExtractedLine, 0);
});

test("writeAuditState mtime 乐观锁：匹配写、冲突放弃（M3 单写者）", () => {
	const dir = tmpDir();
	// 初始化（无 expectedMtime）
	assert.equal(
		writeAuditState(dir, { ...readAuditState(dir), inFlight: true }),
		true,
	);
	assert.equal(fs.existsSync(auditStatePath(dir)), true);

	// 正确 expectedMtime → 写入成功
	const m1 = auditStateMtime(dir);
	assert.equal(typeof m1, "number");
	assert.equal(
		writeAuditState(dir, { ...readAuditState(dir), inFlight: false }, m1),
		true,
	);
	assert.equal(readAuditState(dir).inFlight, false);

	// 模拟多写者竞态：读者记录旧 mtime → 他写者（无校验）先写入 → 读者用旧 mtime 提交被拒
	const staleMtime = auditStateMtime(dir); // 读者读时的 mtime
	writeAuditState(dir, { ...readAuditState(dir), inFlight: true }); // 他写者无校验写入（mtime 变了）
	const rejected = writeAuditState(
		dir,
		{ ...readAuditState(dir), lastAuditedId: "D-099" }, // 读者基于旧快照的修改
		staleMtime, // 旧 mtime
	);
	assert.equal(rejected, false); // 冲突 → 放弃提交
	// 文件保留他写者的内容（inFlight=true），读者的 D-099 未覆盖
	const final = readAuditState(dir);
	assert.equal(final.inFlight, true);
	assert.equal(final.lastAuditedId, null);
});

test("auditStateMtime：不存在返回 null", () => {
	const dir = tmpDir();
	assert.equal(auditStateMtime(dir), null);
});
// L0 独立层已删除（单层审计）：accumulateRound/checkAuditDue 记账与节流测试随之移除——
// agent_end 按两个便宜信号判定（hasUncommittedChanges or hasNewConversation）触发审计，
// 语义判断（有无决策性工作）交给审计者 AI 第零步。

test("L0 记账字段已从状态移除（单层架构）", () => {
	const dir = tmpDir();
	const state = readAuditState(dir);
	assert.ok(!("roundsSinceAudit" in state), "roundsSinceAudit 字段必须移除");
	assert.ok(!("pendingChars" in state), "pendingChars 字段必须移除");
	assert.ok(!("chainFindings" in state), "chainFindings 字段必须移除");
	assert.ok(
		!("auditorRunId" in state),
		"auditorRunId 字段必须移除（fresh spawn）",
	);
});

test("auditFindings：读写与消毒（中间态交付）", () => {
	const dir = tmpDir();
	writeAuditState(dir, {
		...readAuditState(dir),
		auditFindings: ["推导目标 ✓", "已确认缺口：X"],
	});
	assert.deepEqual(readAuditState(dir).auditFindings, [
		"推导目标 ✓",
		"已确认缺口：X",
	]);
	// 坏值消毒
	fs.mkdirSync(path.dirname(auditStatePath(dir)), { recursive: true });
	fs.writeFileSync(
		auditStatePath(dir),
		'{"auditFindings": ["ok", 42, null]}',
		"utf-8",
	);
	assert.deepEqual(readAuditState(dir).auditFindings, ["ok"]);
});

test("接线守卫：目标架构（单层审计 + fresh spawn + L2 门禁 + 价值点注入）", () => {
	const src = fs.readFileSync(
		path.join(process.cwd(), "extensions", "decision-chain.ts"),
		"utf-8",
	);
	// 单一权威 state：会话级根缓存 + 无裸 resolveProjectRoot(ctx.cwd)
	assert.ok(
		src.includes("const projectRoot = (cwd: string)"),
		"扩展必须定义会话级 projectRoot 缓存（单一权威 state）",
	);
	assert.ok(
		src.includes("cachedProjectRoot = null"),
		"session_start 必须重置根缓存（新会话重新解析）",
	);
	assert.ok(
		!src.includes("resolveProjectRoot(ctx.cwd)"),
		"handler 必须统一用 projectRoot（杜绝双 state 分裂）",
	);
	assert.ok(
		src.includes("PI_PAIR_PROJECT_ROOT"),
		"resolveProjectRoot 必须支持 PI_PAIR_PROJECT_ROOT 显式权威根（跨盘符兜底）",
	);
	// 单层审计：砍 L0 独立层（无 agent_settled 触发链、无 checkAuditDue、无 spawnL0Audit）
	assert.ok(
		!src.includes("spawnL0Audit") && !src.includes("checkAuditDue"),
		"必须砍 L0 独立层（单层审计：提取决策+审产物+签名一次完成）",
	);
	assert.ok(
		!src.includes("accumulateRound"),
		"必须砍 L0 记账（accumulateRound 已并入单层审计）",
	);
	assert.ok(
		!src.includes("chainFindings"),
		"必须砍 chainFindings 独立通道（单层审计直接签名）",
	);
	// fresh spawn：无常驻 run 复用（无 resume 生命周期、无 residentAuditorRunIds）
	assert.ok(
		!src.includes("residentAuditorRunIds") &&
			!src.includes("ensureAuditorInLane"),
		"必须砍常驻 run 生命周期（fresh spawn，审计完即死）",
	);
	// process 记录接线（意图信号，受 PI_PAIR_PROCESS_LOG 开关控制）
	assert.ok(
		src.includes("appendProcessSignal(projectRoot(ctx.cwd), text, RUN_ID)"),
		"message_end 必须调 appendProcessSignal 记意图信号（带 runId 隔离）",
	);
	assert.ok(
		src.includes('process.env.PI_PAIR_PROCESS_LOG !== "0"'),
		"process 记录必须受 PI_PAIR_PROCESS_LOG 开关控制（CI 跑分基线）",
	);
	// 审计任务必须引导读过程日志
	assert.ok(src.includes("processPath(cwd)"), "审计任务必须引用过程日志路径");
	// 实证盲区维度（prompt 优化）：机制完整性 + 运行时行为
	assert.ok(
		src.includes("机制完整性"),
		"审计任务必须含机制完整性检查（防断线回归）",
	);
	assert.ok(
		src.includes("运行时行为"),
		"审计任务必须含运行时行为检查（防 print/交互模式盲区）",
	);
	// 路径提示：链位置以实际文件为准
	assert.ok(
		src.includes("链的实际位置以 find 到的真实文件为准"),
		"审计任务路径提示必须引导 find 真实链（防 cwd 解析误导）",
	);
	// 会话隔离接线：写入点传 RUN_ID、prompt 注入过滤规则、多实例检测接通
	assert.ok(
		src.includes('appendConv(projectRoot(ctx.cwd), "user", text, RUN_ID)'),
		"message_end 用户行必须带 RUN_ID 标记（会话隔离）",
	);
	assert.ok(
		src.includes('appendConv(projectRoot(ctx.cwd), "assistant", text, RUN_ID)'),
		"message_end 助手行必须带 RUN_ID 标记（会话隔离）",
	);
	assert.ok(
		src.includes("appendProcessSignal(projectRoot(ctx.cwd), text, RUN_ID)"),
		"process.md 意图信号必须带 RUN_ID 标记（隔离）",
	);
	// 会话隔离规则注入计数：审计/L2 prompt 用 ${runId}（v1.0.24 会话级 RUN_ID），
	// 写入点与注释保留 ${RUN_ID} 形态——两种都算（防重构删掉）
	const ruleCount =
		src.split("<!--run:${RUN_ID}-->").length -
		1 +
		src.split("<!--run:${runId}-->").length -
		1;
	assert.ok(
		ruleCount >= 4,
		`4 处审计/L2 prompt 必须注入会话隔离规则（防重构删掉），实际 ${ruleCount} 处`,
	);
	assert.ok(
		src.includes("convlogForeignRuns(root, RUN_ID) > 0"),
		"agent_end 必须做多实例混写检测（跳过错审）",
	);
	// v1.0.24：RUN_ID 会话级（工厂作用域生成）——同进程切会话时各会话行可区分
	assert.ok(
		src.includes("const RUN_ID = `run-${process.pid}-"),
		"RUN_ID 必须会话级生成（工厂内，非模块顶层）——同进程切会话不共享 run 标记",
	);
	// v1.0.24：非 git 根守卫（跨项目串台源头）——自动解析退化为非 git 目录（典型 home）
	// 时跳过自动审计；显式 PI_PAIR_PROJECT_ROOT 不受限
	assert.ok(
		src.includes("head === null && !process.env.PI_PAIR_PROJECT_ROOT"),
		"agent_end 必须有非 git 根守卫（home 目录不再自动审计——跨项目串台源头）",
	);
	// 工作判据（产物/提交信号 或 决策信号）+ 审计者 AI 判定（第零步）
	assert.ok(
		src.includes("hasUncommittedChanges(root)") &&
			src.includes("hasNewConversation(root, clampConvExtractedLine(root))") &&
			src.includes("decisionThisRound"),
		"agent_end 触发判据：git 产物/提交 必审；对话增量需本轮 decision_add 决策信号——纯咨询轮零 spawn（零噪音承诺）",
	);
	assert.ok(
		src.includes("第零步：判定本轮是否有值得审计的工作"),
		"审计任务必须先 AI 判定本轮有无工作（纯咨询快速退出零注入；plan 阶段提取决策+审决策）",
	);
	assert.ok(
		src.includes("本轮纯咨询，无审计对象"),
		"纯咨询快速退出路径必须存在（推进游标、零价值点注入）",
	);
	assert.ok(
		src.includes("发散核实") && src.includes("收敛核实"),
		"独立核实必须分两层：收敛（对账）+ 发散（找未声明的风险）——审计不能只是看事实是否吻合",
	);
	assert.ok(
		src.includes("gitHead") && src.includes("hasNewCommit"),
		"交付门禁必须用 git HEAD 变化（客观提交信号）——不用词表/模式匹配判定完工（v1.0.17 先例）",
	);
	assert.ok(
		(src.includes("gatedHead") && src.includes("if (!hasNewCommit) return;")) ||
			src.includes("if (!hasNewCommit || failedRetry) return;"),
		"常规轮必须异步（agent_end 不阻塞等签名）——findings 下轮注入；门禁只在新提交（产物落库）时收紧（F5 起 failedRetry 同步短路）",
	);
	assert.ok(
		src.includes("failedRetry") &&
			src.includes("if (!hasNewCommit || failedRetry) return;"),
		"F5（v1.0.29）：failed 重试轮（无本轮新提交）必须同步短路——不升级 300s 门禁阻塞主会话",
	);
	// L2 交付审查：与新提交同源触发（无词表）；无提交不 spawn（杜绝空转）
	assert.ok(
		src.includes("hasNewCommit") && src.includes("triggerDeliveryAudit"),
		"L2 交付审查必须与新提交同源触发（无提交不 spawn reviewer，杜绝 follow_me 空转）",
	);
	// 价值点可观察 / 流程隐藏
	assert.ok(
		src.includes("display: true"),
		"审计价值点（blockers/auditFindings）必须 display:true 注入——用户可观察（状态机 T4）",
	);
	assert.ok(
		!src.includes("negotiateStop"),
		"600s 协商黑洞必须移除（超时直接降级放行 + findings 下轮注入）",
	);
	assert.ok(
		!src.includes("审计未通过（第"),
		"blocked 计数刷屏必须移除（不再 sendUserMessage 给用户）",
	);
	// session_shutdown 清理（fresh spawn 场景：清内存锁即可，无常驻 run 残留）
	assert.ok(
		src.includes('pi.on("session_shutdown"'),
		"session_shutdown handler 必须存在（清理内存锁）",
	);
	// 持续交付：审计完成（async-complete）时若有 blockers → 立即交付主 agent 处理
	assert.ok(
		src.includes("subagent:async-complete") &&
			src.includes("blockers") &&
			src.includes("sendUserMessage"),
		"审计完成事件必须把 blockers 立即交付主 agent（持续交付，不等下轮）",
	);
	// H2：waitForAuditCompletion 完成判定 = 本轮新签名（blocked 也算完成，防覆盖真实 blockers）
	// v1.0.26：完成判定抽成 isAuditCompleted 纯函数（lib 单测锁定行为：at 判定 + runId 身份校验 + failed 排除）
	assert.ok(
		src.includes("isAuditCompleted(st, gateStartedAt)") &&
			src.includes("isAuditCompleted(recheck, recheck.auditStartedAt || 0)"),
		"完成判定必须走 isAuditCompleted 纯函数（lib 行为级测试锁定：at 判定 + runId 身份校验 + failed 排除）",
	);
	// F-13（v1.0.40）：门禁轮询 timer 生命周期——session_shutdown 清理 + agent_end 防御 clear
	assert.ok(
		src.includes('gatePollTimers.get(cachedProjectRoot ?? "")') &&
			src.includes("clearInterval(staleGateTimer)"),
		"session_shutdown 必须清理本 root 的门禁轮询 timer（跨会话轮询泄漏 → 双轮询并发，v1.0.40 blocker）",
	);
	assert.ok(
		src.includes("const staleGate = gatePollTimers.get(root)") &&
			src.includes("if (staleGate) clearInterval(staleGate)"),
		"agent_end 启动门禁轮询前必须防御 clear 旧 timer（shutdown 未执行路径双保险，v1.0.40 blocker）",
	);
	// 门禁基线：会话起始 HEAD 初始化 + 持久化（非 git 仓库无门禁）
	assert.ok(
		src.includes("const head = gitHead(root)") &&
			src.includes("gatedHead.set(root, head)") &&
			src.includes("persistGatedHead(root, head)"),
		"session_start 必须初始化并持久化 gatedHead 基线（热重载后惰性初始化恢复）",
	);
	// M5：惰性初始化从 state 恢复持久化基线——热重载把当前 HEAD 建为基线会吞掉刚提交的
	// 修复（hasNewCommit=false → 再审永不触发 → 陈旧 blocked 签名反复注入每个新会话）；
	// 位置语义：恢复逻辑必须在 hasNewCommit 计算之前；判据 = state.gatedHead ?? head
	const lazyInit = src.indexOf("st.gatedHead ?? head");
	const hasNewCommitCalc = src.indexOf("const hasNewCommit =");
	assert.ok(
		lazyInit !== -1 && hasNewCommitCalc !== -1 && lazyInit < hasNewCommitCalc,
		"gatedHead 惰性初始化必须从 state 恢复持久化基线（st.gatedHead ?? head）且先于 hasNewCommit 计算——防热重载吞修复提交（v1.0.23）",
	);
	// M4：残留锁兜底（文件锁在但内存锁无 → 释放，防审计永久停摆）
	// 行为级：判据走 shouldClearStaleLock 纯函数（lib 单测锁定：清锁不依赖 hasWork 信号）；
	// 位置语义：清锁块必须先于 `if (!hasWork) return;`——纯咨询轮也清残留锁
	// （v1.0.21 修复的实证：17:41:45 spawn 中断后假 inFlight 挂 2.5h，纯咨询轮 return 前无人清）
	const staleLockCall = src.indexOf(
		"shouldClearStaleLock(state, hasInFlight(root))",
	);
	const hasWorkReturn = src.indexOf("if (!hasWork) return;");
	assert.ok(
		staleLockCall !== -1 &&
			hasWorkReturn !== -1 &&
			staleLockCall < hasWorkReturn,
		"残留锁兜底必须先于 hasWork 判断（纯咨询轮 return 前也清锁）——且必须走 shouldClearStaleLock 纯函数（行为级测试在 lib 单测）",
	);
	// M4 回归锁定（v1.0.30）：deadAuditor 缺失（agent_end 中断/崩溃 → 内存条目清空但
	// state.inFlight 残留）时 stale 锁仍须清除——F7 的 stop 结果门控不得短路该场景
	// （`deadStopped &&` 会让 v1.0.21 修过的 2.5h 假挂起回潮）。断言源码含
	// `(deadAuditor ? deadStopped : true)` 等价形态（无内存条目 → 不受 stop 约束）
	assert.ok(
		src.includes("deadAuditor ? deadStopped : true"),
		"M4 兜底：无内存条目（deadAuditor undefined）时 stale 锁清理不得被 stop 结果短路",
	);
	// 完成即停：审计者 prompt 必须含明确停止边界
	assert.ok(
		src.includes("完成即停") && src.includes("签名后的一切继续都是浪费"),
		"审计者 prompt 必须含完成即停边界（签名后不再扩大范围）",
	);
	// B1：中间态注入判据 = shouldInjectInterimFindings 纯函数（行为级测试锁定，非字符串守卫）；
	// v1.0.25：跨会话去重持久化——判据入参从 state 恢复的持久化值（injectedInterim ?? undefined）
	assert.ok(
		src.includes(
			"shouldInjectInterimFindings(state, injectedInterim ?? undefined)",
		) ||
			src.includes(
				"shouldInjectInterimFindings(state, injectedInterimAt.get(root))",
			),
		"中间态注入必须走 shouldInjectInterimFindings 纯函数（行为级测试在 lib 单测）",
	);
	// v1.0.25：注入去重持久化——injectedSignatureAt/injectedInterimAt 必须落 state.json
	// （同一签名只注入一次，新会话不再重复弹出审计结论——「新会话还有泄露」根治）
	// v1.0.28（F-06）：持久化**前移**到注入前（patch 成功才注入）——格式允许换行；
	// 复审 Finding 4：回退值用 state 持久化值（非 null 清空——防仅中间态注入时
	// 把已持久化的签名去重标记覆写为 null 导致重复注入）
	assert.ok(
		src.includes("injectedSignatureAt.get(root) ??") &&
			src.includes("injectedInterimAt.get(root) ??") &&
			!src.includes("injectedSignatureAt.get(root) ?? null"),
		"注入前必须持久化去重标记（跨会话去重 + F-06 先持久化成功才注入 + 回退持久化值不覆写 null）",
	);
	// B2：convExtractedLine 单位钳制（审计者写文件行号超界 → 钳制，防对话增量触发断线）
	assert.ok(
		src.includes("clampConvExtractedLine(root)"),
		"agent_end 必须对 convExtractedLine 做单位钳制（防审计者写文件行号导致触发断线）",
	);
	// B5：审计者手写 signature 必须带 at（扩展按 signature.at ≥ auditStartedAt 判定完成）
	assert.ok(
		src.includes("signature 必须带 at 字段"),
		"审计任务收尾必须要求 signature 带 at 字段（缺 at 会被交付轮误判为超时）",
	);
	// B3：签名即推进（blocked 也推进 signatureConvLine——修复走 blockers 注入通道）
	assert.ok(
		src.includes("签名即推进"),
		"审计任务收尾必须明确签名即推进（blocked 也推进 convLine，不靠 convLine 滞后）",
	);
	// v1.0.44：审计者 run 模型覆盖（PI_PAIR_AUDITOR_MODEL）——deepseek-v4-flash
	// 流中断史（"Stream ended without finish_reason"）导致审计者 run 内容完整却标
	// failed（exitCode≠0），用户观感"审计没收尾"。spawn 透传 model 可从源头减少。
	assert.ok(
		src.includes("PI_PAIR_AUDITOR_MODEL") &&
			src.includes("...(AUDITOR_MODEL ? { model: AUDITOR_MODEL } : {})"),
		"审计者 spawn 必须透传 PI_PAIR_AUDITOR_MODEL 模型覆盖（provider 流中断规避）",
	);
	// v1.0.44：failed 误报纠正——async-complete 事件标 failed（进程退出码非 0）但
	// 签名实际完成（signature.at ≥ auditStartedAt）时，发轻 notify 纠正，防主 agent
	// 误判"审计没收尾"。判据：事件 success===false + 签名已写 + 非 failed 状态。
	assert.ok(
		src.includes("env?.success === false") &&
			src.includes("st.signature.at >= st.auditStartedAt") &&
			src.includes("结对审计实际已完成"),
		"async-complete 必须对 failed 误报（内容完整但退出码非 0）发纠正 notify",
	);
	// v1.0.44 reviewer Low#1/#2 + Note#1：纠正判据收窄——status 白名单（仅
	// passed/blocked，排除 passed-with-warning 超时降级签名）+ runId 严格身份校验
	// （签名带 runId 时只认 事件 run === 签名 run，防同 cwd 多实例交叉因果错位）
	assert.ok(
		src.includes('st.signature.status === "passed"') &&
			src.includes('st.signature.status === "blocked"') &&
			src.includes("st.signature.runId === completedId"),
		"failed 纠正判据必须收窄：status 白名单（passed/blocked）+ runId 严格身份校验",
	);
	// v1.0.44：交付通道澄清——审计者 prompt 明确"发现 blocker 不需要 contact_supervisor，
	// 签名即交付"（扩展 async-complete 立即 sendUserMessage）；contact_supervisor 仅用于
	// 即时裁决/澄清。实证：24h 审计者 0 次调用 contact_supervisor 而 blockers 全部如期交付。
	assert.ok(
		src.includes("签名即交付") &&
			src.includes("contact_supervisor 仅用于需要即时裁决"),
		"审计者任务文本必须澄清交付通道分工（blocker 签名即交付，不依赖 contact_supervisor）",
	);
	// v1.0.45：审计唤起收敛纪律——① 低价值窗口（仅文档/格式且无新决策）轻量退出
	// 不五维度进攻；② 修复轮立场收窄（只核验 blockers，Low/Note 不升级 blocker）。
	// 语义判断在审计者 AI 侧（扩展触发逻辑零改动，门禁"提交=必审"保留）。
	assert.ok(
		src.includes("低价值窗口") &&
			src.includes("轻量退出") &&
			src.includes("不做五维度进攻"),
		"审计任务必须含低价值窗口轻量退出分支（文档/格式改动不触发全量进攻）",
	);
	assert.ok(
		src.includes("修复轮收敛纪律") &&
			src.includes("不扩大范围主动寻找新问题") &&
			src.includes("不升级为 blocker"),
		"审计任务必须含修复轮收敛纪律（只核验 blockers，Low/Note 不升级 blocker——防无限唤起）",
	);
	// v1.0.45 Note：L2 reviewer 同步低价值窗口纪律（纯文档提交不 fanout 全维度审查）
	assert.ok(
		src.includes("低价值窗口轻量退出（v1.0.45 收敛纪律，与 L1 同构）"),
		"L2 reviewer prompt 必须含低价值窗口轻量退出指令（与 L1 同构，防纯文档提交全量 fanout）",
	);
	// v1.0.46 reviewer Medium：轻量退出必须排除修复轮场景（上轮 blocked 且 blockers
	// 非空时先核验闭环再签名——修复提交恰为纯文档是常见型，轻量退出会绕过重报不变量）
	assert.ok(
		src.includes("修复轮守卫（v1.0.46") &&
			src.includes("上轮 signature.status==='blocked'"),
		"低价值窗口轻量退出必须含修复轮守卫（blocked 且 blockers 非空 → 先核验闭环再签名）",
	);
	// v1.0.46 reviewer Medium-1：L2 必须镜像同一守卫（D-052 声称同步，实现补全——纵深防御）
	assert.ok(
		src.includes("修复轮守卫（v1.0.46，与 L1 同构）"),
		"L2 reviewer prompt 必须镜像修复轮守卫（与 L1 同构，防纯文档修复绕过重报不变量）",
	);
	// v1.0.46 reviewer Note-3：审计者 agent 工具白名单不得声明未加载扩展的 ctx_*
	// （运行时严格 allowlist 拒绝 → 审计者 run 全量 exitCode=1 → 每次先标 failed，
	//  用户原始报障"结果审计收不了尾"的又一根因——v1.0.44 纠正仅是兜底）
	const agentSrc = fs.readFileSync(
		path.join(process.cwd(), "agents", "decision-auditor.md"),
		"utf-8",
	);
	assert.ok(
		!agentSrc.includes("ctx_read") &&
			!agentSrc.includes("ctx_grep") &&
			!agentSrc.includes("ctx_find") &&
			!agentSrc.includes("ctx_ls"),
		"审计者 agent 工具白名单不得含 ctx_*（未加载扩展，运行时拒绝致 run exitCode=1）",
	);
	// v1.0.48：证明链（报告落盘 + subagent 转述捕获 + 缺口自查 + 超时补写）
	assert.ok(
		src.includes("auditLogPath(cwd)"),
		"审计任务必须注入 audit-log 路径（报告落盘指令）",
	);
	assert.ok(
		src.includes("subagent 决策捕获"),
		"审计任务必须含 subagent 转述捕获指令（subagent 决策经主 agent 转述入链）",
	);
	assert.ok(
		src.includes("证明缺口自查"),
		"审计任务必须含证明缺口自查指令（决策未审/interrupted 补填/blocker 闭环）",
	);
	assert.ok(
		src.includes('verdict: "interrupted"'),
		"超时降级必须补写 interrupted 报告（证明链无空洞）",
	);
	assert.ok(
		agentSrc.includes("audit-log.md") && agentSrc.includes("先报告后签名"),
		"审计者 agent 收尾协议必须含报告落盘（先报告后签名）",
	);
	// v1.0.48c：泛化发现（pair 多头注意力沉淀 + 查询 + 复用纪律）
	assert.ok(
		src.includes("泛化发现与复查") && src.includes("### 泛化发现"),
		"审计任务必须含泛化发现沉淀指令（发散核实路径型产出的出口）",
	);
	assert.ok(
		src.includes("泛化缺口复发") && src.includes("建议固化为审计维度"),
		"泛化复查必须含复发检测与蒸馏出口（查询泛化缺口）",
	);
	assert.ok(
		src.includes("修复轮**不执行**复查"),
		"泛化复查必须排除修复轮（收敛纪律，不制造无限唤起）",
	);
	assert.ok(
		agentSrc.includes("泛化发现与复查"),
		"审计者 agent 收尾协议必须含泛化发现与复查",
	);
	// v1.0.48d：pair_gaps 工具注册 + chain.md 全量重建禁令
	assert.ok(
		src.includes('name: "pair_gaps"'),
		"必须注册 pair_gaps 工具（查询证明/泛化缺口）",
	);
	assert.ok(
		src.includes("queryGaps(root, { limit:"),
		"pair_gaps 必须调 queryGaps 数据层",
	);
	assert.ok(
		src.includes("优先用 decision_add 工具追加") &&
			src.includes("全量重建禁令") &&
			src.includes("50KB"),
		"审计任务必须含 decision_add 优先 + 50KB 全量重建禁令（长链压缩事故防护）",
	);
	assert.ok(
		agentSrc.includes("全量重建禁令") && agentSrc.includes("decision_add"),
		"审计者 agent 捕获协议必须同步 decision_add 优先 + 重建禁令",
	);
	// v1.0.51：泛化发现行格式强制（解析器-写者对不齐类别风险缓解，48d/50 两次实证）
	assert.ok(
		src.includes("行格式必须严格保持"),
		"审计任务必须强制泛化发现行格式（- 场景: X | 路径: Y | 来源: Z 单行）",
	);
	assert.ok(
		agentSrc.includes("行格式必须严格保持"),
		"审计者 agent 协议必须同步泛化发现行格式强制",
	);
	// v1.0.52：链一致性检查 + 原语语义聚类（隔壁 AI 建议审计后的降级落地）
	assert.ok(
		src.includes("链一致性检查") &&
			src.includes("悬空引用") &&
			src.includes("临时假设标注"),
		"审计任务必须含链一致性检查（悬空引用/传递一致性/临时假设 Confidence 降级）",
	);
	assert.ok(
		src.includes("原语语义聚类") && src.includes("局部最优陷阱"),
		"泛化复查必须含原语语义聚类（跨场景模式识别）",
	);
	assert.ok(
		agentSrc.includes("链一致性（v1.0.52）") &&
			agentSrc.includes("原语语义聚类"),
		"审计者 agent 协议必须同步链一致性 + 原语聚类",
	);
	// v1.0.55：结对可观察性（findings 观察器接线——运行中黑盒修复）
	assert.ok(
		src.includes("startFindingsObserver") &&
			src.includes("findingsObserverTick") &&
			src.includes("20_000"),
		"必须含 findings 观察器（20s 轮询中间态，运行中可观察）",
	);
	assert.ok(
		src.includes("startFindingsObserver(ui, cwd)") &&
			src.includes("stopFindingsObserver(auditBreathCwd"),
		"观察器必须随呼吸灯生命周期启停（start 接线 + stop 汇聚）",
	);
	// v1.0.55b：pair_gaps 回抄禁令双点同步（reviewer Low——任务文本 + agent 协议）
	assert.ok(
		agentSrc.includes("不要直接回抄 pair_gaps"),
		"agent 协议沉淀段必须同步回抄禁令（双点同步纪律，v1.0.52→53 事故同类）",
	);
	// v1.0.60：gaps.md 独立原语库 + 豁免补写（审计者双 blocker 修复）
	assert.ok(
		src.includes("generalizationPath(cwd)") && src.includes("gaps.md"),
		"审计任务必须引导泛化发现沉淀到 gaps.md（audit-log 豁免不殃及泛化通道）",
	);
	assert.ok(
		src.includes("扩展会在审计完成时用 appendAuditReport"),
		"任务文本必须说明豁免补写由扩展原子执行（write 触碰禁令）",
	);
	assert.ok(
		agentSrc.includes("gaps.md") && agentSrc.includes("独立原语库"),
		"agent 协议必须同步 gaps.md 沉淀目标",
	);
	// v1.0.61：补写判定 runId 优先（审计者 blocker——Date 判定恒真重复补写）
	assert.ok(
		src.includes("backfillAuditLogIfNeeded"),
		"豁免补写必须走统一入口（lib shouldBackfillAuditLog：runId 优先 + auditStartedAt 兜底）",
	);
	// v1.0.62：agent 协议双点同步（reviewer Medium-High——v1.0.52→53 事故同类）
	assert.ok(
		agentSrc.includes("扩展会在审计完成时用 appendAuditReport"),
		"agent 协议必须同步 v1.0.60 豁免语义（禁止 write 触碰 + 扩展原子补写）",
	);
	// v1.0.63：补写双保险（事件 + 轮询）
	assert.ok(
		(src.includes("backfillAuditLogIfNeeded(completedCwd, st)") ? 1 : 0) +
			(src.includes("backfillAuditLogIfNeeded(root, state)") ? 1 : 0) >=
			2,
		"补写必须双保险：async-complete 事件路径 + before_agent_start 轮询兜底",
	);
	// v1.0.74：未来签名 at 钳制接线（审计者 Note②）
	assert.ok(
		src.includes("clampFutureSignatureAt(root, state)"),
		"before_agent_start 必须接线未来 at 钳制（M2 漏审路径防线）",
	);
});

test("appendAuditReport：append-only + 字段渲染 + 与 chain 同目录", () => {
	const dir = tmpDir();
	const id1 = appendAuditReport(dir, {
		verdict: "passed",
		head: "abc123",
		window: "D-001 + 2 commits",
		blockers: [],
		runId: "run-1",
		body: "目标推导：加缓存。逐条判定：D-001 ✓",
	});
	assert.ok(
		id1.startsWith("AUDIT-"),
		`id 必须为 AUDIT-<epoch ms>，实际 ${id1}`,
	);
	assert.ok(fs.existsSync(auditLogPath(dir)), "audit-log.md 必须被创建");
	// 与 chain 同目录（证明链同盘）
	assert.equal(path.dirname(auditLogPath(dir)), path.dirname(chainPath(dir)));
	const id2 = appendAuditReport(dir, {
		verdict: "blocked",
		head: "def456",
		window: "D-002",
		blockers: ["extensions/a.ts:12 缺守卫"],
		runId: "run-2",
		body: "偏离 ✗",
	});
	assert.notEqual(id2, id1, "id 必须唯一（epoch ms 粒度）");
	const raw = fs.readFileSync(auditLogPath(dir), "utf-8");
	// append-only：两条都在且先写在前
	assert.ok(raw.indexOf(id1) < raw.indexOf(id2), "旧条目必须保留且先写在前");
	assert.ok(raw.includes(`## ${id2}: blocked`), "标题行必须含 verdict");
	assert.ok(raw.includes("- Head: def456"), "Head 字段必须渲染");
	assert.ok(
		raw.includes("- Blockers: extensions/a.ts:12 缺守卫"),
		"blockers 必须渲染",
	);
	assert.ok(raw.includes("- Blockers: 无"), "空 blockers 必须渲染为'无'");
	assert.ok(raw.includes("- RunId: run-2"), "RunId 字段必须渲染");
	assert.ok(raw.includes("偏离 ✗"), "正文必须原样保留");
});

test("readAuditState 读侧自愈：截断补全 + .corrupt 备份恢复（v1.0.48）", () => {
	// ① 截断自愈：缺对象闭合 `}`（审计者 write 截断写被杀半程的典型形态）
	const dir1 = tmpDir();
	const file1 = auditStatePath(dir1);
	fs.mkdirSync(path.dirname(file1), { recursive: true });
	const truncated = JSON.stringify({
		lastAuditedId: "D-031",
		inFlight: false,
		signature: { status: "blocked", at: 123 },
		auditFindings: ["a", "b"],
	}).slice(0, -1);
	fs.writeFileSync(file1, truncated, "utf-8");
	const s1 = readAuditState(dir1);
	assert.equal(s1.lastAuditedId, "D-031", "截断自愈必须返回完整状态");
	assert.equal(s1.signature?.status, "blocked");
	assert.deepEqual(s1.auditFindings, ["a", "b"]);
	assert.ok(
		JSON.parse(fs.readFileSync(file1, "utf-8")),
		"截断自愈必须写回可解析文件",
	);
	// ② .corrupt 备份恢复：中间损坏（补 `}` 不可解）→ 从备份恢复
	const dir2 = tmpDir();
	const file2 = auditStatePath(dir2);
	fs.mkdirSync(path.dirname(file2), { recursive: true });
	const midBroken = '{"lastAuditedId": "D-031", "inFlight": tru}';
	fs.writeFileSync(file2, midBroken, "utf-8");
	fs.writeFileSync(
		path.join(path.dirname(file2), "state.json.corrupt-1786791753000"),
		JSON.stringify({
			lastAuditedId: "D-030",
			inFlight: true,
			convExtractedLine: 100,
		}),
		"utf-8",
	);
	const s2 = readAuditState(dir2);
	assert.equal(s2.lastAuditedId, "D-030", "必须从 .corrupt 备份恢复");
	assert.equal(s2.inFlight, true);
	assert.equal(s2.convExtractedLine, 100);
	// ③ 恢复失败：损坏 + 无可用备份 → DEFAULT 不抛错
	const dir3 = tmpDir();
	const file3 = auditStatePath(dir3);
	fs.mkdirSync(path.dirname(file3), { recursive: true });
	fs.writeFileSync(file3, '{"bad": [}', "utf-8");
	const s3 = readAuditState(dir3);
	assert.equal(s3.lastAuditedId, null, "恢复失败必须返回默认状态");
	assert.equal(s3.inFlight, false);
});

test("queryGaps：证明缺口对账 + 泛化发现聚合（pair_gaps 数据层）", () => {
	const dir = tmpDir();
	// ① 无审计 → 决策未审 = 全部决策；无 git → 产物未审 false
	appendDecision(
		dir,
		{
			summary: "采用 Redis 做读缓存",
			context: "QPS 峰值 2k",
			decision: "引入 Redis",
			rationale: "缓存命中 <5ms",
		},
		new Date("2026-08-15T00:00:00Z"),
	);
	let gaps = queryGaps(dir);
	assert.equal(gaps.latestAudit, null, "无审计条目");
	assert.equal(gaps.proofGaps.unreviewedDecisions.length, 1);
	assert.equal(gaps.proofGaps.interruptedHole, false);
	assert.equal(gaps.proofGaps.unauditedArtifacts, false, "无 git 不判产物未审");
	// ② 审计后 → 决策未审清空；blocked 未闭环命中
	const t2 = new Date("2026-08-15T01:00:00Z");
	appendAuditReport(
		dir,
		{
			verdict: "blocked",
			head: "abc123",
			window: "D-001",
			blockers: ["lib/a.ts:12 缺守卫"],
			runId: "run-1",
			body: "偏离 ✗",
		},
		t2,
	);
	gaps = queryGaps(dir);
	assert.equal(gaps.latestAudit?.verdict, "blocked");
	assert.equal(
		gaps.proofGaps.unreviewedDecisions.length,
		0,
		"审计覆盖后决策未审清空",
	);
	assert.equal(gaps.proofGaps.unclosedBlockers.length, 1);
	assert.equal(gaps.proofGaps.unclosedBlockers[0], "lib/a.ts:12 缺守卫");
	// ③ 审计后新决策 → 未审命中
	appendDecision(
		dir,
		{
			summary: "审计后新决策",
			context: "新增事实",
			decision: "新选择",
			rationale: "新理由",
		},
		new Date("2026-08-15T02:00:00Z"),
	);
	gaps = queryGaps(dir);
	assert.equal(gaps.proofGaps.unreviewedDecisions.length, 1);
	assert.equal(gaps.proofGaps.unreviewedDecisions[0].id, "D-002");
	// ④ interrupted 空洞
	appendAuditReport(
		dir,
		{
			verdict: "interrupted",
			head: "def456",
			window: "审计超时",
			blockers: [],
			runId: "run-2",
			body: "扩展补写",
		},
		new Date("2026-08-15T03:00:00Z"),
	);
	gaps = queryGaps(dir);
	assert.equal(gaps.proofGaps.interruptedHole, true);
	// ⑤ 泛化发现解析（审计者真实输出格式——正文含 `## 审计报告` 标题，48 实证曾误当条目边界）
	const logPath = auditLogPath(dir);
	const extra = `
## AUDIT-9999999999000: passed
- Verdict: passed
- Head: ffff
- Window: D-003
- Blockers: 无
- RunId: run-3
- Date: 2026-08-15T04:00:00Z

## 审计报告（范围: D-003）
- D-003: 一致 ✓

### 泛化发现
- 场景: 并发资源分配碰撞 | 路径: 全局位图分配 > 相对偏移 | 来源: blocker-1
- 场景: 区间重叠 | 路径: 半线区间验证跨层不相交 | 来源: D-031

正文其余部分
`;
	fs.appendFileSync(logPath, `\n${extra}\n`, "utf-8");
	gaps = queryGaps(dir, { limit: 5 });
	assert.equal(
		gaps.generalization.recentFindings.length,
		2,
		"泛化发现必须被解析（正文含 ## 审计报告 标题不得截断条目）",
	);
	assert.equal(gaps.generalization.recentFindings[0].scene, "并发资源分配碰撞");
	assert.equal(
		gaps.generalization.recentFindings[0].path,
		"全局位图分配 > 相对偏移",
	);
	assert.equal(gaps.generalization.recentFindings[0].source, "blocker-1");
	assert.equal(gaps.latestAudit?.verdict, "passed");
	assert.ok(
		gaps.latestAudit?.body.includes("审计报告（范围: D-003）"),
		"body 必须含报告标题（条目未被正文标题截断）",
	);
	// ⑥ 高频路径（同路径两条 → ≥2 次）
	const extra2 = `
## AUDIT-9999999999001: passed
- Verdict: passed
- Head: fffe
- Window: D-004
- Blockers: 无
- RunId: run-4
- Date: 2026-08-15T05:00:00Z

### 泛化发现
- 场景: 另一个并发场景 | 路径: 全局位图分配 > 相对偏移 | 来源: D-004
`;
	fs.appendFileSync(logPath, `\n${extra2}\n`, "utf-8");
	gaps = queryGaps(dir, { limit: 5 });
	assert.equal(gaps.generalization.frequentPaths.length, 1);
	assert.equal(
		gaps.generalization.frequentPaths[0].path,
		"全局位图分配 > 相对偏移",
	);
	assert.equal(gaps.generalization.frequentPaths[0].count, 2);
	// ⑦ 泛化发现 section 头兼容审计者实际写出形态 `**泛化发现（…）**：`（48d 实证：只认 `###` 恒空）
	const extra3 = `
## AUDIT-9999999999002: passed
- Verdict: passed
- Head: fffd
- Window: D-005
- Blockers: 无
- RunId: run-5
- Date: 2026-08-15T06:00:00Z

**泛化发现（发散核实路径型产出，48c 协议）**：
- 场景: 时区混合 | 路径: 统一转 epoch ms 比较 | 来源: reviewer Medium-1
`;
	fs.appendFileSync(logPath, `\n${extra3}\n`, "utf-8");
	gaps = queryGaps(dir, { limit: 5 });
	assert.equal(
		gaps.generalization.recentFindings.length,
		4,
		"同文件累积 4 条（⑤2 + ⑥1 + ⑦1）",
	);
	assert.equal(
		gaps.generalization.recentFindings[3].path,
		"统一转 epoch ms 比较",
		"**泛化发现** 形态必须被解析（写者对不齐盲区复发防护）",
	);
	// ⑧ 混合时区不误报（reviewer Medium-1）：chain 决策 `+08:00` vs audit-log `Z`——
	// 字符串比较会把本地小时当 UTC 比（已审决策误报未审），epoch ms 比较正确
	const dir2 = tmpDir();
	const tLocal = new Date("2026-08-15T20:00:00+08:00"); // = 12:00Z
	appendDecision(
		dir2,
		{
			summary: "本地时区决策",
			context: "ctx",
			decision: "dec",
			rationale: "rat",
		},
		tLocal,
	); // 手写为 +08:00 形态：模拟审计者 write
	const rawChain = readRaw(dir2).replace(
		tLocal.toISOString(),
		"2026-08-15T20:00:00+08:00",
	);
	fs.writeFileSync(chainPath(dir2), rawChain, "utf-8");
	appendAuditReport(
		dir2,
		{
			verdict: "passed",
			head: "abc",
			window: "D-001",
			blockers: [],
			runId: "r",
			body: "ok",
		},
		new Date("2026-08-15T13:00:00Z"), // 审计晚于决策（12:00Z）
	);
	gaps = queryGaps(dir2);
	assert.equal(
		gaps.proofGaps.unreviewedDecisions.length,
		0,
		"混合时区不得误报已审决策为未审（+08:00 vs Z 比较）",
	);
});

test("isPlaceholderFinding：占位判定统一规则（v1.0.57 三处漂移合并）", () => {
	assert.equal(isPlaceholderFinding("审计开始：窗口…"), true, "审计开始占位");
	assert.equal(
		isPlaceholderFinding("本轮纯咨询，无审计对象"),
		true,
		"纯咨询占位",
	);
	assert.equal(
		isPlaceholderFinding("审计未触发：spawn 失败，下轮重试"),
		true,
		"spawn 失败占位",
	);
	assert.equal(
		isPlaceholderFinding("审计触发失败：spawn 失败，下轮重试"),
		true,
		"触发失败占位",
	);
	assert.equal(
		isPlaceholderFinding("核实 1 ✓：窗口提交全部独立审阅"),
		false,
		"真实核实",
	);
	assert.equal(isPlaceholderFinding("收尾：决策提取 D-030"), false, "真实收尾");
});

test("appendGeneralization/readGeneralizations：gaps.md 原语库（v1.0.60）", () => {
	const dir = tmpDir();
	// 初始为空
	assert.deepEqual(readGeneralizations(dir), []);
	// append 两条
	const n1 = appendGeneralization(dir, [
		{
			scene: "并发资源分配碰撞",
			path: "全局位图分配 > 相对偏移",
			source: "blocker-1",
		},
		{ scene: "API 限流", path: "令牌桶+漏桶双层", source: "D-031" },
	]);
	assert.equal(n1, 2);
	assert.ok(fs.existsSync(generalizationPath(dir)));
	let all = readGeneralizations(dir);
	assert.equal(all.length, 2);
	assert.equal(all[0].path, "全局位图分配 > 相对偏移");
	// append-only：再追加一条
	appendGeneralization(dir, [
		{ scene: "缓存选型", path: "本地缓存+TTL 混合", source: "AUDIT-1" },
	]);
	all = readGeneralizations(dir);
	assert.equal(all.length, 3, "append-only：旧条目保留");
	assert.equal(all[2].scene, "缓存选型");
	// 空 findings 不写
	assert.equal(appendGeneralization(dir, []), 0);
	// 与 chain 同目录（证明链同盘）
	assert.equal(
		path.dirname(generalizationPath(dir)),
		path.dirname(chainPath(dir)),
	);
	// 行格式消毒：换行注入
	appendGeneralization(dir, [{ scene: "A\nB", path: "P", source: "S" }]);
	all = readGeneralizations(dir);
	assert.equal(all[all.length - 1].scene, "A B", "换行必须消毒为空格");
});

test("queryGaps：gaps.md 数据源合并（v1.0.60 泛化通道不依赖 audit-log）", () => {
	const dir = tmpDir();
	appendGeneralization(dir, [
		{ scene: "场景甲", path: "路径甲", source: "D-001" },
		{ scene: "场景乙", path: "路径甲", source: "D-002" },
	]);
	const gaps = queryGaps(dir, { limit: 5 });
	assert.equal(
		gaps.generalization.recentFindings.length,
		2,
		"gaps.md findings 必须被聚合",
	);
	assert.equal(gaps.generalization.recentFindings[0].audit, "gaps.md");
	assert.equal(
		gaps.generalization.frequentPaths.length,
		1,
		"高频路径统计跨源生效",
	);
	assert.equal(gaps.generalization.frequentPaths[0].count, 2);
});

test("shouldBackfillAuditLog：存在性 + verdict + blockers 判别（v1.0.70）", () => {
	const entry = (
		runId: string,
		head: string,
		verdict = "passed",
		blockers: string[] = [],
	) => ({
		id: "AUDIT-1",
		verdict,
		head,
		window: "w",
		blockers,
		runId,
		date: "2026-08-15T10:00:00Z",
		body: "",
		findings: [],
	});
	// runId 匹配（正常落盘）→ 不补写
	assert.equal(
		shouldBackfillAuditLog(
			[entry("run-1", "h")],
			"run-1",
			"sighead1",
			"passed",
			[],
		),
		false,
		"runId 匹配 = 已落盘，不补写",
	);
	// runId 不同 + head 不匹配 → 补写
	assert.equal(
		shouldBackfillAuditLog(
			[entry("run-0", "h")],
			"run-1",
			"sighead1",
			"passed",
			[],
		),
		true,
		"runId 不同且 head 不匹配 = 未落盘，补写",
	);
	// head 精确匹配 + verdict 相同 + blockers 相同 → 不补写
	assert.equal(
		shouldBackfillAuditLog(
			[entry("", "abcdef1234567890abcdef1234567890abcdef12")],
			"",
			"abcdef1234567890abcdef1234567890abcdef12",
			"passed",
			[],
		),
		false,
		"head 精确匹配且 verdict 相同 = 已落盘，不补写",
	);
	// head 前缀匹配（回填短哈希）+ verdict 相同 → 不补写
	assert.equal(
		shouldBackfillAuditLog(
			[entry("", "abcdef12")],
			"",
			"abcdef1234567890abcdef1234567890abcdef12",
			"passed",
			[],
		),
		false,
		"回填短哈希条目按前缀匹配 = 已落盘，不补写",
	);
	// 同 head 不同 verdict（修复轮 blocked→passed，HEAD 未变）→ 补写
	assert.equal(
		shouldBackfillAuditLog(
			[entry("", "H", "blocked", ["a"])],
			"",
			"H",
			"passed",
			[],
		),
		true,
		"同 head 不同 verdict（修复轮新结论）必须补写——v1.0.65 回归防线",
	);
	// 同 head 同 verdict 同 blockers → 不补写（幂等）
	assert.equal(
		shouldBackfillAuditLog(
			[entry("", "H", "blocked", ["a"])],
			"",
			"H",
			"blocked",
			["a"],
		),
		false,
		"同 head 同 verdict 同 blockers = 已记录，不补写",
	);
	// v1.0.70 Medium：同 head 同 verdict 异 blockers（修复轮缺口演进）→ 补写
	assert.equal(
		shouldBackfillAuditLog(
			[entry("", "H", "blocked", ["旧缺口"])],
			"",
			"H",
			"blocked",
			["新缺口"],
		),
		true,
		"同 head 同 verdict 异 blockers = 新结论，必须补写（unclosedBlockers 双源漂移防线）",
	);
	// v1.0.70 Low：low-value 条目 + passed 签名 → 视为已记录不补（防冗余补写）
	assert.equal(
		shouldBackfillAuditLog(
			[entry("", "H", "low-value")],
			"",
			"H",
			"passed",
			[],
		),
		false,
		"low-value 条目对 passed 签名视为已记录（轻量退出窗口不重复补写）",
	);
	// v1.0.71：blockers 顺序无关（同集合不同顺序 = 已记录，不补）
	assert.equal(
		shouldBackfillAuditLog(
			[entry("", "H", "blocked", ["b", "a"])],
			"",
			"H",
			"blocked",
			["a", "b"],
		),
		false,
		"blockers 内容比较必须顺序无关（sort + JSON.stringify）",
	);
	// v1.0.71：blockers 含分隔符文本不撞 key（JSON 序列化安全）
	assert.equal(
		shouldBackfillAuditLog(
			[entry("", "H", "blocked", ["a", "b"])],
			"",
			"H",
			"blocked",
			["a", "b | c"],
		),
		true,
		"含分隔符的 blocker 文本不得撞 key（JSON 不拆分文本）",
	);
	// v1.0.72（审计者 blocker）：多空白对称——判定侧与写入侧 clean 同变换后相等
	assert.equal(
		shouldBackfillAuditLog(
			[entry("", "H", "blocked", ["a b c"])], // 条目侧（clean 后）
			"",
			"H",
			"blocked",
			["a  b   c"], // sig 侧（原始多空白）
		),
		false,
		"多空白必须对称归一（v1.0.61 同型重复补写防线）",
	);
	// v1.0.68：空 head 条目不匹配任意签名 → 补写
	assert.equal(
		shouldBackfillAuditLog([entry("", "")], "", "sighead1", "passed", []),
		true,
		'空 head 条目不得匹配（startsWith("") 恒真毒化守卫）',
	);
	// 无条目 → 补写
	assert.equal(shouldBackfillAuditLog([], "run-1", "h", "passed", []), true);
});

test("backfillAuditLogIfNeeded：双保险补写入口（v1.0.63）", () => {
	const dir = tmpDir();
	// ① 签名已写但 audit-log 无条目 → 补写
	recordSignature(dir, { status: "passed" }, "head1");
	const s1 = readAuditState(dir);
	s1.auditStartedAt = (s1.signature?.at ?? 0) - 60_000; // 审计开始早于签名（真实流程）
	assert.equal(backfillAuditLogIfNeeded(dir, s1), true, "未落盘必须补写");
	const entries1 = readAuditLog(dir);
	assert.equal(entries1.length, 1);
	assert.equal(entries1[0].verdict, "passed");
	// ② 幂等：再调不补
	const s1b = readAuditState(dir);
	s1b.auditStartedAt = (s1b.signature?.at ?? 0) - 60_000;
	assert.equal(backfillAuditLogIfNeeded(dir, s1b), false, "已补写不重复");
	// ③ failed 签名不补
	const dir2 = tmpDir();
	recordSignature(dir2, { status: "failed" }, "head2");
	assert.equal(
		backfillAuditLogIfNeeded(dir2, readAuditState(dir2)),
		false,
		"failed 不补（非审计者真实结论）",
	);
	// ④ 审计者已正常落盘（runId 匹配）→ 不补
	const dir3 = tmpDir();
	appendAuditReport(
		dir3,
		{
			verdict: "passed",
			head: "h",
			window: "w",
			blockers: [],
			runId: "run-9",
			body: "ok",
		},
		new Date("2026-08-15T10:00:00Z"),
	);
	recordSignature(dir3, { status: "passed", runId: "run-9" }, "head3");
	const s3 = readAuditState(dir3);
	s3.auditRunId = "run-9";
	s3.auditStartedAt = new Date("2026-08-15T10:05:00Z").getTime();
	assert.equal(
		backfillAuditLogIfNeeded(dir3, s3),
		false,
		"runId 匹配已落盘不补",
	);
	// ⑤ 签名无 runId + auditRunId 非空：补写条目 runId 与判定同源 → 幂等（reviewer Medium v1.0.64）
	const dir4 = tmpDir();
	recordSignature(dir4, { status: "passed" }, "head4"); // 签名无 runId
	const s4 = readAuditState(dir4);
	s4.auditRunId = "run-4"; // 但 auditRunId 非空（auditRunId 落盘失败模式的实证场景）
	s4.auditStartedAt = new Date("2026-08-15T10:05:00Z").getTime();
	assert.equal(backfillAuditLogIfNeeded(dir4, s4), true, "首次补写");
	const entries4 = readAuditLog(dir4);
	assert.equal(
		entries4[0].runId,
		"run-4",
		"补写条目 runId 必须与判定同源（sig.runId ?? auditRunId）",
	);
	const s4b = readAuditState(dir4);
	s4b.auditStartedAt = (s4b.signature?.at ?? 0) - 60_000;
	assert.equal(
		backfillAuditLogIfNeeded(dir4, s4b),
		false,
		"同源 runId 幂等：不得每轮重复补写（v1.0.61 同型复发防线）",
	);
	// ⑥ in-flight 也补（v1.0.66 存在性语义：in-flight 时 state.signature 是上轮签名，
	// audit-log 无其条目 → 补写 = 上轮漏补恢复——reviewer Medium 修复的行为）；幂等防重复
	const dir5 = tmpDir();
	recordSignature(dir5, { status: "blocked" }, "head5"); // 上轮签名（无 blockers 泄漏型）
	const s5 = readAuditState(dir5);
	s5.inFlight = true; // 新审计 in-flight（上轮结论尚未补写）
	s5.auditStartedAt = new Date("2026-08-15T10:05:00Z").getTime();
	s5.auditFindings = ["核实 1 ✓：窗口提交全部独立审阅", "发现：缺口 X"]; // 兜底派生源
	assert.equal(
		backfillAuditLogIfNeeded(dir5, s5),
		true,
		"in-flight 时上轮未补条目必须补写（Medium 修复：门方案会永久丢弃）",
	);
	const entries5 = readAuditLog(dir5);
	assert.equal(
		entries5[0].blockers.length,
		2,
		"兜底派生 blockers 必须写入条目（auditFindings 过滤占位后全部）",
	);
	// v1.0.73（reviewer Medium）：泄漏型幂等——存在性检查用派生值后，重复调用不补
	const s5b = readAuditState(dir5);
	s5b.inFlight = true;
	s5b.auditStartedAt = new Date("2026-08-15T10:05:00Z").getTime();
	s5b.auditFindings = ["核实 1 ✓：窗口提交全部独立审阅", "发现：缺口 X"];
	assert.equal(
		backfillAuditLogIfNeeded(dir5, s5b),
		false,
		"泄漏型（blocked 无 blockers + findings 派生）不得每轮重复补写（v1.0.73 防线）",
	);
	// ⑦ 陈旧签名（at < auditStartedAt）+ 无条目 → 补写（存在性语义与审计状态无关）；幂等
	const dir6 = tmpDir();
	recordSignature(dir6, { status: "passed" }, "head6");
	const s6 = readAuditState(dir6);
	s6.inFlight = false;
	s6.auditStartedAt = new Date("2026-08-15T23:00:00Z").getTime(); // 审计开始晚于签名
	assert.equal(
		backfillAuditLogIfNeeded(dir6, s6),
		true,
		"陈旧签名（at < auditStartedAt）无条目也补写（存在性检查与时间无关）",
	);
	const s6b = readAuditState(dir6);
	s6b.auditStartedAt = new Date("2026-08-15T23:00:00Z").getTime();
	assert.equal(backfillAuditLogIfNeeded(dir6, s6b), false, "补写后幂等");
});

test("clampFutureSignatureAt：未来 at 钳制（v1.0.74 阈值语义锁定）", () => {
	const dir = tmpDir();
	const now = Date.now();
	// 未来 at（+10min，LLM 换算错误实证形态）→ 钳制为当前时间
	recordSignature(dir, { status: "passed" }, "head1");
	patchAuditState(dir, {
		signature: { status: "passed", at: now + 10 * 60 * 1000, head: "head1" },
	});
	const st = readAuditState(dir);
	assert.equal(clampFutureSignatureAt(dir, st), true, "未来 at 必须钳制");
	const after = readAuditState(dir);
	assert.ok(
		after.signature!.at <= now + 1000 && after.signature!.at >= now - 1000,
		"钳制后 at ≈ 当前时间（落盘修正）",
	);
	// 容差内（+2min）→ 不钳制
	recordSignature(dir, { status: "passed" }, "head2");
	patchAuditState(dir, {
		signature: { status: "passed", at: now + 2 * 60 * 1000, head: "head2" },
	});
	assert.equal(
		clampFutureSignatureAt(dir, readAuditState(dir)),
		false,
		"容差内（5min）不钳制",
	);
	// 缺 at / 无签名 → noop
	patchAuditState(dir, { signature: null });
	assert.equal(
		clampFutureSignatureAt(dir, readAuditState(dir)),
		false,
		"无签名 noop",
	);
	patchAuditState(dir, {
		signature: { status: "passed", at: 0, head: "head3" },
	});
	assert.equal(
		clampFutureSignatureAt(dir, readAuditState(dir)),
		false,
		"缺 at noop",
	);
});

test("appendProcessSignal：信号词命中才记录", () => {
	const dir = tmpDir();
	// 命中：含决策信号词
	assert.equal(appendProcessSignal(dir, "我决定采用 Redis 做读缓存"), true);
	assert.equal(appendProcessSignal(dir, "方案是引入本地缓存"), true);
	// 未命中：普通陈述
	assert.equal(appendProcessSignal(dir, "我读完了文件，继续下一步"), false);

	const proc = readProcess(dir);
	assert.ok(proc.includes("决定采用 Redis"), "命中信号词必须记录");
	assert.ok(proc.includes("方案是引入本地缓存"));
	assert.ok(!proc.includes("读完了文件"), "未命中不得记录");
	// process.md 文件确实存在
	assert.ok(fs.existsSync(processPath(dir)));
});

test("appendProcessSignal：200 字符截断", () => {
	const dir = tmpDir();
	const long = "我决定采用方案：" + "很长的内容".repeat(60); // > 200 字符
	appendProcessSignal(dir, long);
	const proc = readProcess(dir);
	const line = proc.split("\n").find((l) => l.startsWith("- 🤔")) ?? "";
	assert.ok(line.length <= 210, `单条应 ≤200 字符+后缀，实际 ${line.length}`);
	assert.ok(line.endsWith("…"), "超长应截断并加省略号");
});

test("appendProcessSignal：滚动截断（超 100 条保留最近 50）", () => {
	const dir = tmpDir();
	for (let i = 0; i < 110; i++) {
		appendProcessSignal(dir, `我决定第 ${i} 个方案`);
	}
	const raw = fs.readFileSync(processPath(dir), "utf-8");
	const body = raw.split("\n").filter((l) => l.startsWith("- 🤔"));
	assert.ok(body.length <= 100, `滚动截断后应 ≤100 条，实际 ${body.length}`);
	// 保留的是最近条目（第 101 次触发截断删掉最早的）
	assert.ok(raw.includes("第 109 个方案"));
	assert.ok(!raw.includes("第 0 个方案"), "最早的应被截断");
});

test("appendProcessSignal：runId 标记隔离", () => {
	const dir = tmpDir();
	appendProcessSignal(dir, "我决定采用方案 X", "run-a");
	const raw = fs.readFileSync(processPath(dir), "utf-8");
	assert.ok(raw.includes("<!--run:run-a-->"), "带 runId 的行必须标记");
	// 无 runId（旧格式）不产生标记
	appendProcessSignal(dir, "我决定采用方案 Y");
	const raw2 = fs.readFileSync(processPath(dir), "utf-8");
	assert.ok(!/方案 Y.*<!--run:/.test(raw2), "无 runId 调用不得标记");
});

test("convlogForeignRuns：多实例混写检测（并发窗口语义）", () => {
	// 交错追加：run-a 先写，run-b 在 run-a 首行之后交错写入 → 本实例（run-a）视角检测到并发
	const dir = tmpDir();
	appendConv(dir, "user", "本实例用户请求", "run-a");
	appendConv(dir, "assistant", "本实例回复", "run-a");
	appendConv(dir, "user", "并发实例的 ctx_knowledge 讨论", "run-b");
	appendConv(dir, "user", "旧代码无标记行", undefined);

	assert.equal(convlogForeignRuns(dir, "run-a"), 1);
	// 反向视角：run-b 首行之后只有无标记行 → run-a 的行是"首行之前的历史"（run-b 视角
	// 无法区分历史与先启动的并发实例——检测只需一侧命中：先启动方必然看到后者的交错行）
	assert.equal(convlogForeignRuns(dir, "run-b"), 0);
	// 无标记行（历史无法归属）不误报
	const dirLegacy = tmpDir();
	appendConv(dirLegacy, "user", "旧代码无标记行", undefined);
	assert.equal(convlogForeignRuns(dirLegacy, "run-x"), 0);
	// 审计任务注入（Task: 前缀）不算外来会话
	const dirTask = tmpDir();
	appendConv(dirTask, "user", "Task: 你是链维护审计者…", "run-c");
	assert.equal(convlogForeignRuns(dirTask, "run-x"), 0);
	// 用户正文内嵌伪造标记（非行尾）不算外来——防伪造 run 标记关闭审计门禁
	const dirSpoof = tmpDir();
	appendConv(
		dirSpoof,
		"user",
		"请修复这个 bug <!--run:run-999-zzz-->",
		"run-a",
	);
	assert.equal(convlogForeignRuns(dirSpoof, "run-a"), 0);
	// P1 回归：本实例首行之前的**历史**外来行不算（convlog 按 cwd 永久追加，历史行
	// 恒在 → 旧语义下第二个会话起守卫恒 >0、自动审计永久停摆）
	const dirHistory = tmpDir();
	appendConv(dirHistory, "user", "上一会话的用户请求", "run-old");
	appendConv(dirHistory, "assistant", "上一会话的回复", "run-old");
	appendConv(dirHistory, "user", "本会话用户请求", "run-new");
	assert.equal(convlogForeignRuns(dirHistory, "run-new"), 0);
	// 纯单实例：无外来行
	const dir2 = tmpDir();
	appendConv(dir2, "user", "只有本实例", "run-a");
	assert.equal(convlogForeignRuns(dir2, "run-a"), 0);
});

test("convlogForeignRuns：同进程多会话（同 pid 不同 run）不算并发（v1.0.24）", () => {
	// 同进程切会话：run 标记随会话重新生成，但 pid 相同——A 会话的行不得把 B 会话
	// 的审计误判为多实例错审（否则切会话后自动审计永久停摆）
	const dir = tmpDir();
	appendConv(dir, "user", "本会话请求", "run-123-bbb");
	appendConv(dir, "user", "同进程切换的上一会话", "run-123-aaa");
	appendConv(dir, "user", "另一 pi 进程的会话", "run-456-ccc");
	assert.equal(convlogForeignRuns(dir, "run-123-bbb"), 1); // 只数不同 pid 的 run-456-ccc
	// 反向视角：run-456-ccc 首行之后无行（前两行是历史）→ 0
	assert.equal(convlogForeignRuns(dir, "run-456-ccc"), 0);
	// 同进程内两个会话互相不算并发（双向）
	const dirSame = tmpDir();
	appendConv(dirSame, "user", "会话 A", "run-123-aaa");
	appendConv(dirSame, "user", "会话 B（同进程）", "run-123-bbb");
	assert.equal(convlogForeignRuns(dirSame, "run-123-aaa"), 0);
	// 旧格式 run 标记（无 pid 前缀，run-xxx）回退全等判定：互不相同 → 仍算并发
	const dirLegacy = tmpDir();
	appendConv(dirLegacy, "user", "本实例", "run-x");
	appendConv(dirLegacy, "user", "另一实例（旧格式）", "run-y");
	assert.equal(convlogForeignRuns(dirLegacy, "run-x"), 1);
});

test("lastAuditDurationMs：读写与消毒", () => {
	const dir = tmpDir();
	writeAuditState(dir, {
		...readAuditState(dir),
		lastAuditDurationMs: 12345,
	});
	assert.equal(readAuditState(dir).lastAuditDurationMs, 12345);
	// 坏值消毒
	fs.mkdirSync(path.dirname(auditStatePath(dir)), { recursive: true });
	fs.writeFileSync(
		auditStatePath(dir),
		'{"lastAuditDurationMs": "bad"}',
		"utf-8",
	);
	assert.equal(readAuditState(dir).lastAuditDurationMs, 0);
});

test("recordSignature 字段级写入", () => {
	const dir = tmpDir();
	appendConv(dir, "user", "测试");
	recordSignature(dir, { status: "passed" });
	const s1 = readAuditState(dir);
	assert.equal(s1.signature?.status, "passed");
	assert.ok(s1.signatureConvLine > 0);
	assert.equal(needsSignoff(dir), false);

	// blocked 签名
	recordSignature(dir, { status: "blocked", blockers: ["x"] });
	const s2 = readAuditState(dir);
	assert.equal(s2.signature?.status, "blocked");
	assert.deepEqual(s2.signature?.blockers, ["x"]);
});

test("blockedStreak：blocked 递增，passed/降级清零（timeout 态已移除）", () => {
	const dir = tmpDir();
	appendConv(dir, "user", "测试");

	// 初始 0
	assert.equal(readAuditState(dir).blockedStreak, 0);

	// blocked 递增 1
	recordSignature(dir, { status: "blocked", blockers: ["a"] });
	assert.equal(readAuditState(dir).blockedStreak, 1);

	// blocked 递增 2（连续）
	recordSignature(dir, { status: "blocked", blockers: ["b"] });
	assert.equal(readAuditState(dir).blockedStreak, 2);

	// passed 清零
	recordSignature(dir, { status: "passed" });
	assert.equal(readAuditState(dir).blockedStreak, 0);

	// 降级放行（passed-with-warning）也清零
	recordSignature(dir, { status: "blocked", blockers: ["c"] });
	assert.equal(readAuditState(dir).blockedStreak, 1);
	recordSignature(dir, {
		status: "passed-with-warning",
		blockers: ["c"],
	});
	assert.equal(readAuditState(dir).blockedStreak, 0);
	assert.equal(readAuditState(dir).signature?.status, "passed-with-warning");
	assert.equal(readAuditState(dir).signature?.status, "passed-with-warning");
});

test("recordSignature failed：不递增 blockedStreak、不推进 signatureConvLine（审计未触发，下轮重审）", () => {
	const dir = tmpDir();
	appendConv(dir, "user", "测试");

	// 先有 blocked 记录（streak=1）与已推进的 convLine
	recordSignature(dir, { status: "blocked", blockers: ["a"] });
	const before = readAuditState(dir);
	assert.equal(before.blockedStreak, 1);
	assert.ok(before.signatureConvLine > 0);

	// 再追加对话（未审计的增量）
	appendConv(dir, "user", "新增产物");
	const convLineAfterAppend = convLogLineCount(dir);
	assert.ok(convLineAfterAppend > before.signatureConvLine);

	// failed 签名（spawn 失败）
	recordSignature(dir, {
		status: "failed",
		reason: "审计触发失败（spawn 失败）",
	});
	const after = readAuditState(dir);
	assert.equal(after.signature?.status, "failed");
	assert.equal(after.signature?.reason, "审计触发失败（spawn 失败）");
	// 不递增 blockedStreak（非产物问题）
	assert.equal(after.blockedStreak, 1);
	// 不推进 signatureConvLine（产物未被审计覆盖 → needsSignoff 仍 true → 下轮重审）
	assert.equal(after.signatureConvLine, before.signatureConvLine);
	assert.equal(needsSignoff(dir), true);
	// 释放 inFlight（防锁泄漏）
	assert.equal(after.inFlight, false);
});

test("recordSignature 释放 inFlight 锁（H1：防锁泄漏致审计永久停摆）", () => {
	const dir = tmpDir();
	appendConv(dir, "user", "测试");
	// 模拟审计运行中（inFlight=true）→ 审计者用 decision_signoff 签名
	writeAuditState(dir, {
		...readAuditState(dir),
		inFlight: true,
	});
	recordSignature(dir, { status: "blocked", blockers: ["x"] });
	// 签名 = 审计结束：锁必须释放（否则后续 agent_end 永不 spawn 审计者）
	assert.equal(readAuditState(dir).inFlight, false);
	// blocked 签名同时递增 streak
	assert.equal(readAuditState(dir).blockedStreak, 1);
});

test("readAuditState 坏 signature 消毒", () => {
	const dir = tmpDir();
	fs.mkdirSync(path.dirname(auditStatePath(dir)), { recursive: true });
	fs.writeFileSync(
		auditStatePath(dir),
		'{"signature": "passed-string"}',
		"utf-8",
	);
	const state = readAuditState(dir);
	assert.equal(state.signature, null); // 非对象 → 消毒为 null
});

// resolveAuditConfig 已随 L0 独立层删除（单层审计无需累积阈值配置）

test("resetForSessionStart 清跨会话待签名状态", () => {
	const dir = tmpDir();
	appendConv(dir, "user", "上一会话的工作");
	appendConv(dir, "assistant", "做了改动但没签名");
	// 模拟旧会话：有对话但 signatureConvLine=0 → needsSignoff=true
	assert.equal(needsSignoff(dir), true);

	// 新会话开始：重置
	resetForSessionStart(dir);
	assert.equal(needsSignoff(dir), false); // 不再触发待签名

	// 决策链进度保留
	const state = readAuditState(dir);
	assert.equal(state.inFlight, false);
	// signatureConvLine 推进到当前 convlog 行数
	assert.ok(state.signatureConvLine >= convLogLineCount(dir) - 0);
});

test("needsSignoff 与 recordSignature 状态机", () => {
	const dir = tmpDir();
	// 无对话 → 不需要签名
	assert.equal(needsSignoff(dir), false);

	// 有对话 → 需要签名
	appendConv(dir, "user", "请加一个函数");
	assert.equal(needsSignoff(dir), true);

	// 签名后 → 不再需要
	recordSignature(dir, { status: "passed" });
	assert.equal(needsSignoff(dir), false);

	// 新对话 → 又需要
	appendConv(dir, "assistant", "已完成");
	assert.equal(needsSignoff(dir), true);

	// blocked 签名也解除待签名（记录问题由注入处理）
	recordSignature(dir, { status: "blocked", blockers: ["产物不忠实"] });
	const state = readAuditState(dir);
	assert.equal(state.signature?.status, "blocked");
	assert.equal(state.signature?.blockers?.length, 1);
	assert.equal(needsSignoff(dir), false);
});

test("resolveProjectRoot 定位仓库根", () => {
	const root = tmpDir();
	// 子目录无标记 → 向上找
	const sub = path.join(root, "src");
	fs.mkdirSync(sub, { recursive: true });
	// 无标记时退化到 cwd
	assert.equal(resolveProjectRoot(sub), sub);

	// 放 Cargo.toml 标记
	fs.writeFileSync(path.join(root, "Cargo.toml"), "[package]\n", "utf-8");
	assert.equal(resolveProjectRoot(sub), root); // 向上找到根
	assert.equal(resolveProjectRoot(root), root); // 根本身

	// package.json 标记
	const node = path.join(root, "node");
	fs.mkdirSync(node, { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), "{}", "utf-8");
	assert.equal(resolveProjectRoot(node), root);
});

test("resolveProjectRoot：PI_PAIR_PROJECT_ROOT 显式权威根（跨盘符兜底）", () => {
	const dir = tmpDir();
	const explicit = path.join(dir, "real-root");
	fs.mkdirSync(explicit, { recursive: true });
	const prev = process.env.PI_PAIR_PROJECT_ROOT;
	try {
		process.env.PI_PAIR_PROJECT_ROOT = explicit;
		// 任意 cwd 都解析到显式根（跨盘符/复杂场景的单一权威）
		assert.equal(resolveProjectRoot(dir), explicit);
		assert.equal(
			resolveProjectRoot(path.join(dir, "deep", "nested")),
			explicit,
		);
	} finally {
		if (prev === undefined) delete process.env.PI_PAIR_PROJECT_ROOT;
		else process.env.PI_PAIR_PROJECT_ROOT = prev;
	}
	// 未设置时恢复正常探测
	assert.equal(resolveProjectRoot(dir), dir);
});

test("convLogLineCount 统计对话行", () => {
	const dir = tmpDir();
	appendConv(dir, "user", "你好");
	appendConv(dir, "assistant", "收到");
	assert.equal(convLogLineCount(dir), 2);
});

test("hasUncommittedChanges：真实产物判定（git 未提交改动）", () => {
	// 非 git 仓库（tmp 目录）→ false（对话增量判据兜底触发）
	const dir = tmpDir();
	assert.equal(hasUncommittedChanges(dir), false);

	// git 仓库且干净 → false
	const gitDir = tmpDir();
	const run = (args: string[]) =>
		execFileSync("git", args, {
			cwd: gitDir,
			stdio: ["ignore", "pipe", "pipe"],
		});
	run(["init", "-q"]);
	run(["config", "user.email", "t@t"]);
	run(["config", "user.name", "t"]);
	fs.writeFileSync(path.join(gitDir, "a.txt"), "v1", "utf-8");
	run(["add", "."]);
	run(["commit", "-qm", "init"]);
	assert.equal(hasUncommittedChanges(gitDir), false);

	// 未提交改动 → true
	fs.writeFileSync(path.join(gitDir, "a.txt"), "v2", "utf-8");
	assert.equal(hasUncommittedChanges(gitDir), true);

	// 未跟踪新文件 → true（--untracked-files=all）
	fs.writeFileSync(path.join(gitDir, "new.txt"), "x", "utf-8");
	assert.equal(hasUncommittedChanges(gitDir), true);

	// R11：扩展自身状态目录（.pi/ .pi-subagents/）不算产物——审计状态/convlog 写入不触发审计
	// 先让工作树干净（提交 a.txt v2，删除 new.txt 也提交），只剩 .pi 未跟踪
	run(["add", "-A"]);
	run(["commit", "-qm", "v2"]);
	fs.unlinkSync(path.join(gitDir, "new.txt"));
	run(["add", "-A"]);
	run(["commit", "-qm", "drop new"]);
	fs.mkdirSync(path.join(gitDir, ".pi", "decision-auditor"), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(gitDir, ".pi", "decision-auditor", "state.json"),
		"{}",
		"utf-8",
	);
	fs.mkdirSync(path.join(gitDir, ".pi-subagents", "artifacts"), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(gitDir, ".pi-subagents", "artifacts", "x.md"),
		"x",
		"utf-8",
	);
	assert.equal(
		hasUncommittedChanges(gitDir),
		false,
		".pi/.pi-subagents 写入不得算产物（纯咨询会话仍零审计）",
	);
	// 真实改动 + 状态目录并存 → 仍 true
	fs.writeFileSync(path.join(gitDir, "a.txt"), "v3", "utf-8");
	assert.equal(hasUncommittedChanges(gitDir), true);
});

test("hasNewConversation：对话增量判据（plan 阶段触发审计）", () => {
	const dir = tmpDir();
	// 无对话 → 无增量（不触发）
	assert.equal(hasNewConversation(dir, 0), false);
	// 有对话 → 增量（触发：spawn 审计者由它 AI 判定）
	appendConv(dir, "user", "我们采用方案 B 吧，放弃 A");
	assert.equal(hasNewConversation(dir, 0), true);
	// 审计者推进游标后 → 该段对话不再触发
	assert.equal(hasNewConversation(dir, 1), false);
	// 新对话 → 再次触发
	appendConv(dir, "assistant", "好，按方案 B 实现");
	assert.equal(hasNewConversation(dir, 1), true);
});

test("clampConvExtractedLine：单位钳制（纯读，不落盘——落盘由扩展合并进锁写点）", () => {
	const dir = tmpDir();
	appendConv(dir, "user", "一条");
	appendConv(dir, "assistant", "两条");
	// 正常值（≤ 对话行数）不受影响
	writeAuditState(dir, { ...readAuditState(dir), convExtractedLine: 1 });
	assert.equal(clampConvExtractedLine(dir), 1);
	// 审计者误写文件行号（> 对话行数）→ 返回钳制值；纯读不落盘（防与审计者进程读-改-写竞态）
	writeAuditState(dir, { ...readAuditState(dir), convExtractedLine: 500 });
	assert.equal(clampConvExtractedLine(dir), 2);
	assert.equal(
		readAuditState(dir).convExtractedLine,
		500,
		"clamp 是纯读，不落盘",
	);
	// 钳制值用于判据 → 无对话增量不触发（不再断线也不空转）
	assert.equal(hasNewConversation(dir, clampConvExtractedLine(dir)), false);
});

test("shouldInjectInterimFindings：中间态注入判据（B1 行为级 + 边界 3 跨会话）", () => {
	const base = {
		...readAuditState(tmpDir()),
		auditFindings: ["推导目标 ✓"],
		inFlight: true,
		auditStartedAt: 1000,
	};
	// 审计被杀（inFlight=true 锁残留）→ 注入
	assert.equal(shouldInjectInterimFindings(base, undefined), true);
	// 同轮已注入过（injectedAt === auditStartedAt）→ 去重不注入
	assert.equal(shouldInjectInterimFindings(base, 1000), false);
	// 纯咨询轮（inFlight=false + 占位 findings）→ 零注入（D-006 承诺）
	assert.equal(
		shouldInjectInterimFindings(
			{
				...base,
				inFlight: false,
				auditFindings: ["本轮纯咨询，无审计对象"],
			},
			undefined,
		),
		false,
	);
	// 无 findings → 不注入
	assert.equal(
		shouldInjectInterimFindings({ ...base, auditFindings: [] }, undefined),
		false,
	);
	// 边界 3：会话早结被杀（新会话 reset 清 inFlight + 无 signature + 真实 findings）→ 跨会话注入
	assert.equal(
		shouldInjectInterimFindings(
			{ ...base, inFlight: false, signature: null },
			undefined,
		),
		true,
	);
	// 审计正常收尾（signature 已写，findings 残留）→ 不注入（价值走 signature 通道）
	assert.equal(
		shouldInjectInterimFindings(
			{
				...base,
				inFlight: false,
				signature: { status: "passed", at: 2000 },
			},
			undefined,
		),
		false,
	);
	// v1.0.28（F-05）：启动占位 '审计开始…'（含变体）→ 不注入——在跑审计不得被
	// 误当「被中断审计」注入噪音（与超时降级路径同过滤规则）
	assert.equal(
		shouldInjectInterimFindings(
			{ ...base, auditFindings: ["审计开始"] },
			undefined,
		),
		false,
		"启动占位「审计开始」→ 不注入（F-05：在跑审计 ≠ 被中断）",
	);
	assert.equal(
		shouldInjectInterimFindings(
			{ ...base, auditFindings: ["审计开始：窗口=…"] },
			undefined,
		),
		false,
		"启动占位变体「审计开始：…」→ 不注入（前缀匹配）",
	);
	// 真实发现 + 启动占位混合 → 有真实 findings 仍注入（只滤纯占位）
	assert.equal(
		shouldInjectInterimFindings(
			{ ...base, auditFindings: ["审计开始", "已确认缺口：X"] },
			undefined,
		),
		true,
		"启动占位 + 真实发现 → 注入（占位过滤不吞真实发现）",
	);
});

test("shouldInjectSignatureFindings：结论注入判据 + 新鲜度校验（v1.0.24 跨会话泄露根治）", () => {
	const base = {
		...readAuditState(tmpDir()),
		signature: {
			status: "blocked" as const,
			at: 1000,
			blockers: ["缺口 A"],
			head: "abc1234",
		},
	};
	// blocked + head 与当前一致 → 注入
	assert.equal(shouldInjectSignatureFindings(base, undefined, "abc1234"), true);
	// HEAD 已推进（修复提交落库但再审未跑）→ 签名过时，不注入陈旧 blockers
	assert.equal(
		shouldInjectSignatureFindings(base, undefined, "def5678"),
		false,
	);
	// 同签名已注入过 → 去重
	assert.equal(shouldInjectSignatureFindings(base, 1000, "abc1234"), false);
	// head 缺失（旧版本签名/审计者漏写）→ 兼容注入（无法校验，不丢交付）
	assert.equal(
		shouldInjectSignatureFindings(
			{ ...base, signature: { ...base.signature!, head: undefined } },
			undefined,
			"def5678",
		),
		true,
	);
	// passed → 不注入（价值已交付）
	assert.equal(
		shouldInjectSignatureFindings(
			{ ...base, signature: { ...base.signature!, status: "passed" as const } },
			undefined,
			"abc1234",
		),
		false,
	);
	// 无 blockers → 不注入
	assert.equal(
		shouldInjectSignatureFindings(
			{ ...base, signature: { ...base.signature!, blockers: [] } },
			undefined,
			"abc1234",
		),
		false,
	);
	// 无签名 → 不注入
	assert.equal(
		shouldInjectSignatureFindings(
			{ ...base, signature: null },
			undefined,
			"abc1234",
		),
		false,
	);
	// passed-with-warning（降级）+ head 一致 → 注入（价值点保留）
	assert.equal(
		shouldInjectSignatureFindings(
			{
				...base,
				signature: {
					...base.signature!,
					status: "passed-with-warning" as const,
				},
			},
			undefined,
			"abc1234",
		),
		true,
	);
});

test("shouldClearStaleLock：残留锁兜底判据（v1.0.21 行为级）", () => {
	const base = {
		...readAuditState(tmpDir()),
		inFlight: true,
	};
	// 文件锁在 + 内存锁无（审计者被强杀未写收尾）→ 清锁
	assert.equal(shouldClearStaleLock(base, false), true);
	// 文件锁在 + 内存锁也在（审计真在跑）→ 不清锁（防并发双审计）
	assert.equal(shouldClearStaleLock(base, true), false);
	// 无文件锁 → 不清锁
	assert.equal(
		shouldClearStaleLock({ ...base, inFlight: false }, false),
		false,
	);
	// 纯咨询轮（无任何 work 信号）→ 判据与 hasWork 无关，残留锁仍清——
	// 位置语义（先于 hasWork return）由接线守卫 indexOf 顺序断言锁定
	assert.equal(shouldClearStaleLock(base, false), true);
});

test("gitHead：交付门禁的客观信号（HEAD 变化）", () => {
	const dir = tmpDir();
	// 非 git 仓库 → null（无门禁）
	assert.equal(gitHead(dir), null);
	// git 仓库：init + commit 后返回 HEAD，且提交后 HEAD 变化
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "a.txt"), "v1");
	execFileSync("git", ["add", "a.txt"], { cwd: dir });
	execFileSync("git", ["commit", "-qm", "c1"], { cwd: dir });
	const head1 = gitHead(dir);
	assert.ok(head1 && head1.length >= 7, "首次提交后应有 HEAD");
	fs.writeFileSync(path.join(dir, "a.txt"), "v2");
	execFileSync("git", ["add", "a.txt"], { cwd: dir });
	execFileSync("git", ["commit", "-qm", "c2"], { cwd: dir });
	assert.notEqual(
		gitHead(dir),
		head1,
		"新提交后 HEAD 必须变化（门禁触发依据）",
	);
});

test("L3：signature.head 必须与 gitHead() 同格式（全哈希）——短哈希永不注入", () => {
	const dir = tmpDir();
	// 建 git 仓库拿真实全哈希
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "a.txt"), "v1");
	execFileSync("git", ["add", "a.txt"], { cwd: dir });
	execFileSync("git", ["commit", "-qm", "c1"], { cwd: dir });
	const full = gitHead(dir)!;
	assert.ok(full.length > 20, "gitHead 必须返回全哈希");
	const short = full.slice(0, 7);
	// 构造 blocked 签名：head = 全哈希 → 新鲜，注入
	writeAuditState(dir, {
		...readAuditState(dir),
		signature: {
			status: "blocked",
			at: 1000,
			blockers: ["缺口"],
			head: full,
		},
	});
	assert.equal(
		shouldInjectSignatureFindings(readAuditState(dir), undefined, full),
		true,
		"全哈希 head 与当前 HEAD 一致 → 注入",
	);
	// 审计者误写短哈希（旧 prompt 行为）→ 恒不等于全哈希 → 永不注入（v1.0.26 回归锁定）
	writeAuditState(dir, {
		...readAuditState(dir),
		signature: {
			status: "blocked",
			at: 2000,
			blockers: ["缺口"],
			head: short,
		},
	});
	assert.equal(
		shouldInjectSignatureFindings(readAuditState(dir), undefined, full),
		false,
		"短哈希 head ≠ 全哈希 currentHead → 不注入（防止单位错配永久静默）",
	);
});

test("L2：writeAuditState 合并写保留未知字段 + 损坏文件备份重建", () => {
	const dir = tmpDir();
	// 未知字段（未来版本新增）不能被任意写者消毒删除
	writeAuditState(dir, {
		...readAuditState(dir),
		inFlight: true,
	});
	const file = auditStatePath(dir);
	const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
	raw.futureField = "未来新增字段";
	fs.writeFileSync(file, JSON.stringify(raw), "utf-8");
	// 任意写者写入 → 未知字段保留
	writeAuditState(dir, { ...readAuditState(dir), inFlight: false });
	const after = JSON.parse(fs.readFileSync(file, "utf-8"));
	assert.equal(
		after.futureField,
		"未来新增字段",
		"字段级合并写必须保留未知字段（gatedHead 丢失事故的机制修复）",
	);
	assert.equal(after.inFlight, false);
	// 损坏文件 → 备份 .corrupt-* 后重建，不丢真实进度
	fs.writeFileSync(file, "{broken json", "utf-8");
	writeAuditState(dir, { ...readAuditState(dir), inFlight: true });
	const dirEntries = fs.readdirSync(path.dirname(file));
	assert.ok(
		dirEntries.some((e) => e.startsWith("state.json.corrupt-")),
		"损坏 state.json 必须备份为 .corrupt-*（防默认值覆盖真实进度）",
	);
	assert.equal(readAuditState(dir).inFlight, true);
});

test("L1：patchAuditState 字段级写（乐观锁冲突重试一次）", () => {
	const dir = tmpDir();
	// 正常路径：只 patch 指定字段，其他字段保留
	writeAuditState(dir, {
		...readAuditState(dir),
		inFlight: true,
		gatedHead: "abc",
	});
	assert.equal(patchAuditState(dir, { inFlight: false }), true);
	const st = readAuditState(dir);
	assert.equal(st.inFlight, false);
	assert.equal(st.gatedHead, "abc", "patch 只改指定字段，其他字段保留");
	// 冲突拒绝路径由既有测试 "writeAuditState mtime 乐观锁：匹配写、冲突放弃" 覆盖；
	// patchAuditState 重试（读最新 → 重写）在同步单测中无法注入 read-write 窗口竞态，不做伪测试
});

test("v1.0.26：isAuditCompleted 完成判定（at 锚点 + runId 身份 + failed 排除）", () => {
	const base: AuditState = {
		lastAuditedId: null,
		inFlight: false,
		convExtractedLine: 0,
		lastAuditAt: 0,
		signature: null,
		signatureConvLine: 0,
		blockedStreak: 0,
		auditFindings: [],
		lastAuditDurationMs: 0,
		auditStartedAt: 1000,
		auditRunId: "",
		lastError: null,
		gatedHead: null,
		injectedSignatureAt: null,
		injectedInterimAt: null,
	};
	// 无签名 → 未完成
	assert.equal(isAuditCompleted({ ...base }, 1000), false);
	// 本轮新签名（at >= startedAt）且锁已释放 → 完成（blocked 也是完成）
	assert.equal(
		isAuditCompleted(
			{ ...base, signature: { status: "blocked", at: 2000, blockers: ["x"] } },
			1000,
		),
		true,
		"blocked 签名 at>=startedAt → 完成（blocked 也是完成，防覆盖真实 blockers）",
	);
	// 旧轮签名（at 远早于 startedAt，超时钟容差）→ 未完成
	assert.equal(
		isAuditCompleted(
			{
				...base,
				signature: {
					status: "passed",
					at: 1000 - 10 * 60 * 1000,
				},
			},
			1000,
		),
		false,
		"超时钟容差的旧轮签名（10min 前）→ 未完成",
	);
	// v1.0.28（LC-06）：时钟容差内签名（跨主机/网络盘时钟偏移）→ 完成
	// （at=500、startedAt=1000 差 500ms 在 CLOCK_SKEW_GRACE_MS=5min 容差内）
	assert.equal(
		isAuditCompleted(
			{ ...base, signature: { status: "passed", at: 500 } },
			1000,
		),
		true,
		"v1.0.28 时钟容差：at 落后 startedAt 在容差内 → 完成（LC-06 跨主机偏移）",
	);
	// inFlight=true → 未完成（审计者还在收尾）
	assert.equal(
		isAuditCompleted(
			{
				...base,
				inFlight: true,
				signature: { status: "passed", at: 2000 },
			},
			1000,
		),
		false,
		"inFlight=true → 未完成",
	);
	// failed = spawn 失败标记，非审计签名 → 永不视为完成（结对审计注意项 + v1.0.24 语义）
	assert.equal(
		isAuditCompleted(
			{
				...base,
				signature: { status: "failed", at: 5000 },
			},
			1000,
		),
		false,
		"failed 签名（spawn 失败标记）永不视为完成——failed.at 可晚于 auditStartedAt，不得劫持门禁",
	);
	// runId 身份校验（JD #14）：签名属于其他 spawn 的审计者 → 未完成
	assert.equal(
		isAuditCompleted(
			{
				...base,
				auditRunId: "run-A",
				signature: { status: "passed", at: 2000, runId: "run-B" },
			},
			1000,
		),
		false,
		"签名 runId ≠ state.auditRunId（遗留/并发审计者）→ 不得劫持本会话门禁",
	);
	// runId 匹配 → 完成
	assert.equal(
		isAuditCompleted(
			{
				...base,
				auditRunId: "run-A",
				signature: { status: "passed", at: 2000, runId: "run-A" },
			},
			1000,
		),
		true,
		"签名 runId = state.auditRunId → 完成",
	);
	// 兼容：审计者漏写 runId（旧 prompt 行为）→ 放行（不破坏既有流程）
	assert.equal(
		isAuditCompleted(
			{
				...base,
				auditRunId: "run-A",
				signature: { status: "passed", at: 2000 },
			},
			1000,
		),
		true,
		"签名缺 runId（旧版本）→ 兼容放行",
	);
	// B5 兜底：签名缺 at（消毒为 0）但 lastAuditAt >= startedAt → 完成
	assert.equal(
		isAuditCompleted(
			{ ...base, lastAuditAt: 2000, signature: { status: "passed", at: 0 } },
			1000,
		),
		true,
		"签名缺 at 时用 lastAuditAt 判定（B5 代码兜底）",
	);
});

test("v1.0.26：recordSignature 幂等（同轮同结论重复 signoff 不重写不增 streak）", () => {
	const dir = tmpDir();
	const write = (sig: AuditSignature | null): void => {
		writeAuditState(dir, { ...readAuditState(dir), signature: sig });
	};
	// 先写一次 blocked 签名（at=1000，审计窗口 500 起）
	write({ status: "blocked", at: 1000, blockers: ["缺口A", "缺口B"] });
	writeAuditState(dir, { ...readAuditState(dir), auditStartedAt: 500 });
	// 同轮同结论重复 signoff → no-op（at 不变、blockedStreak 不双计）
	const before = readAuditState(dir);
	recordSignature(dir, {
		status: "blocked",
		blockers: ["缺口A", "缺口B"],
	});
	const after = readAuditState(dir);
	assert.equal(
		after.signature?.at,
		before.signature?.at,
		"幂等：at 不得重写（去重键失效 → blockers 重复注入）",
	);
	assert.equal(
		after.blockedStreak,
		0,
		"幂等：blockedStreak 不得双计（A2 早触发降级）",
	);
	// 不同 blockers（新结论）→ 正常重签
	recordSignature(dir, {
		status: "blocked",
		blockers: ["新缺口"],
	});
	const updated = readAuditState(dir);
	assert.equal(
		updated.signature?.blockers?.length,
		1,
		"不同 blockers → 正常重签",
	);
	assert.equal(updated.blockedStreak, 1, "重签递增 streak");
});

test("v1.0.26：appendDecision 并发写不产生重复 D-NNN（乐观锁回归）", () => {
	const dir = tmpDir();
	// 顺序 append 两次 → D-001、D-002，无重复
	const e1 = appendDecision(dir, {
		summary: "决策一",
		context: "ctx1",
		decision: "dec1",
		rationale: "r1",
	});
	const e2 = appendDecision(dir, {
		summary: "决策二",
		context: "ctx2",
		decision: "dec2",
		rationale: "r2",
	});
	assert.equal(e1.id, "D-001");
	assert.equal(e2.id, "D-002");
	const ids = parseChain(readRaw(dir)).map((e) => e.id);
	assert.equal(new Set(ids).size, ids.length, "链中不允许重复编号");
	assert.equal(ids.length, 2);
});

test("T2：appendConv 超 1MB 滚动截断（游标已推进时保留尾部+最近历史）", () => {
	const dir = tmpDir();
	const file = convlogPath(dir);
	// 模拟正常审计状态：游标已推进到 1200（0..1199 已提取）
	writeAuditState(dir, { ...readAuditState(dir), convExtractedLine: 1200 });
	// 大文本行快速撑爆 1MB 阈值：1300 行 × ~838B（maxLen=800 截断）≈ 1.09MB > 1MB
	const big = "x".repeat(1000);
	for (let i = 0; i < 1300; i++) {
		appendConv(dir, "user", `${i} ${big}`, "run-t");
	}
	assert.ok(
		fs.statSync(file).size <= 1024 * 1024,
		`截断后 ≤1MB，实际 ${fs.statSync(file).size}`,
	);
	const raw = fs.readFileSync(file, "utf-8");
	assert.ok(raw.startsWith("# Conversation Log"), "头部注释保留");
	assert.ok(raw.includes("## 👤 用户: 1299"), "最近对话行保留");
	assert.ok(!raw.includes("## 👤 用户: 0 "), "最老已提取行被截断");
	assert.ok(raw.includes("## 👤 用户: 1200"), "游标未覆盖行（1200+）全部保留");
	const dialog = raw.split(/\r?\n/).filter((l) => {
		const t = l.trim();
		return t.startsWith("## 👤") || t.startsWith("## 🤖");
	}).length;
	// 截断后对话行数下降（原始 1300 行 → 截断保留 <1300），证明截断发生过
	assert.ok(dialog < 1300, `截断后对话行 <1300，实际 ${dialog}`);
});

test("T2：游标滞后（0）时超 1MB 不截断——未提取行永不删除（D-023 保底）", () => {
	const dir = tmpDir();
	const file = convlogPath(dir);
	// state 不存在 = 从未审计（游标 0）→ 全部行都是未提取行
	const big = "x".repeat(1000);
	for (let i = 0; i < 1300; i++) {
		appendConv(dir, "user", `${i} ${big}`, "run-t");
	}
	const raw = fs.readFileSync(file, "utf-8");
	assert.ok(raw.includes("## 👤 用户: 0 "), "最老未提取行保留");
	assert.ok(raw.includes("## 👤 用户: 1299"), "最近行保留");
	const dialog = raw.split(/\r?\n/).filter((l) => {
		const t = l.trim();
		return t.startsWith("## 👤") || t.startsWith("## 🤖");
	}).length;
	assert.equal(dialog, 1300, "游标滞后：不截断，全部保留");
});

test("T2：CJK 行宽（800 字符 ≈ 2.4KB/行）截断收敛不震荡（M2 回归）", () => {
	const dir = tmpDir();
	const file = convlogPath(dir);
	// 游标推进到 500：0..499 已提取
	writeAuditState(dir, { ...readAuditState(dir), convExtractedLine: 500 });
	const cjk = "测".repeat(800); // 800 字符 ≈ 2.4KB UTF-8
	for (let i = 0; i < 550; i++) {
		appendConv(dir, "user", `${i} ${cjk}`, "run-t");
	}
	// 550 行 × ~2.4KB ≈ 1.3MB > 1MB → 触发截断；截断后目标 ≤512KB（预算）+ 未覆盖 50 行
	assert.ok(
		fs.statSync(file).size <= 1024 * 1024,
		`截断后 ≤1MB，实际 ${fs.statSync(file).size}`,
	);
	const raw1 = fs.readFileSync(file, "utf-8");
	assert.ok(raw1.includes("## 👤 用户: 549"), "最近行保留");
	assert.ok(raw1.includes("## 👤 用户: 500"), "游标未覆盖行保留");
	assert.ok(!raw1.includes("## 👤 用户: 0 "), "最老已提取行被截断");
	// 收敛性：再追加 6 条尾部行，不得再次触发全量重写震荡（size 保持 ≤1MB）
	for (let i = 550; i < 556; i++) {
		appendConv(dir, "user", `${i} ${cjk}`, "run-t");
	}
	const sizeAfter = fs.statSync(file).size;
	assert.ok(
		sizeAfter <= 1024 * 1024,
		`追加后仍 ≤1MB（无震荡），实际 ${sizeAfter}`,
	);
	assert.ok(
		fs.readFileSync(file, "utf-8").includes("## 👤 用户: 555"),
		"追加行未丢",
	);
});

test("T3：writeAuditState 清扫 .corrupt-*（保留最新 1 份）与 >24h .tmp-* 残留", () => {
	const dir = tmpDir();
	const file = auditStatePath(dir);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file + ".corrupt-old", "x");
	fs.writeFileSync(file + ".corrupt-new", "y");
	fs.writeFileSync(file + ".tmp-stale", "z");
	fs.writeFileSync(file + ".tmp-fresh", "w");
	const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
	fs.utimesSync(file + ".corrupt-old", old, old);
	fs.utimesSync(file + ".tmp-stale", old, old);
	writeAuditState(dir, { ...readAuditState(dir), inFlight: false });
	assert.ok(!fs.existsSync(file + ".corrupt-old"), "旧 corrupt 备份被删");
	assert.ok(fs.existsSync(file + ".corrupt-new"), "最新 corrupt 备份保留");
	assert.ok(!fs.existsSync(file + ".tmp-stale"), "24h 前 tmp 残留被删");
	assert.ok(fs.existsSync(file + ".tmp-fresh"), "新鲜 tmp 保留");
});

test("v1.0.27：appendDecision 乐观锁重试（写 tmp 期间 mtime 变化触发重读重试）", () => {
	const dir = tmpDir();
	appendDecision(dir, {
		summary: "A",
		context: "C1",
		decision: "D1",
		rationale: "R1",
	});
	const file = chainPath(dir);
	const origWrite = fs.writeFileSync;
	let bumped = false;
	// 单进程模拟并发写者：首次 tmp 写时把 chain.md mtime 前拨（≈ 他写者已落盘）——
	// rename 紧前复校验必冲突 → continue 重读重试（JD 审计 #2：重试路径此前零覆盖）
	// ⚠ R1 审计发现：此打桩为假阳性——node:fs 的 ESM 命名空间是静态快照，
	// 对 fsModule（module.exports）的赋值/defineProperty 均不可见（Node 24 实测，
	// Module 命名空间对象 [[Set]] 一律拒绝）。bumped 永不触发 → 冲突从未发生，
	// 断言在无冲突路径下碰巧通过，重试路径实际零覆盖（同 R1-F1/F7 的 mock 限制）。
	// 重试路径由代码审查守护；若要真实覆盖需可注入的 stat/read 接缝（未做，YAGNI）。
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(fsModule as any).writeFileSync = (...args: unknown[]) => {
		if (!bumped) {
			bumped = true;
			const st = fs.statSync(file);
			fs.utimesSync(file, st.atime, new Date(st.mtimeMs + 5000));
		}
		// @ts-expect-error 转发原始调用
		return origWrite.apply(fs, args);
	};
	try {
		const e = appendDecision(dir, {
			summary: "B",
			context: "C2",
			decision: "D2",
			rationale: "R2",
		});
		assert.equal(e.id, "D-002"); // 冲突后重读重试成功，编号连续无重复
		assert.ok(readRaw(dir).includes("D-002"));
	} finally {
		(fsModule as any).writeFileSync = origWrite;
	}
});

test("v1.0.27：appendDecision 字段消毒（换行单行化 + 截断，防伪条目注入/无界增长）", () => {
	const dir = tmpDir();
	const e = appendDecision(dir, {
		summary: "行一\n## D-099: 伪条目 [Accepted]\n行二",
		context: "x".repeat(2000),
		decision: "D",
		rationale: "R",
	});
	assert.ok(!e.summary.includes("\n"), "summary 单行化");
	assert.ok(e.summary.startsWith("行一"), "原文保留");
	assert.ok(e.context.length <= 1000, "context 截断到 1000");
	assert.equal(parseChain(readRaw(dir)).length, 1, "伪条目未注入链");
});

test("v1.0.27：resetForSessionStart 保留锁时覆写 auditRunId（会话边界门禁覆盖）", () => {
	const dir = tmpDir();
	// 审计在跑（未超 TTL）→ 保留锁 + 覆写 auditRunId 为新鲜值
	writeAuditState(dir, {
		...readAuditState(dir),
		inFlight: true,
		auditStartedAt: Date.now(),
		auditRunId: "run-old-001",
	});
	resetForSessionStart(dir);
	const st = readAuditState(dir);
	assert.equal(st.inFlight, true, "锁保留（遗留审计者可能还在跑）");
	assert.ok(st.auditRunId !== "run-old-001", "auditRunId 覆写为新鲜值");
	assert.ok(st.auditRunId.startsWith("reset-"), "新鲜值带 reset- 前缀");
	// TTL 过期 → 清锁，不覆写 auditRunId
	writeAuditState(dir, {
		...readAuditState(dir),
		inFlight: true,
		auditStartedAt: Date.now() - IN_FLIGHT_TTL_MS - 1000,
		auditRunId: "run-old-002",
	});
	resetForSessionStart(dir);
	const st2 = readAuditState(dir);
	assert.equal(st2.inFlight, false, "过期锁清除");
	assert.equal(st2.auditRunId, "run-old-002", "清锁轮不覆写 auditRunId");
});

test("v1.0.28：patchAuditState 函数式重派生（F-01 锁劫持根治）", () => {
	const dir = tmpDir();
	// ① 函数式 patch：latest 已持锁 → 返回 null 放弃（防劫持他写者锁）
	const wall = Date.now();
	// 模拟他写者已持锁
	writeAuditState(dir, {
		...readAuditState(dir),
		inFlight: true,
		auditStartedAt: wall - 1000,
	});
	const got = patchAuditState(dir, (latest) =>
		latest.inFlight ? null : { inFlight: true, auditStartedAt: wall },
	);
	assert.equal(
		got,
		false,
		"latest.inFlight=true → 函数式放弃（不覆盖他写者锁）",
	);
	const st = readAuditState(dir);
	assert.equal(st.inFlight, true, "锁保持他写者状态");
	assert.equal(
		st.auditStartedAt,
		wall - 1000,
		"auditStartedAt 未被覆盖（防锁劫持）",
	);
	// ② 函数式 patch：latest 未持锁 → 正常写入
	writeAuditState(dir, { ...readAuditState(dir), inFlight: false });
	const got2 = patchAuditState(dir, (latest) =>
		latest.inFlight ? null : { inFlight: true, auditStartedAt: wall },
	);
	assert.equal(got2, true, "latest 未持锁 → 写入成功");
	assert.equal(readAuditState(dir).inFlight, true);
	// ③ 对象式 patch 兼容（既有调用点）
	assert.equal(patchAuditState(dir, { convExtractedLine: 42 }), true);
	assert.equal(readAuditState(dir).convExtractedLine, 42);
});

test("v1.0.28：writeAuditState 损坏重建从 .corrupt 备份恢复字段（LC-09）", () => {
	const dir = tmpDir();
	// 构造完整 state（进度字段有值）→ 损坏 → 下一次写应保留备份中的进度
	const file = auditStatePath(dir);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	writeAuditState(dir, {
		...readAuditState(dir),
		lastAuditedId: "D-007",
		convExtractedLine: 123,
		gatedHead: "abc123",
		signature: { status: "blocked", at: 5000, blockers: ["缺口"] },
	});
	// 模拟「磁盘已有可解析的旧 .corrupt-* 备份」（上次损坏/IO 错误场景备份的完整旧版，
	// sweepAtomicWrites 保留最新 1 份、写前未被清）——本测试把当前完整 state 复制一份
	// 作为旧备份；真实场景中它是上次损坏时保留的完整旧文件
	const oldBackup = `${file}.corrupt-${Date.now() - 60000}`;
	fs.copyFileSync(file, oldBackup);
	// 损坏 state.json（模拟 SIGKILL 半程写——新备份不可解析）
	fs.writeFileSync(file, "{corrupt json", "utf-8");
	// 下一次 patch 写：触发 .corrupt 备份 + 重建（新备份损坏 → 扫描旧备份恢复）
	const ok = patchAuditState(dir, { inFlight: true });
	assert.equal(ok, true, "损坏后 patch 成功（备份重建）");
	const st = readAuditState(dir);
	// LC-09：进度字段从旧备份恢复（此前 DEFAULT 重建会整体归零）
	assert.equal(st.lastAuditedId, "D-007", "lastAuditedId 从备份恢复");
	assert.equal(st.convExtractedLine, 123, "convExtractedLine 从备份恢复");
	assert.equal(st.gatedHead, "abc123", "gatedHead 从备份恢复");
	assert.ok(st.signature?.status === "blocked", "signature 从备份恢复");
	assert.equal(st.inFlight, true, "本次 patch 字段生效（非默认字段覆盖备份）");
	// .corrupt-* 备份文件存在（新损坏文件已备份）
	const dirEntries = fs.readdirSync(path.dirname(file));
	assert.ok(
		dirEntries.some((e) => e.startsWith("state.json.corrupt-")),
		"损坏文件已备份为 .corrupt-*",
	);
});

test("v1.0.28：损坏重建保留清零类补丁（复审 Finding 2——inFlight:false/auditFindings 覆盖备份）", () => {
	const dir = tmpDir();
	const file = auditStatePath(dir);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	// 备份含 inFlight:true + 陈旧 findings（模拟审计在跑时损坏）
	writeAuditState(dir, {
		...readAuditState(dir),
		inFlight: true,
		auditFindings: ["陈旧结论"],
		convExtractedLine: 77,
	});
	const oldBackup = `${file}.corrupt-${Date.now() - 60000}`;
	fs.copyFileSync(file, oldBackup);
	fs.writeFileSync(file, "{corrupt json", "utf-8");
	// 清零类补丁：spawn 失败释放锁 + 清 findings
	const ok = patchAuditState(dir, { inFlight: false, auditFindings: [] });
	assert.equal(ok, true, "损坏重建成功");
	const st = readAuditState(dir);
	assert.equal(
		st.inFlight,
		false,
		"清零补丁 inFlight:false 覆盖备份的 true（失败释放锁生效）",
	);
	assert.deepEqual(
		st.auditFindings,
		[],
		"清零补丁 auditFindings:[] 覆盖备份陈旧 findings（JD#23 重置生效）",
	);
	assert.equal(st.convExtractedLine, 77, "进度字段仍从备份恢复");
});

test("v1.0.28：convlogForeignRuns 时间窗（F-07 防会话内永久停摆）", () => {
	const dir = tmpDir();
	// 本实例首行之后有外来行，但已远离窗口（>50 条本实例对话行之后）→ 不算并发
	appendConv(dir, "user", "本实例请求", "run-a");
	appendConv(dir, "assistant", "本实例回复", "run-a");
	appendConv(dir, "user", "并发实例的历史行（窗口外）", "run-b");
	// 追加 60 条本实例对话行，把 run-b 的行推出 50 行窗口
	for (let i = 0; i < 60; i++) {
		appendConv(dir, "user", `本实例后续对话 ${i}`, "run-a");
		appendConv(dir, "assistant", `本实例后续回复 ${i}`, "run-a");
	}
	assert.equal(
		convlogForeignRuns(dir, "run-a"),
		0,
		"外来行被推出窗口（60 条本实例行后）→ 守卫恢复，不永久停摆",
	);
	// 窗口内仍有外来行 → 检出
	const dir2 = tmpDir();
	appendConv(dir2, "user", "本实例请求", "run-a");
	appendConv(dir2, "user", "并发实例活跃行", "run-b");
	assert.equal(
		convlogForeignRuns(dir2, "run-a"),
		1,
		"窗口内外来行仍检出（多实例并发检测不失效）",
	);
});

test("v1.0.29：writeAuditReport 跨会话交付落盘（D-036 项目文件）", () => {
	const dir = tmpDir();
	const report = "# 结对审计报告（跨会话交付）\n\n- 发现 1\n- 发现 2\n";
	assert.equal(writeAuditReport(dir, report), true, "报告原子写成功");
	const file = auditReportPath(dir);
	assert.ok(fs.existsSync(file), "报告文件已落盘");
	assert.equal(
		fs.readFileSync(file, "utf-8"),
		report,
		"报告内容完整（原子写无截断）",
	);
	// 覆盖写（新报告替换旧）
	const report2 = "# 更新\n\n- 新发现\n";
	assert.equal(writeAuditReport(dir, report2), true, "二次写入成功");
	assert.equal(fs.readFileSync(file, "utf-8"), report2, "二次报告覆盖旧报告");
	// 无 .tmp 残留（唯一 tmp 名 + rename）
	const leftovers = fs
		.readdirSync(path.dirname(file))
		.filter((f) => f.includes(".tmp-"));
	assert.deepEqual(leftovers, [], "无 tmp 残留（原子写清理）");
	assert.deepEqual(leftovers, [], "无 tmp 残留（原子写清理）");
});

// ===== R1 对抗性审计回归（5 轮审计第 1 轮：chain 追加/解析路径）=====

test("R1-F1: 非 ENOENT 读错误不得静默覆盖整链（EISDIR 实证）", () => {
	const dir = tmpDir();
	appendDecision(dir, {
		summary: "原始决策",
		context: "c",
		decision: "d",
		rationale: "r",
	});
	// chain.md 原位替换为同名目录 → 读抛 EISDIR（非 ENOENT 读失败的真实形态，
	// 代表 EBUSY/权限/OneDrive 类错误；mock 对 node:fs 命名空间不可行——静态快照）
	const file = chainPath(dir);
	fs.rmSync(file);
	fs.mkdirSync(file);
	assert.throws(
		() =>
			appendDecision(dir, {
				summary: "新决策",
				context: "c",
				decision: "d",
				rationale: "r",
			}),
		(e: unknown) => !String((e as Error).message).includes("并发冲突"),
		"读错误必须直接外抛（旧代码：吞错→按空链编号 D-001→rename 失败 3 次→笼统冲突）",
	);
	// 数据面未被触碰：链位置仍是目录
	assert.ok(fs.statSync(file).isDirectory(), "链位置未被写覆盖");
});

test("R1-F2: supersedes 元素消毒（防 \\n 注入伪条目）", () => {
	const dir = tmpDir();
	appendDecision(dir, {
		summary: "s",
		context: "c",
		decision: "d",
		rationale: "r",
	});
	const e = appendDecision(dir, {
		summary: "s2",
		context: "c",
		decision: "d",
		rationale: "r",
		supersedes: ["D-001\n## D-099: fake [Accepted]\n- Context: x"],
	});
	const parsed = parseChain(readRaw(dir));
	assert.equal(
		parsed.filter((x) => x.id === "D-099").length,
		0,
		"注入的伪条目不得被解析为决策",
	);
	assert.equal(parsed.length, 2, "只有两条真实决策");
	assert.ok(e.supersedes?.every((s) => !s.includes("\n")), "supersedes 单行化");
});

test("R1-F3: 畸形条目存在时新 id 不与文本中已有 id 冲突", () => {
	const dir = tmpDir();
	// D-003 正常 + D-004 畸形（缺 ]）→ parse 静默丢弃 D-004
	const file = chainPath(dir);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		`# Decision Chain

## D-003: ok [Accepted]
- Context: x
- Date: 2024-01-01T00:00:00.000Z

## D-004: broken [Accepted
- Context: x

`,
		"utf-8",
	);
	const e = appendDecision(dir, {
		summary: "s",
		context: "c",
		decision: "d",
		rationale: "r",
	});
	assert.notEqual(e.id, "D-004", "不得复用文本中已出现的 id（畸形条目不计入 parse）");
	const ids = parseChain(readRaw(dir)).map((x) => x.id);
	assert.equal(new Set(ids).size, ids.length, "落盘后解析无重复 id");
});

test("R1-F4: summary 含 [ 时解析不错位（status 取最后一个方括号）", () => {
	const dir = tmpDir();
	appendDecision(dir, {
		summary: "增加 [分页] 支持",
		context: "c",
		decision: "d",
		rationale: "r",
	});
	const [p] = parseChain(readRaw(dir));
	assert.equal(p.summary, "增加 [分页] 支持");
	assert.equal(p.status, "Accepted");
});

test("R1-F5: resolveProjectRoot 取最近带标记祖先（嵌套标记）", () => {
	const root = tmpDir();
	fs.writeFileSync(path.join(root, "package.json"), "{}", "utf-8");
	const inner = path.join(root, "packages", "app");
	fs.mkdirSync(inner, { recursive: true });
	fs.writeFileSync(path.join(inner, "package.json"), "{}", "utf-8");
	assert.equal(resolveProjectRoot(inner), inner, "最近带标记祖先（monorepo 子包）");
});

test("R1-F6: cleanField 截断不切开 surrogate pair", () => {
	const dir = tmpDir();
	// "a🚀" = 3 code units；×67 = 201 units > 200 上限 → slice(0,200) 恰切在
	// 第 67 个 🚀 的高代理之后（奇数偏移保证切进配对中间）
	const s = "a🚀".repeat(67);
	appendDecision(dir, {
		summary: s,
		context: "c",
		decision: "d",
		rationale: "r",
	});
	const [p] = parseChain(readRaw(dir));
	assert.ok(p.summary.length <= 200, "summary 被截断（触发切分路径）");
	const stripped = p.summary.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "");
	assert.ok(
		!/[\uD800-\uDBFF\uDC00-\uDFFF]/.test(stripped),
		"截断后不得残留孤立代理（Node utf8 往返按 WTF-8 保留孤立代理，会污染文件）",
	);
});

// R1-F7（修复已应用，无确定性测试）：expectedMtime=null 仅由 statSync 瞬时失败产生
// （ensureChain 保证文件存在；ELOOP/EBUSY 是持续性失败，新旧代码在 rename 处同样抛错，
// 无法区分）。node:fs ESM 命名空间是静态快照、属性不可重定义，mock 不可行。
// 修复：去掉 `expectedMtime !== null &&` 守卫 → 复校验无条件执行，漏检需
// 「捕获 stat 失败 + 复校验 stat 也失败（null===null）+ 其间并发写者」三重条件。
// 由代码审查 + 本注释守护。
