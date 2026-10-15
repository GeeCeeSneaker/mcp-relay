# WO-0010 — isolated composition diagnostic, acceptance BLOCKED

The subsequent [design/strict-test/field plan](P2-backend-isolation-design.md)
continues review6180454036. Its opt-in prototype is not a promoted gateway patch.

Original executor: **gpt-6.1-sol / high**, verified from current platform turn
metadata. Owner engineering-only extension: issue #38 comment 6179267237.
Frozen base: `a8910d390ba276a578d6b8f0ee2475430d28a909`; WO blob
`3598857f08d2b804493903dbd33afe44f10d5da6`. Independent review is PENDING.
This document describes isolated execution, never normal-central or Controller
dispatch. No product routing patch is implemented or deployed.

## Reproducible composition

`tests/prepare-routing-gateway.py` downloads a fixed public archive, extracts
only 19 whitelisted package files, verifies every raw Git blob SHA/size against
`tests/routing-gateway-source.json`, and applies only existing accepted patches
0001/0002 with `git apply --check`. It refuses an existing destination. Upstream
is [59c1efd00e0c1baea4ed7861429200d2d6be0e83](https://github.com/R0Wi/mcp-gateway/tree/59c1efd00e0c1baea4ed7861429200d2d6be0e83).
Anonymous source preparation was tested independently in a fresh directory.
No authenticated Git fetch or local GitHub credential inspection is involved.

The test-only Python input pins the fixed package's minimum direct versions;
`routing-requirements.txt` locks all transitive versions and distribution hashes.
Actual local versions: Python3.12.14, FastMCP4.0.5, MCP2.3.0, FastAPI0.141.1,
Uvicorn0.52.4, Node24.21.0. Existing generic node2.5.1 and its unchanged runtime
lock are used. Production component inventory/dependencies/versions are unchanged.

One trial runs the gateway + generic node. Another adds one disposable loopback
server with exactly one read tool. Every listener explicitly binds loopback.
The existing gateway's named-backend configuration is sufficient to mount both:

```yaml
backends:
  fixture_node:
    url: http://127.0.0.1:<generic-port>/mcp
    auth: {type: bearer, token: <synthetic-generic-token>}
  fixture_backend:
    url: http://127.0.0.1:<probe-port>/mcp
    auth: {type: bearer, token: <synthetic-probe-token>}
```

Stable tool names are `fixture_node_invoke_read` and `fixture_backend_probe`.
These are flat gateway namespace keys, not a new node/backend registry or
hierarchical identity API. All authentication, OAuth clients/user, storage,
ports, targets and logs are newly isolated synthetic fixtures. No Owner account,
credential or production state is read. Temporary child environments whitelist
only system/runtime/temp variables and explicit fixture inputs. Private logs and
state remain private; public output records aliases, result classes and counts.

```sh
python -m venv <test-venv>
<test-python> -m pip install --index-url https://pypi.org/simple --require-hashes -r tests/routing-requirements.txt
npm ci --prefix node-runtime --no-fund --no-audit
<test-python> tests/prepare-routing-gateway.py --out <fresh-source-directory>
# Diagnostic: collect the known timeout and recovery; exit 0 is NOT acceptance.
<test-python> tests/backend-routing.py --gateway-source <fresh-source-directory> --sample-seconds 30 --diagnostic-only
# Strict: unhealthy generic route is an assertion failure/nonzero exit.
<test-python> tests/backend-routing.py --gateway-source <fresh-source-directory> --sample-seconds 30
```

Optional `--node-exe` selects a known Node executable. Windows runs hide fixture
windows; cleanup waits/signals only the exact `Popen` objects this invocation
created. No PID/name scan, existing process stop, port forwarding or resident
fixture is introduced. Use an isolated test environment with user pip config
disabled (`PIP_CONFIG_FILE` = platform null device), as diagnostic CI does.

## Findings and limits

Unauthenticated MCP is rejected with HTTP401. The actual existing gateway OAuth
code/PKCE/login/consent/token flow works in the isolated app, rather than an auth
stub. Authenticated catalog/reads use the public gateway boundary of that app.
The probe validates its own expected upstream bearer token; caller authorization
and a canary header are not forwarded. A direct-call positive control proves
the canary detector can see a header when actually supplied. Both namespace
calls return the deterministic expected results before the outage.

Stopping only the owned probe reproduces healthy generic-route timeout. A
direct generic read still succeeds. A later controlled run makes the healthy
gateway call **alone**, before a failed probe request, so concurrency is not
required. Disjoint namespace keys reproduce the finding too. Earlier runs used
the convenience `Client.call_tool`; original raw `Client.call_tool_mcp` retains
the timeout, including a fresh frontend session for each outage observation.
Timeouts may surface as an SDK request-timeout code or a transport read-timeout;
the diagnostic recognizes only those specific failures across the entire client
context. Unexpected errors remain failures. No client result-parser workaround or timeout increase establishes
isolation acceptance.

Private coroutine-stack diagnostics on unchanged product code show:

```text
modern MCP request -> _mcp_param_rejection -> _tool_input_schema
 -> serve_one(tools/list) -> FastMCP.list_tools -> AggregateProvider._list_tools
 -> ProxyProvider._list_tools -> backend Client.list_tools -> pending request
```

Installed MCP2.3.0's modern transport uses the entire `tools/list` fallback to
resolve the called tool's input schema when no `get_tool_input_schema` hook is
set. The existing gateway proxies all named backends; accepted patch0002 retries
backend connection establishment six times. This establishes the schema/catalog
coupling and observed wait; the exact retry/drain timing contribution needs
review. The healthy HTTP200 in gateway logs alone is **not** a completed tool
call. The client bound is 20 seconds (outer watchdog22); it is a diagnostic
bound, not a newly frozen project SLO. Architecture-added seconds remain a concern
under RESOURCE_BUDGETS even on a platform where retries finish before that bound.

`gateway_status.connected` for configured bearer/header backends means configured
authentication is present. It can remain true while the backend is stopped; it
is not a health signal. The diagnostic checks that fact and existing gateway
metadata reachability, then restarts only the exact owned probe with a different
creation identity. Recovery assertions use the same configured URL/namespace and
gateway session. Any unrelated error or recovery failure still exits nonzero.

| Required proof | Isolated finding | Full WO gate |
|---|---|---|
| Generic backend reachable | Works before outage; direct control works after | BLOCKED by gateway isolation observation |
| Deterministic second namespace | Configured catalog and read work | Normal central/tunnel NOT RUN |
| Backend unavailable vs node unavailable | Probe exit known, gateway/direct generic alive; auth-status is not health | Whole-node/tunnel outage NOT RUN |
| Restart/reconnect | Exact owned restart tested by diagnostic | Normal central/tunnel NOT RUN |
| Failure isolation | Reproduced timeout/delay, retained as defect | BLOCKED |
| No new public inbound port | All fixture binds loopback; no live change | Live second route NOT RUN |
| Existing authentication boundary | Real isolated OAuth401/PKCE and no passthrough | Normal central NOT RUN |
| Sanitized node/backend/call evidence | Namespaced tool/outcome/latency, expected marker, private correlated logs | Field audit NOT RUN |

The final PR/Issue handback records exact-head local and Windows/Linux diagnostic
observations and ordinary CI separately. Diagnostic green means the measurement
harness completed: its JSON retains `wo_acceptance: BLOCKED`. It does not assert
the failed isolation criterion, full E2E, DEV_ACCEPTED or M1 exit passed.

## Resource evidence

One 30-second isolated Windows observation: gateway+generic **2 temporary
processes**, CPU0.260% of one core, RSS70.93MiB; with probe **3 temporary
processes**, CPU0.312%, RSS136.26MiB. Idle logged HTTP request delta0 in each
window. These are process-level finite observations including the temporary
gateway, not peaks, a soak, production host totals or network packet captures.
No SSH tunnel exists in this fixture, so keepalive/network field proof is NOT
RUN. Permanent process delta is0; the probe adds one temporary test process only.
No daemon, sampler, scheduler, proxy category or persistent Controller state is
added. Exact final-head numbers appear in the handback/diagnostic job output.

## Return to review

Do not deploy this diagnostic as a routing fix. The smallest candidate direction
is to bound discovery/connect waiting **per existing backend**, preserving full
MCP request-header/schema validation and upstream credential isolation. Review
whether supported provider/middleware APIs can implement that without global
failure coupling; do not disable validation, invent a synchronous cache hook that
loses authorization context, add a registry/proxy, or merely enlarge client
timeouts. This is a proposed direction, not an implemented patch or proven fix.
The frozen WO requires field evidence before product routing code; this isolated
finding is returned for an exact supported seam/acceptance decision.

Source also confirms existing Windows configuration has one LocalPort/RemotePort
pair and one reverse forward, while installation generates one loopback
PermitListen per node key. A second gateway entry alone does not establish a
second backend route. Any live additional forward/PermitListen/config change
requires a separate exact plan, backup/rollback and Owner authority. No public
ingress, permission, credential, tunnel, deployed module/service, ADCP store or
old-run action occurred. WO-0008 candidate/deployment/fixtures stay untouched.

**Unique next step:** independent Reviewer inspects this exact diagnostic head,
reproduced isolation finding and CI; PM then freezes the smallest supported
remediation/field-proof contract before authorizing product changes or live E2E.
