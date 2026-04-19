# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository nature

This repo is a **source-only archive** of Anthropic's Claude Code CLI, recovered from a sourcemap leak (see [README.md](README.md)). There is **no `package.json`, lockfile, tsconfig, or build configuration** committed — the README's `npm install` / `npm run build` / MCP commands cannot be executed against this tree as-is. Treat the source as read-only material for study and reference; running, building, linting, or testing requires reconstructing the build environment yourself (the original is a Bun-bundled TypeScript/React-Ink app).

There are no Cursor/Copilot rule files and no pre-existing CLAUDE.md to merge with.

## Build-time conditionals (important when reading code)

Two mechanisms gate code paths at bundle time. Both rely on the bundler constant-folding and dead-code-eliminating branches — at runtime the checks look like normal JS but in the shipped artifact one branch is gone:

- **`feature('FLAG_NAME')` from `bun:bundle`** — see usages in [src/QueryEngine.ts](src/QueryEngine.ts), [src/entrypoints/cli.tsx](src/entrypoints/cli.tsx), [src/coordinator/coordinatorMode.ts](src/coordinator/coordinatorMode.ts). Flags like `ABLATION_BASELINE`, `DUMP_SYSTEM_PROMPT`, `COORDINATOR_MODE` carve out internal-only behavior.
- **`process.env.USER_TYPE === 'ant'`** — a build-time `--define`, not a runtime env check. Code inside this branch only exists in Anthropic-internal builds. The canonical example is [src/utils/undercover.ts](src/utils/undercover.ts), where the entire file collapses to trivial returns in external builds.

When reasoning about behavior, ask which build you're modeling: "internal Ant build" or "external/public build" — the active code differs.

## Big-picture architecture

The hot path for a single user turn flows through these layers:

1. **Entrypoint** — [src/entrypoints/cli.tsx](src/entrypoints/cli.tsx) handles fast-paths (`--version`, `--dump-system-prompt`) with dynamic imports, then hands off to the full app.
2. **App shell** — [src/main.tsx](src/main.tsx) (4.7k lines) wires up the React/Ink terminal UI, command registry ([src/commands.ts](src/commands.ts), [src/commands/](src/commands/)), and tool registry ([src/tools.ts](src/tools.ts), [src/tools/](src/tools/)).
3. **QueryEngine** — [src/QueryEngine.ts](src/QueryEngine.ts) is the public-ish boundary used by the SDK and REPL. It assembles the system prompt, resolves tools/MCP/agents, and drives `query()`.
4. **query loop** — [src/query.ts](src/query.ts) (1.7k lines) is the model-streaming + tool-execution loop. This is where assistant turns, tool calls, permission checks, and compaction interleave.
5. **Tool contract** — [src/Tool.ts](src/Tool.ts) defines `ToolUseContext`, `ToolPermissionContext`, `ValidationResult`, and the shape every tool implements. Each tool lives in its own folder under [src/tools/](src/tools/) (e.g. `BashTool/`, `FileEditTool/`, `AgentTool/`).

### Cross-cutting subsystems

- **Permissions** — [src/Tool.ts:158](src/Tool.ts#L158) onward defines `ToolUseContext` with `ToolPermissionContext` carrying allow/deny/ask rule sets, `PermissionMode`, and per-mode flags (`shouldAvoidPermissionPrompts`, `awaitAutomatedChecksBeforeDialog`, `prePlanMode`). Hooks in [src/hooks/useCanUseTool.tsx](src/hooks/useCanUseTool.tsx) and helpers in [src/utils/permissions/](src/utils/permissions/) gate execution.
- **MCP** — [src/services/mcp/](src/services/mcp/) holds connection management, OAuth, channel allowlists, and the in-process / SDK-control transports. MCP tools surface through [src/tools/MCPTool/](src/tools/MCPTool/) and skill builders in [src/skills/mcpSkillBuilders.ts](src/skills/mcpSkillBuilders.ts).
- **Memory & autoDream** — [src/memdir/](src/memdir/) owns `MEMORY.md` reading/writing and memory file lifecycle ([memdir.ts](src/memdir/memdir.ts), [findRelevantMemories.ts](src/memdir/findRelevantMemories.ts)). [src/services/autoDream/](src/services/autoDream/) is the background subagent that consolidates memory between sessions.
- **Multi-agent** — [src/coordinator/coordinatorMode.ts](src/coordinator/coordinatorMode.ts) defines coordinator vs. worker tool sets (Team/SendMessage/SyntheticOutput tools are worker-internal). The `AgentTool` spawns subagents; [src/tasks/](src/tasks/) contains task variants (`LocalAgentTask`, `RemoteAgentTask`, `DreamTask`, `InProcessTeammateTask`).
- **Bridge / remote sessions** — [src/bridge/](src/bridge/) connects a local REPL to remote-controlled sessions (web/desktop/IDE). [src/remote/](src/remote/) handles WebSocket session management and permission bridging back to the user's machine.
- **State** — [src/state/AppState.tsx](src/state/AppState.tsx) is the root store. `ToolUseContext` exposes `getAppState`/`setAppState` plus `setAppStateForTasks` (the always-shared variant for session-scoped infrastructure that must survive subagent boundaries — see [src/Tool.ts:182-192](src/Tool.ts#L182-L192)).
- **Migrations** — [src/migrations/](src/migrations/) runs one-shot config/settings migrations on startup (model renames, settings relocations).

### Notable subsystems mentioned in the README

- **Undercover mode** ([src/utils/undercover.ts](src/utils/undercover.ts)) — Strips Anthropic-internal information (codenames like *Tengu*, *Capybara*, model IDs, "Co-Authored-By" lines) from commits/PRs when the repo isn't on the internal allowlist. Default is ON; there is no force-off.
- **Buddy** ([src/buddy/](src/buddy/)) — Tamagotchi-style companion with deterministic gacha keyed on `userId`.
- **Skills** ([src/skills/](src/skills/)) — Bundled skills loaded from [src/skills/bundled/](src/skills/bundled/) plus dynamic loading via [loadSkillsDir.ts](src/skills/loadSkillsDir.ts).

## Working in this codebase

- File paths in imports use `.js` extensions even though sources are `.ts/.tsx` (TypeScript NodeNext resolution convention).
- Many modules import from the `src/` alias (e.g. `from 'src/bootstrap/state.js'`) — keep this when adding new imports rather than relativizing.
- Custom ESLint rules referenced inline (`custom-rules/no-top-level-side-effects`, `custom-rules/no-process-env-top-level`, `custom-rules/safe-env-boolean-check`) are not configured in this archive but their intent is visible: avoid module-load side effects and gate `process.env` reads.
- The largest files ([main.tsx](src/main.tsx) 4.7k lines, [query.ts](src/query.ts) 1.7k, [QueryEngine.ts](src/QueryEngine.ts) 1.3k, [Tool.ts](src/Tool.ts) 0.8k, [commands.ts](src/commands.ts) 0.8k) are the load-bearing ones — start there for any cross-cutting question.
