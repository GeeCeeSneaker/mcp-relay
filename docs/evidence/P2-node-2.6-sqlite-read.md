# WO-0008 — SQLite read engineering evidence

Development Status: **BLOCKED on field proof**, engineering candidate delivered.
Independent Review: **PENDING**.
Frozen base/spec: `a8910d390ba276a578d6b8f0ee2475430d28a909`.
Execution selection: platform-attested `gpt-6.1-sol/high`, under the bounded
Owner authorization on Issue #35. No Controller execution identity is claimed.

## Implementation and minimum necessary

Node 2.6.0 adds `sqlite_schema` / `sqlite_query` to the existing read dispatcher,
without changing the fixed five-tool MCP surface or ingress/authentication.
The existing allowed/protected/read-only root policy applies to the database
and native companion names. The caller supplies data only, never a program,
extension, URI option or PRAGMA passthrough.

The pinned Node 24.21.0 already supplies SQLite 3.53.4, authorizers and limits.
No npm/runtime dependency was added. The connection uses read-only,
query-only, defensive/untrusted-schema settings and disabled extensions.
Only read authorizer operations are accepted; fixed schema metadata is internal.
SQLite's parsed statement source rejects a second statement before stepping.
Parameters are bound separately. Output, native/V8 memory, SQL size, schema
entries, concurrent readers and wall-clock duration are bounded.

Each read owns one temporary Node process with a temporary native-query thread:

- synchronous native SQLite must not block the resident event loop;
- a fresh process avoids sharing a writable WAL mapping;
- `readonly_shm=1` preserves committed WAL visibility without changing SHM;
- the responsive supervisor exits on parent disconnect or deadline, while the
  parent also enforces its deadline and waits for reader exit before returning.

The initial disposable-fixture probe proved that readOnly/query_only alone can
change SHM bytes. Both the reader timeout and node-exit regression prove cleanup.
There is no database daemon, pool, copy/backup, write/repair, background watcher,
new control plane or persistent correctness record. At idle no SQLite reader
process/thread exists. Packaging includes both new modules.

Primary references: [Node SQLite API](https://nodejs.org/api/sqlite.html),
[SQLite WAL read-only behavior](https://sqlite.org/wal.html#read_only_databases).
Those references explain the substrate; the following tests establish this
candidate's behavior, including its WAL-file preservation.

## Deterministic acceptance mapping

`node --test tests/sqlite-read.mjs` runs a disposable authenticated loopback node
and databases, with no deployed endpoint/database involved.

| Frozen criterion | Passing check |
| --- | --- |
| 1 structured SELECT | columns/rows, nulls, exact large integer/blob/non-finite real values |
| 2 bindings | positional/named values and injection-shaped data |
| 3 CTE/joins | join result and exact schema table/view/index/FK metadata |
| 4 writes/DDL | INSERT/UPDATE/DELETE/DDL/VACUUM/transactions/CTE writes refused; no mutation |
| 5 PRAGMA | changing PRAGMAs and table-valued bypass refused |
| 6 ATTACH/extensions | ATTACH/DETACH/load_extension/file functions refused |
| 7 one statement | SQLite source boundary, quoted semicolon, comment and second-statement cases |
| 8 bounds | deterministic rows/bytes/schema and invalid/oversized limits |
| 9 timeout | expensive native query interrupted; resident stays responsive |
| 10 paths | outside/protected/URI/reparse database and companion refusal |
| 11 active WAL | committed rows not yet checkpointed returned |
| 12 no mutation | DB/WAL/SHM hashes, sizes and mtimes identical; read-only root |
| 13 regression | both protocol eras and existing read/write/destructive/exec suites |

The final local suite passed **18/18** checks. Five further cases cover malformed/missing databases, two-reader admission,
unauthenticated requests, locked databases and node exit during native execution.
No skips/xfails. All local commands used the selected Node 24.21.0 executable;
fixture paths below are intentionally sanitized.

Existing regression commands against a separate disposable fixture node:

- `node tests/mcp-smoke.mjs ... --era legacy --destructive-ok`: 37 passed.
- `node tests/mcp-smoke.mjs ... --era modern --destructive-ok`: 37 passed.
- `node tests/process-lifecycle.mjs ...`: 19 passed.
- `node tests/git-ops.mjs ...`: 26 passed.
- `node tests/compare-ext.mjs ...`: 10 passed.

All five commands exited 0. The first local runner incorrectly put audit logs
at the fixture parent, making that parent read-only under the existing guard.
Separating the audit directory corrected the fixture; no product guard or
assertion was weakened. CI runs the new SQLite suite on Windows and Linux in
addition to the existing acceptance workflow; exact PR checks are reported in
the PR/Issue rather than asserted before CI executes.

The first Linux CI passed the first 17 SQLite checks but the final exit check
treated any extant PID as running. The revised check records the exact Linux
start identity and accepts an unreaped zombie only when its state is `Z`, its
resident pages are zero and CPU ticks remain unchanged. A live native reader
still fails. This distinguishes execution exit from PID 1's later OS reaping;
the exact observed state and final result must be read back from revised CI.
That diagnostic revision confirmed the reader was still live on Linux, rather
than an unreaped zombie: `process.exit()` waits for native worker termination.
The supervisor now uses an OS kill of its own temporary process on parent
disconnect/deadline, which interrupts the native thread. Revised two-platform
CI must establish this fix; no deployed process was operated.
The first Windows CI exposed an 8.3 TEMP alias in the fixture's declared root.
The fixture now declares its canonical real path, as the existing guard requires;
the production root policy is unchanged. Revised CI must verify the whole suite.

## Isolated resource evidence

An exact owned PID/start was verified before and after each approximately
31-second idle sample. The unchanged base and candidate used the same pinned
Node, dependencies and disposable setup. CPU is percent of one logical core.

| Node fixture | Idle CPU | Node RSS | Threads |
| --- | ---: | ---: | ---: |
| accepted base (2.5.1) | 0.051% | 73.65 MiB | 13 |
| candidate (2.6.0) | 0.202% | 74.20 MiB | 13 |

Both have one identical console-host child and no idle SQLite reader.
A representative bounded native query observed 153.65 MiB for the node plus
owned children; after completion only the console-host child remained.
Post-call node RSS was 78.51 MiB. These short, isolated node measurements are
inside the existing node budgets; they are not production/full-stack/VPS soak
or Scheduled Task evidence.

## Required proof still pending

The real Scheduled Task comparison of open-world exec versus
`invoke_read/sqlite_query` has **not** been executed. The engineering
authorization excludes merge, deployment and production service lifecycle.
The deployed node has not been replaced to make this candidate remotely callable.

Return the exact PR/head for independent engineering review. Then arrange a
separately authorized, bounded candidate deployment and disposable Scheduled
Task fixture proof, including resource non-regression on that deployed path.
If exec is refused, record that boundary without another wrapper or retry.
Do not mark the whole WO DEV_ACCEPTED or claim unattended access until this
required evidence exists. WO-0009/0010 and ADCP runtime remain outside this work.
