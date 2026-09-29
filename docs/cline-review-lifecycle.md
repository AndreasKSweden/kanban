# Cline review continuation failure (2026-09-29)

## Finding and evidence

The reproduced task exposes **duplicate Kanban automation ownership**, not proof that the implementation run remained permanently stuck in Cline.

The read-only runtime chat query for `1bb31` contains two identical commit-action user messages:

- `1790707588638` (`18:46:28.638Z`)
- `1790707588651` (`18:46:28.651Z`), 13 ms later
- `1790707588960`: `SessionRuntime state is "running"; call canStartRun() first (agentId=agent_1790706997792_sqwed1)`.

The board armed `pendingGitAction` at `1790707588417`. The saved SDK transcript contains one accepted commit prompt at `1790707588726`; the saved SDK manifest is `idle`. Kanban's summary is `awaiting_review`, `reviewReason: error`, with the pending git action still armed. This distinguishes the failed overlapping continuation from the original implementation run.

The browser hook was restored in fork commit `e9fe397b` while the server reconciler already owned auto-review. Both were mounted. The browser only checked its board snapshot's `pendingGitAction`; it never acquired the server's atomic lock. Until the server broadcasts the armed board, both actors can submit the same action. The chat confirms two submissions; no per-request trace remains to assign each message conclusively to one actor.

## Failing paths

1. SDK `done` / `run-finished` -> `applyClineSessionEvent` -> `awaiting_review` summary -> Review card.
2. Server `createAutoReviewReconciler` -> `armPendingGitAction` -> `triggerClineGitAction` -> `sendTaskSessionInput`.
3. Concurrent browser `useBoardInteractions` -> `useReviewAutoActions` -> `runAutoReviewGitAction` -> `runTaskGitAction` -> native chat-send route -> `sendTaskSessionInput`.
4. Both enter `dispatchResolvedTaskInput` -> `InMemoryClineSessionRuntime.sendTaskSessionInput` -> `ClineCore.send` -> `LocalRuntimeHost.runTurn` -> `executeTurn` -> `executeAgentTurn` -> `SessionRuntime.run` / `continue`.
5. `getRunAdmissionError` rejects the second overlapping run. Kanban's asynchronous send failure updates the summary after its submission was already acknowledged; the reconciler previously kept waiting for a commit.

The second task-service call can select explicit `delivery: "queue"` because the first call already updated Kanban's summary to running. The SDK's queue drain and direct admission both test `agent.canStartRun()` before asynchronous turn preparation. Two requests can therefore pass during preparation, before either calls `SessionRuntime.run/continue`. The low-level guard still prevents two runs, but one request fails and host failure cleanup can interrupt the accepted run. This check-before-await window exists in the inspected source and built Kanban bundle. The precise live interleaving is inferred, not captured in a stack trace.

## Cline lifecycle contract

Inspected source: `/home/andreaskeller/cline-main`, HEAD `8e3b3863c8a38f7b2fb2175ae65e2e04b32ff202`; also checked the fork's installed SDK and existing `dist/cli.js`.

- `SessionRuntime.executeRunInternal` sets `running = true` before extension initialization, message preparation, tool/model construction and execution. It describes an in-flight run, not just model streaming.
- `AgentRuntime` emits `run-finished` before returning its result. `RuntimeEventAdapter` translates that to `done`; listeners can observe it while the session is still locked. Final assistant output and completion events are not readiness signals.
- The internal `finally` unsubscribes, removes the external abort listener, drains `activeTrackerWork`, clears the active runtime and sets `running = false`. Conversation replacement/result construction and possible auth retry still follow.
- `executeRun` clears `activeRunPromise` in its outer `finally`. `canStartRun()` requires **both** `!running` and `!activeRunPromise`, and no shutdown. Awaiting `run()` / `continue()` is the normal sequencing boundary. `continue()` preserves the conversation; `run()` resets its boundary trackers/history behavior.
- `ClineCore.send()` delegates to the runtime host. A direct send waits for the run, transcript persistence and interactive idle transition. Explicit queued input returns an acknowledgement, not a completed-run promise. Public `ClineCore` does not expose the inner runtime's `canStartRun()` method.
- `LocalRuntimeHost.completeInteractiveTurn` emits the idle status after execution. Low-level `done`, tool completion, persisted board state, and model output must not be substituted for this boundary. Interactive public sends are allowed while busy via the SDK queue; it would be inaccurate to call every early `ClineCore.send()` an API violation. The concrete Kanban misuse here is delivering one automatic action twice and using display completion to sequence direct continuations.
- Abort requests do not immediately unlock a run. They propagate to the agent, including an abort retained during startup, and normal promise cleanup drains the run. Shutdown rejects late runs and waits for an aborted active run. Cancellation must also cancel any integration-owned pending continuation.
- A tool/provider promise or tracker callback that never settles can keep a run active. There is also a separate source-level risk: initialization before the internal execution `try/finally` can throw after setting `running`. Neither is established as the cause of this task; its accepted continuation and duplicate messages point to overlapping submission. No speculative SDK state-machine change is included.

## Fix ownership and behavior

The fix is in Kanban on `viggo/pr643-test`:

- Remove the browser auto-review hook and its unused callback plumbing. The runtime remains the sole owner of automatic commit/PR dispatch and uses its durable atomic arm operation. Manual git actions and terminal-agent dispatch remain available.
- Sequence direct initial/continuation sends per SDK session with the preceding send promise. The reservation is synchronous; final-output callbacks cannot start another direct send early. Explicit queue/steer requests retain SDK queue semantics.
- Bound each pending continuation wait to 60 seconds. Abort, stop, clear, ended-session cleanup and disposal cancel waiting sends. Timeout/cancellation never releases a still-running predecessor or fires the timed-out prompt later. Errors reach the existing task error reporting path.
- Disarm pending native Cline auto-review when its asynchronous send reports an error. Do not automatically repeat a failed action indefinitely; retain the visible error. A later successful turn enables auto-review again.

The SDK admission guard is unchanged. The host's broader concurrent-admission window remains a separate SDK concern; removing duplicate ownership addresses the reproduced trigger without relaxing that guard or changing Cline as an integration workaround.

This can explain historical Review stalls when the same duplicate-owner configuration was active: one action is acknowledged, its later SDK failure never creates a commit, and the armed action waits for HEAD to change. Older stalls without retained messages cannot be attributed conclusively.

## Validation and limits

Regression coverage includes final output while still running, promise readiness, same-session continuation exactly once, concurrent direct reservations, repeated correction cycles, cancellation on all runtime cleanup paths, never-ready timeout with no late start, abnormal previous termination, concurrent reconciler evaluations, asynchronous failure disarming/recovery, and a stale browser that no longer dispatches automation. Existing reconciler tests cover terminal agents.

No live board, session files, task worktree, architecture document, runtime process, or generated deployment bundle was modified. Applying the source fix to the live runtime requires a rebuild/restart and refreshed browser assets; that deployment is outside this investigation.

Validation results:

- Full repository fast/precommit suite: 65 files, 745 tests passed with local test sockets permitted (sandbox-only run failed on `EPERM`).
- After the final synchronous-callback reservation regression was added: all 155 SDK/reconciler tests passed.
- Focused browser suites: 13 tests passed; web TypeScript check passed.
- New regressions fail against the original runtime wrapper (illegal second send) and original browser hook (extra automatic delivery), then pass with the fix.
- Biome checks on changed TypeScript files and `git diff --check` passed.
- Backend TypeScript check fails on the pre-existing `@cline/core` 0.0.86 / `@cline/shared` 0.0.81 `AgentToolContext` mismatch (`ProviderErrorClass` gained `auth`). Repeating the check with the original runtime file confirms the same failure. Existing dependency and compaction edits are preserved and excluded from this commit. The commit hook's repeated backend typecheck therefore cannot pass in this working tree; validation was run explicitly before committing.
