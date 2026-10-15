# WO-0010 — isolated design for scope review, not product promotion

This continues PR42 / issue38 under review6180454036, PM6180464364 and
ADCP282 checkpoint6180470481. Original gpt-6.1-sol/high executor. The accepted
gateway source, production patches, node/tray/installer code and live config
are unchanged. `tests/routing_schema_proposal.py` is an explicit opt-in fixture
assembly only. Even strict prototype green leaves full WO acceptance BLOCKED.

## Coupling isolated

1. Installed MCP2.3.0 modern server header validation falls back to global
   tools/list to obtain one input schema. The original authenticated Request is
   available through FastMCP's documented get_http_request helper inside that
   synthetic listing. The fixture verified its cached body distinguishes an
   actual tools/list from the schema lookup for tools/call.
2. ClientSession.call_tool also runs validate_tool_result. A new session without
   an output-schema entry refreshes the global tools/list after the tool result.
   Thus call_tool_mcp does not eliminate all client-side catalog discovery.
3. Default ProxyProvider lookup cache TTL is300s, not proof of backend liveness.
   A cached descriptor can let an unavailable backend reach the long execution
   retry path. Metadata and execution using one client/factory also retain
   concurrent failure coupling in the reproduced composition. Exact contribution
   of transport/factory/drain remains an inference; do not call it a proved
   single serialized writer (the SDK spawns concurrent request POST tasks).

The first scoped-schema/catalog-timeout proposal completed54 strict cases with
18 failures; a method-selected HTTP transport variant still had15 failures.
Successful but ~3s-delayed calls and 8s bad-call timeouts were retained as failures
against the fixture thresholds. Private logs/source archive are preserved; no
assertion weakening, timeout inflation, skip or xfail. A fixture startup collision
from reusing one encrypted scratch DB for cold/warm trials was corrected with a
unique DB/config per trial; this was a harness defect, not routing evidence.
The delayed-execution control initially used an unsupported cwd argument and
was rejected before execution. It now uses the documented start_process schema
and changes directory inside its literal fixture command; the delay/output
assertions are retained.

Scope review6181342660 / PM6181357563 adds compatibility C1 and specific
negative-evidence requirements. The fb8 candidate's Windows strict CI retained
54/56, with both real-execution expected-result failures (7.485/7.141s <8s),
while Linux retained56/56. That job did not publish the private command result;
its root cause is not established. The revision retains that same PowerShell
command, wait and threshold, prints only MCP error/marker/exit/running facts,
and strengthens completion to exit0. A discarded cmd/Node timer experiment
failed locally with shell syntax exit1; it is not the candidate command.

## Exact proposed delta

The current test-only proposal uses public FastMCP Middleware, get_http_request,
Context.fastmcp.get_tool, FastMCP.add_provider, the documented Provider
_list_tools extension, ProxyTool.from_mcp_tool and Client.new APIs. Source/dependency
bytes remain pinned by routing-gateway-source.json and routing-requirements.txt.
No private provider cache or low-level SDK schema callback is overwritten.

- For synthetic schema discovery, resolve only the selected namespaced tool in
  the existing authenticated/session-transform context. The outer default schema
  dereference and SDK Mcp-Param validation remain active.
- Use a marker on this HTTP Request.state, never a session/database/global cache,
  to record verified schema/name. Because the SDK can swallow schema-list errors,
  on_call_tool refuses a modern nonempty/header-bearing call lacking that marker.
  Unknown schema cannot turn into later unvalidated execution after reconnect.
- Compose a Provider that makes a fresh metadata listing per lookup. Each uses a
  new short-lived NoForwardStreamableHttpTransport client, no connection retries,
  fixture connect250ms/read2s/overall metadata3s bounds. Metadata and execution
  share the same configured backend credentials, not the caller's credentials.
- Construct raw ProxyTools from the backend listing using the existing execution
  factory BEFORE namespace/rename/session transforms. Standard get_tool/version,
  middleware/interceptor and tool._run dispatch remain responsible for execution;
  no middleware reconstructs an already-resolved tool or skips call_next. Execution
  transport6 connection retries and read allowance remain unchanged. Metadata
  budgets do not apply to a real tool's execution.
- A real full tools/list still discovers each backend, with bounded omission on
  metadata timeout. Arbitrary exceptions are not swallowed by the proposal. A
  metadata catalog is not a liveness/complete-node assertion; bearer connected
  remains authentication configuration only.
- Reject overlapping namespace prefixes before assembly. Preserve the existing
  generic alias; a temporary `probe_<node>` avoids `<node>` / `<node>_probe`
  overlap. This proposed configuration restriction needs scope review.

If promoted after review, the exact insertion points are inside the existing
gateway integration/patch mechanism: the build_gateway per-backend proxy block
and one request middleware registration after gateway creation, with the scoped
implementation in a small internal module. The fixture substitutes the existing
factory symbol only during assembly and restores it afterward. It does not edit
or install that production delta. No new MCP method, registry, tunnel protocol,
service/proxy process, telemetry loop, workflow/store or Controller semantic.

Minimalism: temporary metadata sessions add handshake/connection work, not a
resident process or persistent schema cache. The extra work must be weighed
against the measured latency/resource evidence; it is not free. Current proof
uses bearer backends only: OAuth/headers/none fail before assembly. Versioned
backend descriptor metadata and explicit version requests also fail closed;
this lane deliberately proves unversioned tools only. Provider composition serves
tools only, not resources/prompts. Replacing FastMCPProxy convenience assembly
also needs review of its metadata/legacy ping/discover behavior before product
adoption. TLS/custom transport and actual WAN budgets remain compatibility gates.
The scoped marker and adapters' auth/enabled/version/middleware semantics are
part of independent review, not assumed equivalent merely because these tests
pass. These are explicit unresolved promotion gates, not live authorizations.

C1's execution short-circuit is removed. Pinned-package positive rename dispatch
and negative middleware/extension interception prove original backend identity
and zero backend execution at those gates. Denied/disabled/missing-auth/unknown
tests use the pinned server's actual get_tool/call_tool checks, not a fabricated
authorization result. Version and auth exclusions are enforced with negative
tests. This narrowed tool-only prototype still does not authorize substituting
the whole production proxy or silently dropping resources/handshake semantics.

## Strict tests now prepared

```sh
# Preserved stock-path diagnosis; always reports full WO BLOCKED.
python tests/backend-routing.py --gateway-source <fixed-source> --sample-seconds 30 --diagnostic-only
# Opt-in proposed assembly, all failures retained; nonzero if any strict case fails.
python tests/backend-routing.py --gateway-source <fixed-source> --sample-seconds 30 --schema-scope-proposal --strict-matrix
```

The matrix covers sibling unavailable before first gateway discovery and after
discovery; existing and fresh frontend sessions; healthy reads alone and alongside
failed reads; two outage/reconnect cycles per scenario; bounded catalog and schema
failure; invalid bearer401; malformed arguments; matching/mismatched annotated
Mcp-Param headers; canary/no-token passthrough; exact owned creation identity on
restart. Prototype unit negatives separately cover prefix rejection before
assembly and missing schema refusing execution. A controlled self-ending4s
generic command in this fixture's allowed temp root checks that a metadata2/3s
deadline does not cut execution. It is not a Controller/production exec proof.
Additional pinned tests force simultaneous separate HTTP-request marker state,
failed schema lookup then backend recovery, missing schema auth, and unsupported
auth/version refusals. A real disposable backend accepts HTTP but stalls tools/list;
its private event counts prove started/closed metadata requests and zero tool
executions on refusal/cancellation. Healthy sibling calls keep the same bound.
Caller cancellation and subsequent bounded backend closure are distinct facts;
this does not claim instantaneous transport abort or WAN cancellation semantics.

Five healthy samples establish a same-fixture baseline. Healthy acceptance bound
is max(750ms,5x baseline maximum), with an environment ceiling2s; a slow baseline
fails preparation rather than raising the bound. Failed backend/catalog/auth
checks use4s, a bounded fixture regression goal. The SDK watchdogs8/10s allow a
failure to be measured but never make it pass. These are justified isolated
thresholds, not production/WAN SLOs. Matrix output lists each actual elapsed,
threshold and pass/fail; mode cannot combine strict with diagnostic-only.

All cleanup is exact owned Popen handles, continuing cleanup attempts after one
error. No production/name-scan stop. Resource windows and observations remain
isolated/finite, not peaks, host totals, soak, SSH keepalive or field acceptance.
Final exact-head local/Windows/Linux counts and timing belong in PR/issue handback.

## Disposable transport/field plan — NOT execution-ready or authorized

The source inventory identifies the exact integration objects:

| Object | Known source responsibility | Required live fact / action gate |
|---|---|---|
| G0 generic gateway entry | Existing named URL/auth mapping | Current alias/URL/config bytes, retained unchanged |
| G1 temporary probe entry | A new non-overlapping named backend | Exact approved remote loopback port and fixture auth reference |
| F0 existing SSH forward | MCPRelay.cs StartServices, single LocalPort/RemotePort `-R` | Current connection PID/start and exact forward |
| F1 temporary second forward | Proposed second `-R` on the same connection | Exact local/remote ports, collision check and supported lifecycle |
| K0 current restricted node-key row | vps-install.sh emits one loopback PermitListen | Owner/operator sanitized row identity and exact second-port permission |
| L0 launcher config | Config has one LocalPort/RemotePort pair | Narrow reviewed representation/application of second forward |

The current Windows launcher cannot express F1 in configuration. A second
gateway entry alone does not create it. Proposed transport diff is precisely one
additional loopback reverse forward on the existing connection and one additional
loopback PermitListen on K0, plus G1; G0/F0/public ingress stay unchanged. No
PermitListen wildcard, extra key/account, permanent tunnel/proxy, public inbound
port or Controller endpoint. Standard repeated-forward compatibility and actual
launcher integration are pending proof; do not claim current config supports them.

Before any field action, Reviewer must approve an explicit combined candidate /
version (including any WO8/WO9 integration) and this product/compatibility delta.
An authorized operator must supply fresh sanitized G0/F0/K0/L0 identities and
exact ports/forward/config diffs, plus a read-only collision/lifecycle inventory.
Engineering scope does not authorize collecting Owner credentials or applying
those changes. There is no substitute fabricated value from historical state.
If fixture auth material is not already approved, Owner must specify its bounded
handling first; no new credential is created by this plan.

Then request an exact bounded field authorization, at most15min/two probe cycles:

1. Seal private rollback copies/hashes of exactly the affected config/launcher
   and restricted row; record current PID/start, generic health and fixture/WO8
   preservation facts. Do not read or copy ADCP RuntimeStore/old-run data.
2. Start only the owned disposable one-read-tool probe, record exact PID/start,
   marker/protocol and loopback bind. Apply only the reviewed F1/K0/G1 diff.
3. Preserve the generic node process. If existing lifecycle cannot update the
   tunnel without restarting that node, stop and return that exact blocker;
   do not quit the tray/redeploy modules under inferred authority.
4. Normal central client must actually discover/call G0 read and
   `probe_<node>_probe`; prove class/header/auth, same-node/second-backend identity,
   sibling outage isolation, exact owned restart/reconnect and full transport
   loss distinction. Generic shell/exec or delegated/local SDK is not a substitute
   for the required supported normal-central proof. Missing registration/access
   is reported, not bypassed. No Controller dispatch or Scheduled-proof waiver.
5. Collect exact relay/gateway/fixture finite resource and actual network/keepalive
   evidence with approved read capabilities. No broad production sampling.
6. Restore G1/F1/K0 to exact before bytes/state, stop only the owned probe, verify
   G0 health and original identities/fixture preservation. If any identity or
   permission/config drift occurs, abort affected actions; never batch-kill or
   overwrite unowned changes.

Missing today: fresh live object identities/ports, approved integration/product
head, second-forward launcher compatibility, exact permission/lifecycle change
authority, approved fixture auth and supported central registration/caller proof.
No pending action is silently approved. M1.5 reconciliation, M2 snapshot and M3
Mode B remain behind their existing gates. **Next: independent scope review of
this exact test-only design/delta and strict evidence before product promotion.**
