/**
 * Skill Tools Injector — injects a static `<skill_tools>` block describing
 * cloud-skill operations as curl recipes.
 *
 * Why static: the LLM does NOT see these as native tools (we don't push to
 * `body.tools` — the agent host wouldn't know how to handle them). Instead
 * the LLM uses its existing Bash tool to curl `<proxy_base>/skill-bridge/...`,
 * which the proxy's `/skill-bridge/*` reverse proxy then forwards to core
 * with auth + IdFields injected from the session.
 *
 * The block is rendered once per session (at session_init prewarm) — its
 * content depends only on the proxy base URL, which is stable for the
 * session.
 *
 * Tools injected:
 *   Always (read-only): skill_search, skill_view, skill_files_read,
 *                       skill_extract
 *   Only when allowLlmWrite=true: skill_create, skill_update, skill_patch,
 *                                skill_delete, skill_files_write, skill_files_remove
 *
 * Note: skill_list is intentionally omitted — the <available_skills> block
 * already provides the agent's owned skill catalogue at session init.
 *
 * Sister hook: `skill-injector.ts` produces the dynamic `<available_skills>`
 * block (agent-owned skill listing from /v3/skill/listing).
 *
 * See `docs/design/2026-06-17-team-skill-proxy-runtime.md` §4.
 */

import type {
  AgentContext,
  AnchorTarget,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
  PrewarmInput,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";

export interface SkillToolsInjectorConfig {
  /**
   * Base URL the LLM should curl. Filled into every `<tool>` recipe.
   * E.g. `http://127.0.0.1:8096`. Trailing slash trimmed.
   */
  proxyBaseUrl: string;
  /**
   * Whether the main model may create/update skills. Defaults to false.
   * When false, only read-only tools are injected (search/list/view/files_read).
   * When explicitly set to true, all 10 tools are injected.
   */
  allowLlmWrite?: boolean;
}

/**
 * Render the entire `<skill_tools>` block as a single text string. Pure
 * function for ease of testing.
 */
export function renderSkillToolsBlock(
  proxyBaseUrl: string,
  allowLlmWrite = true,
  sessionId?: string,
  spaceId?: string,
): string {
  const base = proxyBaseUrl.replace(/\/$/, "");
  const bridge = `${base}/skill-bridge/v3/skill`;

  // The gateway requires `x-tdai-service-id: <spaceId>`; `x-conversation-id`
  // lets the proxy reuse the session identity (user_id / team_id / agent_id).
  const sessionHeader = sessionId
    ? ` -H 'x-conversation-id: ${sessionId}'`
    : "";
  const tenantHeader = spaceId ? ` -H 'x-tdai-service-id: ${spaceId}'` : "";
  const authHeader = `${tenantHeader}${sessionHeader}`;

  const readTools = [
    `  <tool name="skill_search">`,
    `    path: ${bridge}/search`,
    `    body: {"query": "keywords describing the skill you are looking for (required, >=1 character)"}`,
    `    use:  Search by keywords and semantics among skills you can access in the team (across agents, but **excluding** skills marked private by others, matching the frontend "Team Assets" tab). query must be a non-empty string; 2-5 related keywords are recommended. Use this to discover other available team skills when your built-in skills are insufficient. The server fixes the result count; retry with different keywords if results are not useful. Do not add fields such as top_k/mode to the body; they are ignored.`,
    `  </tool>`,
    "",
    // Temporarily disabled: the <available_skills> block already injects the agent's built-in skill list, so this overlaps.
    // Restore it later if paginated refresh is needed when the skill list is truncated.
    // `  <tool name="skill_list">`,
    // `    path: ${bridge}/list`,
    // `    body: {"filters": {"owner_agent_id": "?optional", "name_prefix": "?optional"}, "pagination": {"limit": 50}}`,
    // `    use:  List head + active skills; filter by owner / prefix`,
    // `  </tool>`,
    // "",
    `  <tool name="skill_view">`,
    `    path: ${bridge}/get-by-name`,
    `    body: {"skill_name": "<skill name>", "include_content": true, "include_manifest": true}`,
    `    use:  **Open a skill entry point**: get the full SKILL.md content and resource tree (manifest). To read a resource file, first use this tool to choose its path from the manifest, then use skill_files_read. Use the name from <available_skills> in the format \`- name: description\`, or the name field returned by skill_search.`,
    `  </tool>`,
    "",
    `  <tool name="skill_files_read">`,
    `    path: ${bridge}/files/read`,
    `    body: {"skill_id": "skl-xxx", "path": "scripts/run.sh", "encoding": "utf-8|base64"}`,
    `    use:  Read one resource file. **You must call skill_view first to obtain the manifest**, then choose the skill_id + path; otherwise this tool cannot locate the file. Returns a JSON envelope by default (containing base64/utf-8 encoded bytes).\n    To download locally, append -o <local path> to curl; the proxy returns raw bytes directly without adding them to the context. Run chmod +x on downloaded scripts before executing them.`,
    `  </tool>`,
    "",
    `  <tool name="skill_extract">`,
    `    path: ${bridge}/extract`,
    `    body: {"reason": "?optional, briefly explain why this conversation is worth extracting as a skill (clear boundaries help the background extractor)"}`,
    `    use:  Archive the current conversation and trigger skill extraction immediately (an asynchronous task where a background agent analyzes the conversation and generates a skill). The proxy gets identity from the session and uses the accumulated conversation buffer on the core side, so you do not need to send messages. Use this after the user completes a workflow that is worth reusing.`,
    `  </tool>`,
  ];

  const writeTools = [
    `  <tool name="skill_create">`,
    `    path: ${bridge}/create`,
    `    body: {"name": "string", "content": "full SKILL.md content (including frontmatter)", "resources": "?optional array"}`,
    `    use:  Create a skill; the owner is automatically set to the current agent`,
    `  </tool>`,
    "",
    `  <tool name="skill_update">`,
    `    path: ${bridge}/update`,
    `    body: {"skill_id": "skl-xxx", "content": "new SKILL.md"}`,
    `    use:  Replace SKILL.md (version+1)`,
    `  </tool>`,
    "",
    `  <tool name="skill_patch">`,
    `    path: ${bridge}/patch`,
    `    body: {"skill_id": "skl-xxx", "old_string": "...", "new_string": "...", "replace_all": false}`,
    `    use:  Replace a substring in SKILL.md (avoids a large diff)`,
    `  </tool>`,
    "",
    `  <tool name="skill_delete">`,
    `    path: ${bridge}/delete`,
    `    body: {"skill_id": "skl-xxx"}`,
    `    use:  Soft-delete (archived; does not increment the version)`,
    `  </tool>`,
    "",
    `  <tool name="skill_files_write">`,
    `    path: ${bridge}/files/write`,
    `    body: {"skill_id": "skl-xxx", "files": [{"path": "scripts/x.sh", "content": "...", "encoding": "utf-8", "is_executable": true}]}`,
    `    use:  Add or update resource files (version+1)`,
    `  </tool>`,
    "",
    `  <tool name="skill_files_remove">`,
    `    path: ${bridge}/files/remove`,
    `    body: {"skill_id": "skl-xxx", "paths": ["scripts/old.sh"]}`,
    `    use:  Remove resource files (version+1)`,
    `  </tool>`,
  ];

  const note = allowLlmWrite
    ? "Error handling: responses use the `{code, message, request_id, data?}` envelope; `code != 0` indicates a business error. Common errors:"
    : "Note: only read-only operations are currently enabled. Contact an administrator to create or modify skills.\nError handling: responses use the `{code, message, request_id, data?}` envelope; `code != 0` indicates a business error. Common errors:";

  const readErrors = [
    "- 40001 Validation failed: a body field is missing or has an invalid format; check message for the specific field.",
    "- 40101 session not initialized: the session was not recognized (you may be using this tool in the wrong conversation context).",
    "- 40401 SKILL_NOT_FOUND: the skill does not exist or does not belong to your agent; use skill_search to find a similar skill first.",
    "- 50301 upstream unavailable: the core service is temporarily unreachable; retry later.",
  ];
  const writeErrors = [
    "- 40301 SKILL_NOT_OWNER: you are not the owner and cannot modify the skill.",
    "- 40901 SKILL_VERSION_STALE: the version is stale; call skill_view to get the latest version before writing.",
    "- 42201 SKILL_NAME_DUPLICATE: a skill with the same name already exists in the team.",
    "- 42202 SKILL_PATCH_NOT_UNIQUE: old_string is not unique; pass replace_all=true.",
  ];

  return [
    "<skill_tools>",
    "The following are cloud skill operation tools. **These are not local tools**; use Bash and curl to call the proxy's skill-bridge paths.",
    "The proxy automatically injects identity and authentication (user_id / team_id / agent_id determined by the session); provide only business fields in the body.",
    "",
    "Call template:",
    `  curl -sSk -X POST <bridge>/<action> -H 'content-type: application/json'${authHeader} -d '{...business fields...}'`,
    `  where <bridge> = ${bridge}`,
    "",
    "Available tools:",
    "",
    ...readTools,
    ...(allowLlmWrite ? [""] : []),
    ...(allowLlmWrite ? writeTools : []),
    "",
    note,
    ...readErrors,
    ...(allowLlmWrite ? writeErrors : []),
    "</skill_tools>",
  ].join("\n");
}

/**
 * Skill tools injector.
 *
 * Anchor: lands BEFORE the `skills` slot (CodeBuddy: `<agent_skills>`),
 * priority just before SkillInjector so `<skill_tools>` reads naturally
 * before `<cloud_skills>`.
 */
export class SkillToolsInjector implements InjectionHook {
  id = "skill-tools-injector";
  point = "system.before_tools" as const;
  /** Place ahead of `<available_skills>` (which uses slot=skills, before). */
  anchor: AnchorTarget = { slot: "skills", relation: "before" };
  /** Slightly higher priority than SkillInjector so this block precedes it. */
  priority: HookPriority = HOOK_PRIORITY.SKILL - 1;
  description = "Inject the static <skill_tools> curl-recipe block.";
  /** Block content depends only on proxy base URL — fully session-static. */
  cacheStrategy: CacheStrategy = "session_init";

  constructor(private config: SkillToolsInjectorConfig) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const caps = ctx.metadata.custom?.assetCapabilities as
      | { skill?: boolean }
      | undefined;
    if (caps?.skill === false) return [];
    return this.renderBlocks(ctx);
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    if (input.assetCapabilities?.skill === false) return [];
    return this.renderBlocks(
      undefined,
      input.sessionInfo.session_id,
      input.sessionInfo.space_id,
    );
  }

  private renderBlocks(
    ctx?: AgentContext,
    prewarmSessionId?: string,
    prewarmSpaceId?: string,
  ): ContextBlock[] {
    const allowLlmWrite = this.config.allowLlmWrite ?? false;

    let sessionId = prewarmSessionId;
    let spaceId = prewarmSpaceId;
    if (ctx) {
      const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
      const session = custom?.session as Record<string, unknown> | undefined;
      const sid = session?.session_id;
      if (typeof sid === "string" && sid.length > 0) {
        sessionId = sid;
      }
      const sp = session?.space_id;
      if (typeof sp === "string" && sp.length > 0) {
        spaceId = sp;
      }
    }

    const content = renderSkillToolsBlock(
      this.config.proxyBaseUrl,
      allowLlmWrite,
      sessionId,
      spaceId,
    );
    return [
      {
        type: "text",
        content,
        metadata: {
          source: this.id,
          // Stable cache-dedup key — varies by allowLlmWrite to avoid stale cache
          cacheKey: `skill-tools-injector:catalog:${allowLlmWrite ? "rw" : "ro"}`,
        },
      },
    ];
  }
}
