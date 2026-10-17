# WO-0010 serialized tunnel configuration candidate

Scope: PR42 continuation authorized by independent review comment
6231204282 at head e6cc3ab90447e3f718036fe7ab4c446a0dfe8b67.
NO-INSTALL. This is source / isolated Windows evidence, not field acceptance.

## Product action and identities

The existing tray has one **Apply tunnel-only config** action. Select a separate
proposed config JSON; every setting except `secondLocalPort` / `secondRemotePort`
must remain semantically equal, including unknown fields. Both fields absent,
or both integer zero, preserve the legacy single forward. Otherwise both must
be JSON integers in 1..65535, with neither local nor remote port duplicating
the primary pair. Strings, floats, booleans, null, half pairs and mixed zero
pairs fail before process changes. No arbitrary forward array or host override.

Preparation hashes actual UTF-8 file bytes and a versioned serialized SSH
argument plan. Its serialized receipt binds old/new config hashes, old/new
plan hashes and exact node/tunnel PID + UTC start ticks. Apply requires the
expected receipt hash, re-reads both actual files under exclusive Windows file
handles, checks their hashes, the active plan and both process identities.
Concurrent apply/prepare rejects; writers cannot mutate either locked file.
Replay or drift refuses before stopping the tunnel. The UI displays receipt
and plan hashes and warns that primary TCP sessions disconnect.

The primary `-R`, SSH identity/host-key checks, authentication options, keepalive,
connection timeout and ExitOnForwardFailure remain exact. Only one extra
loopback `-R` is appended on the same SSH connection. The node is never restarted
by this action; its PID/start identity must remain equal through commit/rollback.

## Replacement and rollback

The action retires the old supervisor by exact identity and waits for its checked
process/Job release. It then creates a supervisor for the new immutable plan in
the existing tunnel role. This refines the earlier packet's prospective direct
`tunnel.Restart()` approach: a distinct supervisor with retries initially disabled
prevents a pending old callback or a failed candidate's retry from competing
with rollback. It adds no permanent process, tunnel, daemon or registry.

Candidate readiness uses the existing SSH authentication marker with the
existing two-second stabilization rule. This is not server-side forwarding or
central MCP health proof. The node identity is also checked. Each readiness or
release wait is bounded (20 seconds in the tray); existing native stop calls
retain their two-second wait. These budgets are not a measured WAN disruption SLO.

Only after readiness does apply write/flush/read back the proposed bytes using
the held file handle, then enable ordinary retry for the exact candidate.
Previous bytes remain in the immutable in-memory snapshot for rollback; no
extra configuration database/cache is created. A failed start or write permits
one rollback only after candidate release, exact old file restoration/readback
and unchanged node identity. The rollback itself starts with retries disabled.
Failed/uncertain old stop, candidate stop, restoration or rollback latches a
visible blocked state, preventing maintenance/replacement attempts. Failure
details and receipt identity go to the existing app log. Quit can still clean
up owned Jobs; this action never searches by process name or kills unrelated PIDs.

Writing under a held handle preserves the existing file/ACL and excludes
concurrent writers; it does not claim crash-atomic persistence. Power loss / app
crash during write is not proven here. The field packet still requires private
exact-byte backups and an operator recovery plan before installation/trial.

## Reproduction and failure evidence

On Windows with .NET Framework csc and Node 24.21.0:

```
python tests/windows_job_checks.py --node-exe <exact-node-exe>
```

The driver compiles the real tray source without launching the tray, Config.Load
or installed services. It runs the retained 92 native ownership assertions
(including both R2 delayed-exit cases), 16 earlier TCP checks and the new
serialized tests against real temporary config files, native Job Objects and
disposable loopback Node children. Test-local native/file-write faults cannot
be enabled through product config, environment or a global override.

New checks cover strict pair parsing/legacy bytes, serialized receipt/plan
hashes, active/proposal drift, unrelated-setting and process-identity drift,
replay/concurrent refusal, actual writer exclusion, add/remove/same-plan restart,
node preservation, safe failed-start rollback, failed/uncertain old exit,
candidate ownership/stop, rollback stop and partial-write/restoration failures.
Every fixture checks exact recorded owned PID/start identities are gone without
fallback kill. TCP children are explicitly not SSH/MCP E2E.

The first development run exposed a test synchronization error: its concurrent
prepare helper waited in the Active getter before reaching the checked entry.
The helper now supplies its pinned expected hashes directly, exercising actual
concurrent refusal. Product behavior was not weakened to make that test pass.
Exact final counts/head/tree, local result and CI readback belong in the PR/#38
receipt, so this document does not assert an unobserved CI result.

R1 gateway regression stays intact. No merge, install, live restart, credential,
permission, server row or network change is included. Central Scheduled, SSH/MCP
field E2E/resource proof and WO/M1/M1.5 acceptance remain separate pending gates;
live Issue43 and Controller activation are outside this candidate.
