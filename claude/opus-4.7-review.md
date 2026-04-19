# Aggregated review — 24 parallel agents, ~1,332 TS files, ~30MB of code

Findings are sub-agent claims; not all verified against current source. Anything you want to act on, spot-check first — line numbers can drift and some issues describe risk paths rather than confirmed reproductions.

---

## 🔴 CRITICAL — security or data-loss caliber

| # | Location | Finding |
|---|---|---|
| 1 | src/utils/telemetryAttributes.ts:52 | **PII leak**: user OAuth email is added to telemetry attributes and propagates into every event via `getTelemetryAttributes()`. |
| 2 | src/commands/chrome/chrome.tsx:189 | **Subscription gate bypass**: `isWSL \|\| true && !isClaudeAISubscriber` is `isWSL \|\| (true && !isClaudeAISubscriber)` due to precedence — the `true &&` makes the whole condition trivially satisfied for non-WSL non-subscribers. |
| 3 | src/screens/REPL.tsx:2365-2374 | `setImmediate(setToolUseConfirmQueue => { ... }, setToolUseConfirmQueue)` — `setImmediate`'s second arg is *not* passed to the callback. The whole permission-recheck pass is dead code. |
| 4 | src/tools/WebFetchTool/utils.ts:162-166 | **SSRF**: `validateURL` only rejects single-label hostnames (`localhost`). `127.0.0.1`, `10.*`, `192.168.*`, `169.254.169.254` all pass. WebFetch can hit cloud metadata / internal services. |
| 5 | src/utils/permissions/filesystem.ts:1262-1299 | Session-scope carve-out for `Edit(/.claude/**)` runs before `isDangerousFilePathToAutoEdit`. The guard does string `includes('..')` on the resolved rule, but a rule like `Edit(/path/settings/../.ssh)` passes the literal-`..` check while expanding outside `.claude/`. |
| 6 | src/utils/plugins/validatePlugin.ts:92-106 | Plugin manifest path traversal check is `p.includes('..')` only. Symlinks and absolute paths (`commands: ['/etc/passwd']`) bypass the check entirely. |
| 7 | src/commands/heapdump/heapdump.ts:3-16 | `/heapdump` prints the on-disk heap path to stdout with no warning. Heaps contain session tokens, API keys, decrypted secrets — those paths end up in terminal scrollback / CI logs. |
| 8 | src/utils/sandbox/sandbox-adapter.ts:313 + permissions/filesystem.ts:944 | Settings-relative path resolution can let a user-scope `Edit(/foo)` rule shadow an admin policy deny on the same path via `patternsByRoot` Map-key collision. |
| 9 | src/utils/secureStorage/macOsKeychainStorage.ts:106-132 | Hex-encoded payload over stdin is the secure path; off-by-one in `command.length` check can route credentials to argv (visible to other processes via `ps`). |
| 10 | src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx | Classifier auto-approval can race a user "No" — refinement promise still resolves and applies allow rule after rejection. |

---

## 🟠 MAJOR BUGS — wrong behavior under normal conditions

### Auth / sessions / networking
- src/bridge/remoteBridgeCore.ts:325-326 — Token refresh race on laptop wake: if `onAuth401` throws, `getAccessToken()` still returns the stale token, two parallel callers each get a different epoch.
- src/bridge/remoteBridgeCore.ts:397-400 — `void flushHistory(initial).catch(...)` only logs; `connected` state fires even when the flush failed → "session connected, messages silently dropped".
- src/bridge/remoteBridgeCore.ts:678 — `void transport.write(makeResultMessage(...))` not awaited before `transport.close(line:716)` — result message lost.
- src/services/oauth/auth-code-listener.ts:134-150 — Concurrent OAuth redirects (browser auto-open + manual paste) race on `pendingResponse`/`promiseResolver` without sync.
- src/services/oauth/index.ts:76-80 — PKCE state has no expiry → cross-tab replay window measured in days.
- src/services/api/withRetry.ts:506 — `attempt = maxRetries` clamp lets `persistentAttempt` grow unbounded under sustained 429/529.
- src/services/api/client.ts:330-354 — `ANTHROPIC_CUSTOM_HEADERS` parsed and passed without stripping `Authorization`-class headers.
- src/services/lsp/LSPServerInstance.ts:256-258 — `initPromise?.catch(() => {})` after `client.stop()` can leave zombie LSP processes.

### MCP
- src/services/mcp/client.ts:269-304 — `writeChain = writeChain.then(...)` grows linked-list of resolved promises forever on repeated auth-cache write failures.
- src/services/mcp/client.ts:268-316 — Concurrent batch connect: cache reads can happen while a write is mid-flight → 401 thundering herd.
- src/services/mcp/client.ts:456-458 — No jitter on connection timeout; all servers time out simultaneously.

### File operations / filesystem
- src/tools/FileEditTool/FileEditTool.ts:290-310 and src/tools/FileWriteTool/FileWriteTool.ts:211-219 — TOCTOU window between `validateInput` and `call`; same staleness check duplicated, easy to drift apart.
- src/utils/fileHistory.ts:622-634 — `stat` then `readFile` race: file deleted between calls returns "changed=true" instead of ENOENT.
- src/utils/fileReadCache.ts:39-40 — `mtimeMs` float comparison; sub-millisecond timestamps cause cache misses every turn. `file.ts` already uses `Math.floor` — cache should match.
- src/utils/sessionStorage.ts:1160-1199 — Fire-and-forget metadata writes when `sessionFile === null`; if `materializeSessionFile()` later fails, queued writes are lost silently.
- src/utils/sessionStorage.ts:1318-1342 — Asymmetric error handling: CCR v1 `appendSessionLog` failure → `gracefulShutdownSync(1)`, CCR v2 internal-event-writer failure → silent `logForDebugging` only.

### Coordination / state
- src/state/AppStateStore.ts:24 — `onChange` fires after `state = next`; concurrent `setState` callers can see stale `prev` and lose updates.
- src/bootstrap/state.ts:1556-1560 — `STATE.invokedSkills.delete(key)` while iterating its own `entries()` — undefined order.
- src/hooks/useSwarmPermissionPoller.ts:298-299 — `for (... pendingCallbacks.entries())` then inner `processResponse` deletes from the same map. Iterator invalidation.
- src/tasks/LocalShellTask/killShellTasks.ts:20-32 — `task.shellCommand?.cleanup()` not awaited; `unregisterCleanup` can throw and skip `clearTimeout(cleanupTimeoutId)` → orphan timer fires on dead task.
- src/services/autoDream/autoDream.ts:262-272 — Abort handler trusts `runForkedAgent` to honor the signal; if it doesn't, consolidation lock is held until process exit.
- src/utils/messageQueueManager.ts:244-265 — Two-step queue mutation (clear then push remaining); exception between steps corrupts the queue.

### Hook / React lifecycle
- src/hooks/useRemoteSession.ts:137 — `BoundedUUIDSet(50)` is a ring, not a true set — UUIDs reappearing after 50 evictions are treated as new and emit duplicate user messages.
- src/hooks/useDirectConnect.ts:66-186 — `onMessage` / `onPermissionRequest` not in try/catch; a malformed message crashes the WS callback.
- src/hooks/usePromptsFromClaudeInChrome.tsx:42 — `setNotificationHandler` registered in `useEffect` with no cleanup; remount leaks handlers.
- src/hooks/usePrStatus.ts:85 — `setTimeout(poll, ...)` captures stale `poll` after deps change.
- src/components/Wizard/WizardProvider.tsx:66-67 — `goNext` deps include `navigationHistory` → rapid back/next races corrupt history.

### Tools (non-file)
- src/tools/ConfigTool/ConfigTool.ts:330-343 — `buildNestedObject` recursive write with no `__proto__`/`constructor` guard → potential prototype pollution if Zod ever permits keys to slip through.
- src/tools/SkillTool/SkillTool.ts:910-933 — `skillHasOnlySafeProperties` is an allowlist that grows by hand; safer as a denylist.
- src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:260,375 — `void persistFileSnapshotIfRemote()` and `startInProcessTeammate()` fire-and-forget unhandled rejections; teammate stuck "running" if spawn fails mid-execution.
- src/tools/SendMessageTool/SendMessageTool.ts:354-365 — Missing null-check on `task?.abortController` → shutdown approval is a silent no-op.
- src/tools/SendMessageTool/SendMessageTool.ts:451-457 — UDS `parseAddress(input.to).target` not validated against local-path SSRF (`uds:///etc/passwd`).
- src/tools/TeamDeleteTool/TeamDeleteTool.ts:87 — `m.isActive !== false` defaults true for legacy teams missing the field; refuses to delete pre-field teams.

### Ink renderer
- src/ink/parse-keypress.ts:263-279 — X10 mouse `\x1b[M` split across reads can deliver `[<btn;col;rowM` as typed input.
- src/ink/stringWidth.ts:56-65 — Fast-path `needsSegmentation` doesn't scan for ZWJ (`\u200D`); keycap sequences (`2️⃣`) measure as width 1, drifting cursor.
- src/ink/termio/tokenize.ts:228-235 — X10 mouse coord bytes in 0xC2–0xDF range form valid UTF-8 → `i + 3 >= data.length` false → tokenizer buffers indefinitely on terminals without DECSET 1006 at 162+ cols.
- src/ink/output.ts:204 — `charCache` clears at 16384 but only inside `reset()`; long streaming sessions accumulate ~16KB of dead mappings between resets.

### Components
- src/components/StatusLine.tsx:230-233 — `setTimeout` callback closure captures `doUpdate` from the schedule moment; later state updates apply against an old `messagesRef`/`setAppState`.
- src/components/VirtualMessageList.tsx:745-746,859-860 — `offsets[start]!` is `undefined - number = NaN` when `start === 0` and `offsets` empty; off-by-one risk if messages append between `slice` and render.
- src/components/ScrollKeybindingHandler.tsx:665-676 — `getPendingDelta() === 0` checked once per tick, but a render commit between the check and `shiftAnchor()` makes anchor math read pre-commit `scrollTop`.
- src/components/Stats.tsx:374 — `usage.inputTokens + usage.outputTokens` over `Object.entries(stats.modelUsage)` with no `?? 0` → `NaN` book-count factoid if any entry is partial.
- src/components/grove/Grove.tsx:157-173 — `useEffect` with async function, no abort controller, no `.catch()`. setState-on-unmounted on rapid theme toggle.
- src/components/design-system/Tabs.tsx:91-93 — Controlled mode clamps `controlledTabIndex !== -1 ? : 0`; unmatched parent `selectedTab` traps Tabs on tab 0.
- src/components/permissions/hooks.ts:142-163 — Detailed permission-decision logging only fires under `USER_TYPE === 'ant'`. Public production users have no audit trail of what they auto-approved.
- src/components/ManagedSettingsSecurityDialog/utils.ts — Env-var allowlist comparison case-mismatched: `SAFE_ENV_VARS.toUpperCase()` vs raw setting keys → capitalized whitelisted vars (`HOME`, `USER`) flagged dangerous.

### Commands
- src/commands/branch/branch.ts:179-220 — `getUniqueForkName` searches collisions, then forks; no lock → two `/branch` calls produce duplicate-named branches.
- src/commands/exit/exit.tsx:20-23 — `spawnSync('tmux', ['detach-client'], { stdio: 'ignore' })` then `onDone()` regardless. Detach failure is invisible.
- src/commands/export/export.tsx:53-72 — `join(getCwd(), filename)` accepts user filename without rejecting `..`; only the extension is checked.
- src/commands/sandbox-toggle/sandbox-toggle.tsx:61 — Quote-stripping only outer `"`/`'`; embedded shell metacharacters persist into stored sandbox-exclude pattern.

### Utilities
- src/utils/cryptoModule.ts:12-13 — Bun bytecode breaks `export { randomUUID }` re-export. Workaround in place but a one-line refactor will silently regress.
- src/utils/json.ts:42,52-54 — `parseJSONCached` keys by full JSON string, not hash. Comments acknowledge but the cache still pins ~10MB if 50 large blobs land in slots.
- src/utils/imageResizer.ts:819-829 — `detectImageFormatFromBase64` swallows errors and returns `'image/png'`; misclassified format reaches the API.
- src/utils/sessionIngressAuth.ts:138-140 — `process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN` mutated with caller-supplied string, no length/null-byte/format validation.
- src/utils/promptShellExecution.ts:131 — `result.replace(match[0], () => output)` injects shell stdout/stderr into prompt; skill authors can hide instructions in stderr.
- src/utils/agenticSessionSearch.ts:289 — `jsonParse(jsonMatch[0])` cast to `AgenticSearchResult` without schema validation.
- src/keybindings/resolver.ts:94-98 — Escape key keeps spurious `meta`/`alt` modifiers in the parsed keystroke; `keystrokesEqual` comparisons mismatch.
- src/memdir/teamMemPaths.ts:117-120 — `realpathDeepestExisting` exits before resolving root; symlink-escape after rejoin not re-verified.
- src/upstreamproxy/relay.ts:161 — Proxy auth uses `sessionId:token` Basic; if `sessionId` is deterministic, brute-force surface widens.
- src/cli/structuredIO.ts:385-401 — `resolvedToolUseIds` Set evicts at 1000; concurrent identical control_responses can each pass the dedup check, producing API-level "tool_use ids must be unique" 400s.

---

## 🟡 PERFORMANCE — measurable, user-visible

| Location | Issue |
|---|---|
| src/QueryEngine.ts:1259 | `cloneFileStateCache(getReadFileCache())` deep-clones the LRU on **every** API call. |
| src/query.ts:331-335 | `skillPrefetch?.startSkillDiscoveryPrefetch()` fires every iteration; the `findWritePivot` guard described in comments isn't actually applied. |
| src/utils/sessionStorage.ts:644-686 | `content += line` in `drainWriteQueue` → O(n²) string concat; no batch count cap, only byte cap. |
| src/utils/sessionStorage.ts:721-739 | `readFileTailSync` reads last 64KB sync on every metadata refresh — UI stutter on multi-GB transcripts. |
| src/utils/sessionStoragePortable.ts:156 | `parseJSONL` fully synchronous; one bad line nukes entire transcript. |
| src/services/SessionMemory/sessionMemory.ts:137-147 | `tokenCountWithEstimation(messages)` called twice per turn, full traversal each time. |
| src/services/policyLimits/index.ts:391-405 | `loadCachedRestrictions` uses `fsReadFileSync` from `isPolicyAllowed()` callers (settings init). Startup stall on slow disks. |
| src/services/policyLimits/index.ts:618-624 | `jsonStringify(sessionCache)` twice per hourly poll just for equality comparison. |
| src/utils/imageResizer.ts:256-273,326-346 | Quality loop creates 4 fresh `sharp` instances → 100MB peak on a 10MB image. |
| src/utils/permissions/shellRuleMatching.ts:142-145 | New RegExp per permission check; 1000s of allocations per turn. |
| src/utils/permissions/filesystem.ts:709-743 | macOS `/private/var` ↔ `/var` normalization is lossy; can satisfy containment for non-matching paths. |
| src/utils/sandbox/sandbox-adapter.ts:265-280 | Worktree detection iterates `bareGitRepoFiles` with `statSync` per refresh; ~10K syscalls/min in fleets. |
| src/utils/debug.ts:104-125 | 5 regex passes per debug log. |
| src/utils/mcpValidation.ts:151-178 | `countMessagesTokensWithAPI` per oversized MCP result — network round-trip per result. |
| src/cli/print.ts:923-926 | `jsonStringify(messages) + '\n'` per turn in headless mode; `ndjsonSafeStringify` exists but unused here. |
| src/native-ts/file-index/index.ts:253-270 | Top-K via `splice(lo, 0, ...)` is O(n²); use a heap. |
| src/ink/line-width-cache.ts:18-19 | All-or-nothing eviction at 4096; observable freeze on long streams. |
| src/components/HighlightedCode/Fallback.tsx, src/components/diff/DiffDetailView.tsx, src/components/CustomSelect/select.tsx | Large code/diff/select renders without virtualization or memoization. |
| src/screens/REPL.tsx:696,779-781 | `getTools(toolPermissionContext)` memo invalidates on `proactiveActive`/`isBriefOnly` (object identity from `useAppState`). Tools list rebuilt 10–20× per turn. |
| src/components/PromptInput/PromptInput.tsx:~460-545 | ~10 `useMemo` blocks recompute regex searches on every keystroke (no debounce). |
| src/components/LogSelector.tsx:583,603 | `displayedLogs.indexOf(...)` O(N) inside a map → O(N²) for large sessions. |

---

## 🔵 REFACTORS / improvements

- **Duplicated retry/backoff** across `services/policyLimits`, `remoteManagedSettings`, `settingsSync`. Extract one `fetchWithRetry+ETag` helper.
- **Duplicated TOCTOU staleness check** in FileEditTool and FileWriteTool. One helper.
- **Duplicated path/argv parsing** in BashTool/pathValidation.ts:791-817 and 1263-1303 (text-based vs argv-level).
- **Duplicated permission-update + sandbox-refresh** in `commands/add-dir`, `commands/config`, others.
- **Duplicated CONNECT relay** between Bun and Node paths in upstreamproxy/relay.ts:176-289.
- **Duplicated migration scaffolding** across src/migrations/. Extract `runMigrationOnce(key, fn)`.
- **Duplicated notification-hook pattern** — `useStartupNotification` exists as a factory but only `useInstallMessages` adopted it; 14 other notifs reimplement the pattern.
- **Hardcoded `SWARM_FIELDS_BY_TOOL`** in src/utils/api.ts:163 — let tools declare their swarm-only fields.
- **Hardcoded git/gh allowlist** in src/utils/shell/readOnlyCommandValidation.ts — invert to denylist.
- **`Object.freeze(ctx)`** in hooks/toolPermission/PermissionContext.ts:347 is misleading: methods still mutate via `setState`. Drop the freeze or document.
- **Bun bytecode landmine** in src/utils/cryptoModule.ts needs a CI guard preventing reversion to `export {}` syntax.
- **`memoizeWithTTL` keys by `jsonStringify(args)`** in src/utils/memoize.ts:47 — can fail on cyclic args, slow on big inputs.
- **`mockBillingAccessOverride`** in src/utils/billing.ts:47 is a global with no test-isolation reset.

---

## Coverage notes

24 Explore agents reviewed the directories below. Almost every file was read at least once; for the largest files (REPL.tsx 895KB, main.tsx 803KB, PromptInput.tsx 355KB, Config.tsx 271KB, ink.tsx 251KB, AgentTool.tsx 233KB) agents read in chunks and may have skimmed sections. Generated protobuf under `src/types/generated/` was spot-checked only.

**Caveats**
- Findings are agent claims. Re-read the cited line before committing a fix.
- Some "BUG" entries describe a *risk path* (e.g., race window, TOCTOU window) rather than a confirmed reproduction.
- Severity ranking is based on blast radius.
