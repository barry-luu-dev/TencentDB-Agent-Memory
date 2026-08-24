/**
 * Claude Code Session Init Form — `AskUserQuestion` tool_use.
 *
 * Claude Code 原生交互 form：
 *   - Tool name: `AskUserQuestion`
 *   - Options: `{ label, description }` 结构体，2-4 个硬限制
 *   - Protocol: 仅 Anthropic SSE
 *   - ID prefix: `toolu_cc_session_init_`
 *   - 分页: 每页 3 个 agent + 1 个"更多→"/SKIP 槽位
 *
 * 不含任何 CodeBuddy 逻辑。
 */

import type { TeamOption } from "../types.js";
import {
  computePagination,
  CC_MAX_OPTIONS as CC_MAX_OPTIONS_SHARED,
} from "./pagination.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const TOOL_NAME = "AskUserQuestion";
export const TOOLCALL_PREFIX = "toolu_cc_session_init_";

export const TEAM_FORM_TITLE = "Session Init — Select Team";
export const AGENT_TASK_FORM_TITLE = "Session Init — Select Agent & Task";
export const RETRY_FORM_TITLE = "Selection not recognized, please try again";

export const SKIP_LABEL = "Skip (no injection, pass through)";
export const MORE_LABEL = "More →";

export const ASSET_CONFIRM_YES = "Yes, link team assets";
export const ASSET_CONFIRM_NO = "No, skip this time";
export const ASSET_CONFIRM_FORM_TITLE = "Session Init — Link team assets?";

const SESSION_INIT_THINKING_PLACEHOLDER = "[proxy session-init form]";

/**
 * 附在每步 question 文末的通用备注：告诉用户"选择跳过 = 本次 session init 跳过、不注入任何团队资产"。
 * Claude Code 的 AskUserQuestion 会给用户一个 "Other" 输入框，回复"跳过 / skip /
 * 不关联" 就走 SKIP_RE bypass；没识别到的自由文本会 unrecognized → 同样 bypass。
 * 文案与 workbuddy/codex/codebuddy/dsh 五端统一，避免多客户端表述漂移。
 */
const SKIP_HINT =
  '(Select "Skip" to bypass session init — no team assets will be injected)';

// 分页布局统一走 pagination.ts；此处仅用其常量。
const CC_MAX_OPTIONS = CC_MAX_OPTIONS_SHARED;

/** Returns true if the given string contains any CC form title marker. */
export function containsFormTitle(s: string): boolean {
  return (
    s.includes(TEAM_FORM_TITLE) ||
    s.includes(AGENT_TASK_FORM_TITLE) ||
    s.includes(RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/** Returns true if a tool_use id belongs to a CC session-init form. */
export function isSessionInitToolCallId(id: string): boolean {
  return id.startsWith(TOOLCALL_PREFIX);
}

// ── Form Data ──────────────────────────────────────────────────────────────────

export type FormStage =
  | "asset_confirm"
  | "team"
  | "agent_select"
  | "agent_task"
  | "task_select";

export interface FormData {
  teams: TeamOption[];
  stage: FormStage;
  selectedTeamId?: string;
  /** Claude Code 分页：当前 agent 页码 (0-based) */
  pageIndex?: number;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
}

// ── Claude Code AskUserQuestion input schema ───────────────────────────────────

interface CCAskQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

function buildAskUserQuestionArgs(data: FormData): {
  questions: CCAskQuestion[];
} {
  const { teams, stage, selectedTeamId, retry } = data;
  const titlePrefix = retry ? "⚠️ " : "";
  const questions: CCAskQuestion[] = [];

  if (stage === "asset_confirm") {
    questions.push({
      question: titlePrefix + "Link team assets for this session?" + SKIP_HINT,
      header: "Link Assets",
      options: [
        {
          label: ASSET_CONFIRM_YES,
          description: "Select Team / Agent / Task, inject team context",
        },
        {
          label: ASSET_CONFIRM_NO,
          description: "Skip injection, pass through directly",
        },
      ],
      multiSelect: false,
    });
    return { questions };
  }

  if (stage === "team") {
    // Team options: 只列真实 team。主动"跳过"入口只在 asset_confirm 阶段，后续
    // 阶段"异常/未识别"由 init.ts 兜底 bypass。
    //
    // 调用方（init.ts）保证 teams.length ≥ 2 — 单 team 会被 auto-select 跳过，
    // 根本不会走到 team form。form builder 不再兜底占位。
    // description 留空 —— label 已含 team 名 + id 后缀，重复一遍 "Team: name"
    // 只是噪音。
    // Team 阶段目前不分页 —— 最多渲染 CC_MAX_OPTIONS 个 team（超过的静默截断，
    // 属于 pre-existing 限制，本次未处理）。
    const teamOpts = teams.slice(0, CC_MAX_OPTIONS).map((t) => ({
      label: `${t.team_name} (${t.team_id.slice(-8)})`,
      description: "",
    }));
    if (teamOpts.length < 2) {
      throw new Error(
        `[cc form] team stage requires ≥2 teams (got ${teamOpts.length}). ` +
          `Caller must auto-select when teams.length === 1.`,
      );
    }
    questions.push({
      question: titlePrefix + "Select the Team for this session:" + SKIP_HINT,
      header: "Team",
      options: teamOpts.slice(0, CC_MAX_OPTIONS),
      multiSelect: false,
    });
    return { questions };
  }

  // stage === "agent_select" or "agent_task" (agent_task = no SKIP on last page)
  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { questions };

  if (stage === "agent_select" || stage === "agent_task") {
    const pageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.agents.length, pageIndex);
    const slice = team.agents.slice(page.start, page.end);

    // Only keep the agent's own description (if informative). Agent descriptions
    // without custom text are left empty — the label already has the name.
    const combinedOptions: Array<{ label: string; description: string }> =
      slice.map((a) => ({
        label: `${a.agent_name} (${a.agent_id.slice(-8)})`,
        description: a.description ?? "",
      }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      combinedOptions.push({
        label: MORE_LABEL,
        description: `View next page (${remaining} agents remaining)`,
      });
    }
    // The last page no longer appends SKIP: explicit skip is only offered at
    // asset_confirm; later-stage "unrecognized" is handled by init.ts bypass.
    //
    // pagination.ts guarantees ≥ 2 real items per page (total > 4 → paginated;
    // total ≤ 4 → single page with all 4 slots filled, no MORE); we should
    // never receive < 2 combinedOptions here.
    if (combinedOptions.length < 2) {
      throw new Error(
        `[cc form] agent page ${pageIndex} has ${combinedOptions.length} option(s); ` +
          `pagination.ts should have avoided a solo last page.`,
      );
    }

    const pageSuffix =
      page.totalPages > 1 ? ` (Page ${pageIndex + 1}/${page.totalPages})` : "";
    questions.push({
      question:
        titlePrefix +
        `Select an Agent for "${team.team_name}"${pageSuffix}:` +
        SKIP_HINT,
      header:
        page.totalPages > 1
          ? `Agent ${pageIndex + 1}/${page.totalPages}`.slice(0, 12)
          : "Agent",
      options: combinedOptions.slice(0, CC_MAX_OPTIONS),
      multiSelect: false,
    });
    return { questions };
  }

  // stage === "task_select"
  if (!team) return { questions };

  if (stage === "task_select") {
    const taskPageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.tasks.length, taskPageIndex);
    const taskSlice = team.tasks.slice(page.start, page.end);

    // description left empty — label already has task name + id suffix.
    // Default placeholder entries (isDefault) omit the id suffix since there's only one.
    const taskOpts: Array<{ label: string; description: string }> =
      taskSlice.map((t) => ({
        label: t.isDefault
          ? t.task_name
          : `${t.task_name} (${t.task_id.slice(-8)})`,
        description: "",
      }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      taskOpts.push({
        label: MORE_LABEL,
        description: `View next page (${remaining} tasks remaining)`,
      });
    }

    // Same as agent stage: pagination.ts guarantees count ≥ 2.
    if (taskOpts.length < 2) {
      throw new Error(
        `[cc form] task page ${taskPageIndex} has ${taskOpts.length} option(s); ` +
          `pagination.ts should have avoided a solo last page.`,
      );
    }

    const taskPageSuffix =
      page.totalPages > 1
        ? ` (Page ${taskPageIndex + 1}/${page.totalPages})`
        : "";
    questions.push({
      question:
        titlePrefix +
        `Select a task for "${team.team_name}"${taskPageSuffix}:` +
        SKIP_HINT,
      header:
        page.totalPages > 1
          ? `Task ${taskPageIndex + 1}/${page.totalPages}`.slice(0, 12)
          : "Task",
      options: taskOpts.slice(0, CC_MAX_OPTIONS),
      multiSelect: false,
    });

    return { questions };
  }

  return { questions };
}

// ── Form Builder ───────────────────────────────────────────────────────────────

/**
 * Build a Claude Code `AskUserQuestion` fake form response.
 * Always Anthropic SSE streaming (Claude Code only speaks Anthropic).
 */
export function buildFormResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const msgId = "msg_cc_session_init_" + Date.now();
  const toolUseId = TOOLCALL_PREFIX + Date.now();
  const input = buildAskUserQuestionArgs(data);
  const inputJson = JSON.stringify(input);

  const encoder = new TextEncoder();
  const sse = (event: string, d: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(d)}\n\n`);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        sse("message_start", {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );

      // thinking 必须在 tool_use 之前。DeepSeek thinking 模式在 tool-call 后
      // 要求回传 content[].thinking（#990）；无 thinking 的假表单会让下一轮 400。
      controller.enqueue(
        sse("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        }),
      );
      controller.enqueue(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: SESSION_INIT_THINKING_PLACEHOLDER,
          },
        }),
      );
      controller.enqueue(
        sse("content_block_stop", { type: "content_block_stop", index: 0 }),
      );

      controller.enqueue(
        sse("content_block_start", {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: toolUseId,
            name: TOOL_NAME,
            input: {},
          },
        }),
      );

      controller.enqueue(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: inputJson },
        }),
      );

      controller.enqueue(
        sse("content_block_stop", { type: "content_block_stop", index: 1 }),
      );

      controller.enqueue(
        sse("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 0 },
        }),
      );

      controller.enqueue(sse("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
