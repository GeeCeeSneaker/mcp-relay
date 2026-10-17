# WO-0010 native Job ownership slice — NO INSTALL

Implements the next bounded engineering slice released by
[review6230609741](https://github.com/GeeCeeSneaker/mcp-relay/pull/42#issuecomment-6230609741).
The gateway slice at 6a6aa3c is independently accepted; its source/tests remain
unchanged. This native slice requires independent review and does not accept the
whole WO, authorize a field restart, or resolve the separate live routing #43.

## Product behavior

- Create and configure the Job before starting a process. Check CreateJobObject
  and SetInformationJobObject results; preserve the existing KILL_ON_JOB_CLOSE /
  BREAKAWAY_OK flags and ADR-0008 behavior.
- Check AssignProcessToJobObject before emitting `started`, setting RunningSince,
  or reporting IsRunning. Assignment failure latches ownership uncertainty and
  cleans only the exact root Process handle, plus its exact Job when available.
- Check TerminateJobObject and CloseHandle. Keep the Job handle on failure;
  failed termination does not fall through to closing/discarding it. A successful
  stop also requires a bounded native wait on the held root process handle.
- Any failed/uncertain ownership or stop latches OwnershipBlocked for this
  supervisor instance, cancels pending retry, suppresses Start/Restart/timer
  replacement, clears RunningSince and makes IsRunning false. Tray labels/icon
  expose the blocked state rather than reporting contained/running or stopped.
- Explicit Stop may retry cleanup using retained exact handles. Successful later
  cleanup does not clear the uncertainty latch. Ordinary Process.Start failures
  after successful Job setup retain their existing retry/backoff when cleanup
  succeeds. No name-based process scan/kill, supervisor service, or policy override
  is added.

`Jobs.Calls` is an internal, instance-local seam around native calls; production
constructs the native implementation. Tests compile with the actual MCPRelay.cs
and override individual return values/exceptions while keeping other calls real.
There is no environment flag or global runtime fault switch.

Process.Start followed by Job assignment is not atomic. A child can run before
assignment. On assignment failure, exact root cleanup does **not** certify that
unknown descendants were contained or removed. The permanent uncertainty latch
prevents automatic recovery/replacement; there is no claim of atomic suspended
launch, universal tree cleanup after failed assignment, or a broad launcher
redesign. Real assigned-tree tests cover ordinary non-breakaway descendants only.

## Actual-source tests

```text
python tests/windows_job_checks.py --node-exe <pinned-node-24.21.0>
git -c core.autocrlf=false diff --check
```

The driver creates a fresh disposable directory; compiles the actual WinForms
candidate without launching it; compiles the native test entry with that same
source; then compiles/runs the existing 16-check TCP stand-in with the modified
supervisor. It never calls Config.Load, Program.Main, tray startup, packaging
build/install, real SSH, installed configuration or credentials.

Initial native criteria (69 assertions, before R2): create/setup failure before any child; false /
uncertain assignment without a success event; terminate false / exception;
close failure retaining handle; unconfirmed process exit; blocked timer/manual
replacement both before and after explicit cleanup; real root+descendant stop;
six successive real tree replacements with exact creation identities; ordinary
Process.Start failure retry and exact cleanup. Cleanup fallback is selected only
by recorded PID + start time and always fails a run if used. No broad cleanup is
allowed. Test summaries separately report native assertions, legacy TCP checks,
fallback use and owned cleanup. Windows-native evidence is Windows-only; Linux
is not counted as a native pass.

## Preserved development failures and fix

Initial native implementation passed 51 fault/lifecycle checks once but then
timed out in the old TCP fixture. A second run stalled during real restart. These
red runs remain preserved. Waiting with managed Process.WaitForExit while holding
the supervisor gate can conflict with Exited callbacks that also take that gate.
The corrected product waits on the already-held native process handle instead,
without invoking managed process-event machinery in that wait. An explicit
unconfirmed-wait test and six replacement cycles were added.

The test driver also writes child output to a real file, preserving partial
evidence without waiting for inherited stdout-pipe readers after a timeout. The
90 s native and 60 s TCP fixture ceilings were not increased. Exact final local
and CI results, candidate SHA/tree and CI checkout-tree comparison are recorded
on PR42 / issue38; no initial flaky pass is substituted for the final run.

## R2: delayed exit cannot release ownership early

[Review6230889950](https://github.com/GeeCeeSneaker/mcp-relay/pull/42#issuecomment-6230889950)
found a source-ordering hole at 4b1d7d5: a non-null exited root could be replaced
before its OnExited had cleaned the Job and descendants. The previous native
slice is not accepted merely because its 69 tests passed.

The product correction changes only Launch's predicate: any non-null process or
non-zero Job identity blocks launch, even if the root is already exited. Checked
cleanup must clear both identities first; failed cleanup remains latched.

The new actual-source Windows test uses a real root/descendant Job. It delays
only event-handler entry, then invokes the exact private product OnExited body.
After native termination of just the root, it proves that the descendant remains
alive and the exit callback is delayed. Eight public Start calls and eight queued
private Launch invocations per scenario must return without changing either
ownership identity or creating another Job. This is controlled event timing in
the compiled test, not a product scheduler, test hook or fake cleanup routine.

The successful-cleanup scenario verifies the old descendant and Job are gone
BEFORE the next native Create call. Win32 may reuse numeric handles after close;
the assertion checks before allocation rather than treating legitimate handle
reuse as a leak. The second scenario forces Terminate failure in the delayed
callback, checks retained old Job/descendant and no replacement, then explicit
exact cleanup and continued latch. There are 23 new assertions / two R2 cases,
so the full native count is 92; the unchanged TCP fixture remains 16 checks.

The unchanged product source at 4b1d7d5 fails the focused regression: both process
and Job identities changed, Create count grew from 1 to 2, and the old descendant
was still alive. The run fails explicitly. Emergency test-only cleanup reclaims
only recorded exact Job handles and PID/start identities; fallback_used=true
keeps the old-head run red even when cleanup succeeds. This evidence is preserved.
The corrected candidate must complete both scenarios with no fallback.

Focused command adds `--r2-only` to the command above; it does not run the full
fault/TCP suite. The complete workflow runs all 92+16 checks. Adding diagnostic
JSON windows initially exposed a driver summary-selector error after the native
assertions passed; the reader now selects the explicit native_checks record.
The full run is repeated after that harness correction, without changing budgets.
Exact final candidate/CI/readback is recorded on PR42/#38.

## Remaining boundaries

Serialized configuration/plan identity, stale/concurrent apply rejection, strict
optional paired ports and primary-preserving tunnel-only apply/restart/rollback
remain a subsequent implementation slice. The existing TCP stand-in is lifecycle
regression evidence, not that serialized protection or real SSH/central E2E.

No installation, promotion, merge, production access/restart, permission/network
change, Controller run, or RuntimeStore/#242/old-task operation occurs here.
Production deployment/PID/health/admission state is not refreshed by these tests.
Field object identities, direct Scheduled, normal central routing and full WO/M1
acceptance remain pending. Fresh platform turn context
`2026-10-17T06:35:03.318Z` records original developer `gpt-6.1-sol/high`, not a
Controller runtime attestation.
