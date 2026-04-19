# How Claude Code Works

A walkthrough of the runtime, written against the source in this repo. Paths are clickable.

## 1. Process startup

The shipped binary's entry is [src/entrypoints/cli.tsx](../src/entrypoints/cli.tsx). It is intentionally tiny and does almost nothing eagerly:

- `--version` returns immediately with a build-time-inlined `MACRO.VERSION` — zero further imports loaded ([cli.tsx:36-42](../src/entrypoints/cli.tsx#L36-L42)).
- Every other path uses **dynamic `import()`** so module evaluation cost is paid only when needed, and tracked via [src/utils/startupProfiler.ts](../src/utils/startupProfiler.ts).
- A few fast-paths (`--dump-system-prompt`, headless modes) short-circuit before the React/Ink UI is ever constructed.

When the full app is needed, `cli.tsx` hands off to [src/main.tsx](../src/main.tsx) — a 4.7k-line module that wires Commander.js subcommands, the React/Ink terminal renderer, the command registry, the tool registry, MCP connections, hooks, and the REPL launcher.

## 2. The query loop (the heart of an assistant turn)

User input flows into [src/QueryEngine.ts](../src/QueryEngine.ts), which is the public-facing boundary used by both the interactive REPL and the SDK. `QueryEngine` builds the inputs every turn needs:

- system prompt parts (from [src/utils/queryContext.ts](../src/utils/queryContext.ts))
- the resolved tool set
- MCP server connections + their resources
- agent definitions
- attribution / file history snapshots
- model selection ([src/utils/model/model.ts](../src/utils/model/model.ts))

It then calls into [src/query.ts](../src/query.ts) — the model-streaming + tool-execution loop. The shape is an async generator:

```
export async function* query(params): AsyncGenerator<StreamEvent | Message | …, Terminal>
```

`query()` defers to `queryLoop()` ([query.ts:241](../src/query.ts#L241)). Each iteration:

1. Sends the message history to the model (Anthropic SDK, via [src/services/api/claude.ts](../src/services/api/claude.ts)).
2. Streams assistant tokens back as `StreamEvent`s — yielded to the UI for live rendering.
3. When the assistant emits `tool_use` blocks, hands them to the tool orchestration layer ([src/services/tools/toolOrchestration.ts](../src/services/tools/toolOrchestration.ts)) which uses [StreamingToolExecutor](../src/services/tools/StreamingToolExecutor.ts) to run them — sometimes in parallel.
4. Each tool first goes through `canUseTool` ([src/hooks/useCanUseTool.tsx](../src/hooks/useCanUseTool.tsx)), which checks the user's permission context and may show a dialog.
5. Tool results are appended to the message history and the loop continues until the model stops asking for tools.

Throughout the loop, several services run concurrently or interleave:

- **auto-compact** ([src/services/compact/autoCompact.ts](../src/services/compact/autoCompact.ts)) watches token usage and may trigger a compaction.
- **microcompact** ([src/services/compact/microCompact.ts](../src/services/compact/microCompact.ts)) collapses individual tool results that exceed budget ([src/utils/toolResultStorage.ts](../src/utils/toolResultStorage.ts) with `applyToolResultBudget`).
- **stop hooks** ([src/query/stopHooks.ts](../src/query/stopHooks.ts)) and **post-sampling hooks** ([src/utils/hooks/postSamplingHooks.ts](../src/utils/hooks/postSamplingHooks.ts)) run user-configured shell commands at lifecycle points.
- **token budget** ([src/query/tokenBudget.ts](../src/query/tokenBudget.ts)) enforces per-turn caps and triggers continuation behavior.

The loop terminates with a `Terminal` value indicating why (model stopped, max turns, abort, error).

## 3. The tool contract

[src/Tool.ts](../src/Tool.ts) is the type contract every tool implements. The two key types:

- **`ToolUseContext`** ([Tool.ts:158](../src/Tool.ts#L158)) — passed to every tool invocation. Carries the abort controller, a file-state cache, the `getAppState`/`setAppState` pair (plus `setAppStateForTasks` for subagent infrastructure that must outlive a turn), MCP clients, agent definitions, model name, and configuration.
- **`ToolPermissionContext`** ([Tool.ts:123](../src/Tool.ts#L123)) — a `DeepImmutable` object holding the current `PermissionMode` and three rule sets (`alwaysAllow`, `alwaysDeny`, `alwaysAsk`). Plan mode stashes the prior mode in `prePlanMode` so it can be restored on exit.

Each tool lives in its own folder under [src/tools/](../src/tools/) — `BashTool/`, `FileEditTool/`, `AgentTool/`, `MCPTool/`, etc. A tool typically exports:

- a name constant
- a Zod input schema (zod/v4)
- a `prompt.ts` that contributes to the system prompt
- a `validateInput` step
- a `call` async generator that yields progress and finally a result

The tool registry assembled in [src/tools.ts](../src/tools.ts) is what the model actually sees; it's also where tools are filtered by mode (e.g. read-only set when an agent is plan-mode-only).

## 4. Permissions

Permissions are layered:

1. **Mode** — `default`, `acceptEdits`, `bypassPermissions`, `plan`. Mode determines defaults.
2. **Rules** — `alwaysAllow`, `alwaysDeny`, `alwaysAsk` rule sets pulled from settings.json (per scope: user, project, local).
3. **Hooks** — user-defined `PreToolUse` hooks can return `permissionDecision: "deny" | "allow" | "ask"`. These run in [src/utils/hooks/](../src/utils/hooks/) and short-circuit the dialog when they decide.
4. **`canUseTool`** — the React hook in [src/hooks/useCanUseTool.tsx](../src/hooks/useCanUseTool.tsx) ties it all together and surfaces the permission dialog through Ink components when needed.
5. **`shouldAvoidPermissionPrompts`** — set on subagent contexts that have no UI; their permission failures auto-deny rather than block waiting for input.

Filesystem-scope permissions (read/write inside the working directory) live in [src/utils/permissions/filesystem.ts](../src/utils/permissions/filesystem.ts).

## 5. Memory: the auto-memory & dream system

`MEMORY.md` is loaded into the system prompt via [src/memdir/memdir.ts](../src/memdir/memdir.ts) (`loadMemoryPrompt`). Individual memory files live alongside `MEMORY.md` under the project's auto-memory directory ([src/memdir/paths.ts](../src/memdir/paths.ts)).

Two complementary systems update memory:

- **`extractMemories`** ([src/services/extractMemories/](../src/services/extractMemories/)) — runs during a turn and writes new memories the model identifies as worth saving.
- **`autoDream`** ([src/services/autoDream/autoDream.ts](../src/services/autoDream/autoDream.ts)) — a background subagent that consolidates memory across sessions. Three cheap-to-expensive gates fire in order ([autoDream.ts:5-9](../src/services/autoDream/autoDream.ts#L5-L9)):
  1. **Time gate** — `lastConsolidatedAt` older than `minHours`.
  2. **Session gate** — count of session transcripts modified since last consolidation ≥ `minSessions`.
  3. **Lock** — atomic file lock so only one process consolidates at a time ([consolidationLock.ts](../src/services/autoDream/consolidationLock.ts)).
  
  When all three pass, `autoDream` spawns a forked agent ([src/utils/forkedAgent.ts](../src/utils/forkedAgent.ts)) running the consolidation prompt ([consolidationPrompt.ts](../src/services/autoDream/consolidationPrompt.ts)). It can only edit files in the auto-memory directory — enforced via a custom `canUseTool` that wraps `FileEditTool`/`FileWriteTool` ([extractMemories.ts](../src/services/extractMemories/extractMemories.ts)).

## 6. Multi-agent: Agent tool, coordinator mode, tasks

The `AgentTool` ([src/tools/AgentTool/](../src/tools/AgentTool/)) spawns a subagent — a fresh `query()` invocation with its own message history, tool subset, and `ToolUseContext`. Subagents run as **tasks**, the unifying abstraction in [src/tasks/](../src/tasks/):

- `LocalAgentTask` — in-process subagent ([src/tasks/LocalAgentTask/](../src/tasks/LocalAgentTask/))
- `RemoteAgentTask` — runs on a remote machine over WebSocket ([src/tasks/RemoteAgentTask/](../src/tasks/RemoteAgentTask/))
- `LocalShellTask` — backgrounded `Bash` invocation
- `DreamTask` — the autoDream consolidator
- `InProcessTeammateTask` — coordinator-mode workers
- `LocalMainSessionTask` — used when the main REPL itself is the agent target

**Coordinator mode** ([src/coordinator/coordinatorMode.ts](../src/coordinator/coordinatorMode.ts)) is a different conversation shape entirely. The coordinator's system prompt frames it as an orchestrator that should not work directly — instead it spawns workers via `AgentTool`, continues them via `SendMessageTool`, and stops them via `TaskStopTool`. Workers see a different tool set: they get `Bash`, `FileEdit`, etc., but not the coordinator-internal tools (`TeamCreate`, `TeamDelete`, `SendMessage`, `SyntheticOutput`). Mode is gated on `feature('COORDINATOR_MODE')` + `CLAUDE_CODE_COORDINATOR_MODE`.

## 7. MCP: Model Context Protocol

[src/services/mcp/](../src/services/mcp/) is the MCP client implementation. Highlights:

- [MCPConnectionManager.tsx](../src/services/mcp/MCPConnectionManager.tsx) holds the live connections and exposes them through [useManageMCPConnections.ts](../src/services/mcp/useManageMCPConnections.ts).
- Multiple transports: [InProcessTransport.ts](../src/services/mcp/InProcessTransport.ts) for plugins running inside the Claude Code process; [SdkControlTransport.ts](../src/services/mcp/SdkControlTransport.ts) for SDK-controlled servers; HTTP/SSE for external servers.
- OAuth flows for hosted MCP servers in [auth.ts](../src/services/mcp/auth.ts).
- **Channel allowlist** ([channelAllowlist.ts](../src/services/mcp/channelAllowlist.ts)) — gates which Anthropic-managed channels are available for the user's plan tier.
- **Elicitations** — MCP servers can ask the user a question via [elicitationHandler.ts](../src/services/mcp/elicitationHandler.ts); REPL mode queues these into the UI, while SDK/print mode forwards them to `structuredIO`.

MCP tools surface to the model through [src/tools/MCPTool/](../src/tools/MCPTool/) (one virtual tool per MCP tool). MCP-backed skills are constructed in [src/skills/mcpSkillBuilders.ts](../src/skills/mcpSkillBuilders.ts).

## 8. Bridge: remote control & IDE integration

[src/bridge/](../src/bridge/) lets a local REPL be driven from elsewhere — the desktop app, the web app, or an IDE extension. Architecture:

- [bridgeMain.ts](../src/bridge/bridgeMain.ts) is the entry. It starts a WebSocket connection back to a Claude-managed broker.
- [replBridge.ts](../src/bridge/replBridge.ts) plus [replBridgeTransport.ts](../src/bridge/replBridgeTransport.ts) translate inbound messages (user prompts, attachments) into local REPL events.
- [bridgePermissionCallbacks.ts](../src/bridge/bridgePermissionCallbacks.ts) bridges permission dialogs from the local CLI to the remote control surface.
- [trustedDevice.ts](../src/bridge/trustedDevice.ts) + [jwtUtils.ts](../src/bridge/jwtUtils.ts) handle the trust-on-first-use device pairing.

[src/remote/](../src/remote/) is the corresponding server-side concept: when this CLI hosts a session that another machine controls (`RemoteSessionManager`).

## 9. State

[src/state/AppState.tsx](../src/state/AppState.tsx) is the root store (a custom store, not Redux). Selectors in [selectors.ts](../src/state/selectors.ts), subscribers in [onChangeAppState.ts](../src/state/onChangeAppState.ts).

`ToolUseContext` exposes `getAppState`/`setAppState` for tool implementations. Subagents get a *separate* setter — `setAppStateForTasks` — that always reaches the root store, so a subagent can register session-scoped infrastructure (background tasks, hooks) that must outlive its own turn ([Tool.ts:182-192](../src/Tool.ts#L182-L192)).

## 10. Build-time conditionals

Two mechanisms collapse code at bundle time. At runtime they look like normal branches; in the shipped artifact one branch is gone.

- **`feature('FLAG')` from `bun:bundle`** — Bun's bundler treats this as a constant. See [src/QueryEngine.ts](../src/QueryEngine.ts) and the `require()`-with-feature-gate pattern at [query.ts:14-21](../src/query.ts#L14-L21) used to keep optional services out of the external bundle entirely.
- **`process.env.USER_TYPE === 'ant'`** — a `--define` substituted at build time. Code inside this branch only ships in internal Ant builds. The whole of [src/utils/undercover.ts](../src/utils/undercover.ts) is the canonical example: in external builds every function reduces to a trivial return.

When you read a file, ask which build you're modeling — the active code differs.

## 11. Skills, slash commands, and plugins

- **Slash commands** ([src/commands.ts](../src/commands.ts), [src/commands/](../src/commands/)) — both built-in (`/help`, `/clear`, `/init`) and user-defined. Built-ins are TypeScript modules; user-defined commands are markdown files in `.claude/commands/` with frontmatter.
- **Skills** ([src/skills/](../src/skills/)) — bundled skills live in [src/skills/bundled/](../src/skills/bundled/); dynamic skills are loaded by [loadSkillsDir.ts](../src/skills/loadSkillsDir.ts) from `.claude/skills/`. The `SkillTool` invokes them.
- **Plugins** ([src/plugins/](../src/plugins/), loaded by [src/utils/plugins/pluginLoader.ts](../src/utils/plugins/pluginLoader.ts)) — bundle commands, skills, hooks, and MCP server definitions. Built-in plugins: [src/plugins/builtinPlugins.ts](../src/plugins/builtinPlugins.ts).

## 12. The lifecycle in one paragraph

`cli.tsx` does fast-path routing → `main.tsx` builds the React/Ink UI and registers tools/commands → user input enters `QueryEngine`, which gathers system prompt parts, MCP connections, tools, and agent definitions → control passes to `query()`, which streams the model response, dispatches tool calls through `canUseTool` and the `StreamingToolExecutor`, applies token-budget and microcompact policies, fires hooks at lifecycle points, and yields `StreamEvent`s back to the UI → between turns, `extractMemories` may save new memories and `autoDream` may consolidate them in a forked subagent → on quit, session storage flushes and the bridge (if active) reports the disconnection.
