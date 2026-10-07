# WO-0008 — Local SQLite Read Operations

- Status: `READY`
- Tracking: #35
- Program dependency: ADCP M1-A in `docs/30-execution-node-stack-implementation-plan.md` of the companion ADCP repository.

## Objective

Add the smallest generic, read-only SQLite capability family required for unattended structured inspection of local SQLite databases without falling back to arbitrary shell/exec.

This is a host capability. Do not encode ADCP RuntimeStore table names or workflow semantics.

## Scope

Implement under the existing read dispatcher:

- `sqlite_schema`
- `sqlite_query`

The implementation team may consolidate internal helpers, but the external semantics must remain small and structured.

## Contract

### sqlite_schema

Input:
- exact database path under an allowed file root;
- optional exact table/view filter.

Return bounded structured:
- database/SQLite metadata required for safe inspection;
- tables/views;
- columns/type/nullability/primary-key facts;
- indexes and foreign-key facts where available;
- observation/truncation facts.

No arbitrary PRAGMA passthrough.

### sqlite_query

Input:
- exact database path under an allowed file root;
- one SQL statement;
- positional or named parameters supplied separately from SQL;
- bounded `max_rows`, `max_bytes`, timeout.

Return:
- columns;
- structured rows;
- row count;
- truncation/timeout/partial facts.

## Mandatory safety

- open database read-only;
- query-only enforcement;
- extension loading disabled;
- SQLite authorizer or equivalent denies mutation/DDL/ATTACH/DETACH/writable PRAGMA/extension loading;
- one statement only;
- no filesystem/root escape;
- active WAL committed rows must be visible;
- read operation must not mutate DB/WAL/SHM content;
- malformed or unsupported operations fail closed.

Do not rely on SELECT-prefix string matching as the security boundary.

## Acceptance

1. ordinary SELECT returns structured values;
2. parameter binding works;
3. CTE/join read works;
4. INSERT/UPDATE/DELETE/DDL are refused with zero mutation;
5. state-changing PRAGMA is refused;
6. ATTACH/DETACH/extension loading are refused;
7. multi-statement SQL is refused;
8. row/byte bounds are deterministic;
9. expensive query timeout interrupts execution;
10. outside-root/reparse escape is refused;
11. committed WAL-visible rows are returned;
12. before/after DB/WAL/SHM evidence proves no content mutation;
13. existing read/write/destructive/exec tests stay green.

## Scheduled Task proof

Using a disposable SQLite fixture, compare:

- equivalent read via open-world exec/Python or sqlite CLI;
- `invoke_read/sqlite_query`.

Record whether each executes unattended, requests approval, is blocked before MCPRelay, or reaches MCPRelay and fails server-side.

The goal is a truthful read capability, not an approval bypass.

## Resource/minimalism gate

- no database daemon;
- no connection pool;
- no background watcher;
- no ORM/database abstraction layer;
- no SQLite writes/migrations/repair/backup;
- no multi-engine support;
- node idle CPU/RSS remains inside existing budgets.

## Exit

`DEV_ACCEPTED` when deterministic safety tests and the real Scheduled Task proof pass and the implementation remains a generic SQLite read family.
