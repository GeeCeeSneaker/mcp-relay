# WO-0009 engineering evidence

Frozen base/spec: a8910d390ba276a578d6b8f0ee2475430d28a909, task blob
17004e23fa5707992cd2b8861b646499082ecbd7. Owner engineering extension #6179266126.
Actual original platform selection: gpt-6.1-sol/high. Candidate node 2.5.2 and
Windows helper 1.1.0. This branch does not incorporate the unmerged SQLite
candidate/deployment; combining them requires an explicit reviewed exact head.

Development Status: **BLOCKED on required field proof**; isolated engineering
candidate delivered. Independent Review: **PENDING**. No live deployment,
production sampling or Controller execution identity is claimed.

## Smallest implementation

Existing read dispatcher exposes one process_usage capability. Four concurrent
requests maximum, interval 100..5000ms, fixed maximum 128 descendants, bounded
collector I/O and a 30s total deadline. The wait timer is cleared on abort and
completion. Transient existing Windows helpers are awaited through process exit;
no sampler service/thread, pool, metrics registry/store or new package dependency.
Neither collector sends signals to sampled processes.

Windows counters and creation identity come from the same native handle. Identity
and metrics paths omit command-line reads; limited access is explicit unavailable
data. The zero-time process-handle wait, not an undefined running-process exit
FILETIME, establishes exit state. CPU uses summed kernel/user seconds and working
set bytes. [GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes),
[GetProcessMemoryInfo](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-getprocessmemoryinfo).
Linux uses one proc stat record for identity/CPU/RSS and getconf-verified clock
tick/page units; missing getconf/proc/identity support fails explicitly. This
does not silently inherit the older list_processes conversion assumptions.

CPU rate is delta divided by the actual monotonic observation interval, as a
percent of one logical core. A tree is a sum of proven stable per-process rates
over their actual observation intervals; snapshots are not atomic. PID reuse,
parent/start changes, new/exited children or inaccessible counters make tree
totals null/partial, retaining only labelled proven observations. Sampling the
Relay process's own changing helper tree may therefore be partial.

## Acceptance mapping

### R1 correction after independent REQUEST_CHANGES

Review6179838833 / PM reconciliation6180110746 bind the original candidate
fb52d3b8f8dc533647ca1dae654b52508e24e5fd. That review is REQUEST_CHANGES;
the preceding handback's PENDING label was inaccurate. Only the independent
Reviewer can close the finding on the new exact head.

Linux EACCES/EPERM now fail the affected observation explicitly as
process_usage_unavailable, preserving the difference from ENOENT/ESRCH and Z/X.
An unreadable enumerated pid has unknown parent/start; it could be a descendant,
so a tree query conservatively fails even if that pid would in reality be
unrelated. It never yields a complete root-only tree or invents an exit. Single
root observations similarly fail on access loss in metrics or either identity
scan. No new scan, registry, state/output schema or persistent component.

Collector-level tests drive the actual proc parser/error classification/scans
using deterministic filesystem bytes and counter units, on both runners. They
cover persistent inaccessible child, EACCES/EPERM at each root scan/metrics
position, unknown membership, and preserved actual absence/zombie/dead semantics.
The injectable filesystem/units are internal factory arguments only, not MCP
inputs or runtime configuration. Before the correction: 3 failing collector
tests / 1 passing true-exit test. The final focused suite has 18 tests; exact
results and Windows/Linux CI belong in the PR/Issue handback.

Windows audit found the same conflation when GetProcessTimes failed after the
handle/creation observation. That branch now retains access=limited and missing
counters; only a signalled process handle marks exited. GetProcessMemoryInfo
failure already retains missing RSS. No Win32 counter-failure injection or new
permissions were used; source audit, compile and actual owned native exit/rate
fixtures are distinguished from the deterministic Linux collector negatives.

Command: `node --test tests/process-usage.mjs`, pinned Node 24.21.0 and the local
recompiled helper, disposable authenticated node/fixtures only.

| Frozen criterion | Evidence |
| --- | --- |
| 1 idle | Native owned fixture near-zero one-core CPU with RSS |
| 2 one-core busy | Native fixed single-thread workload; measured rate within 40..140% bound |
| 3 multi-child | Native and deterministic stable tree aggregation, tree >100% deterministic case |
| 4 unrelated excluded | Exact refs and native unrelated owned fixture excluded from sampled refs |
| 5 mid-sample exit | Native root/child exit and deterministic null completed-rate facts |
| 6 stale/reuse | Rejected stale ref; deterministic root PID and parent-PID/boot reuse negatives |
| 7 no leftover worker | Repeated native calls; helper absence checked independently, cancellation/admission |
| 8 semantic parity | Same deterministic contract; native Windows local result and exact-head Linux CI required |
| 9 genuine Scheduled | **PENDING/NOT ATTEMPTED** on this candidate; manual/local/delegated is not a substitute |
| 10 idle resource | Matched isolated base/candidate measurements below; no persistent additions |

Original fb52d3b8 local focused suite: **14 passed, 0 failed, 0 skipped**. One measured fixture
reported idle 0%, busy 99.95% of one logical core. Complete existing regressions:
legacy 37 + modern 37 + lifecycle 19 + Git 26 + extended 10 = **129 passed**,
all five commands exit 0, against an isolated fixture node.
Final exact-head Windows/Linux/hygiene CI status belongs in the PR/Issue after
authoritative readback, not guessed from local results.

Earlier red logs are retained privately: cancellation code exposed ABORT_ERR,
fixed to timeout; the test wrapper incorrectly assumed a nested process_info
record; helper-self inspection was not a valid no-leftover observation; exiting
before the native interval and signalCode cleanup were corrected in the fixture.
An after-hook failure left the test host active; only its exact PID/start,
executable, parent and test command were verified/stopped via the existing helper.
No old task/service or name-based batch termination. Assertions were not skipped.

## Isolated resource scope

Paired approximately 31s samples, exact owned PID/start checked at both ends,
same pinned Node/dependencies/setup. These are short fixture measurements, not
production/full-host/Scheduled or soak evidence.

| Fixture | CPU, one core | Node RSS | Threads | Idle child |
| --- | ---: | ---: | ---: | --- |
| accepted base | 0.504% | 66.36 MiB | 13 | console host |
| candidate | 0.252% | 66.45 MiB | 13 | same console host |

One representative usage call observed 78.52 MiB for node plus owned children;
sampling can miss a very short-lived helper, so this is not a peak-memory claim.
Post-call node RSS 71.37 MiB; only the console child remained. Resource script
observed an owned disposable target, never an Owner production target. The last
native exit-guard correction changes active helper checking, not node idle code.

## Remaining delivery/field gate

Independent exact-head review first. Any deployment must separately identify
the node/helper/module bytes, integration with existing unmerged work, backups,
original lifecycle and bounded disposable target scope. Genuine Scheduled read
proof is still required. If the supported central caller cannot execute directly,
record NOT ATTEMPTED and request an explicit acceptance-scope decision; do not
add an adapter or relabel local evidence. No merge/deployment permission is
implied by this engineering result. WO-0008 fixture/rollback, live stack and
ADCP store/old runs remain untouched.
