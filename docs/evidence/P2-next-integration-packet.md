# WO-0010 product/config scope packet — proposal, not promotion

Authority: PR42 independent re-review6181803479 / PM Issue38 handoff6181806555.
The narrow prototype at5b10bf99a2ebc9965fc8425f414604a3d23c8e4d is accepted
only as test evidence. This continuation adds design and new isolated compatibility
checks. It does not install a product patch, change live configuration, close
WO-0010, or authorize credentials/permissions/services/Controller operations.

## One proposed product delta

Retain existing gateway, upstream package, loopback SSH and tray supervisor.
Use the existing gateway patch/bundle mechanism after scope review. No new
service, registry, schema cache, configuration database, custom protocol or poller.

| Prospective file, not modified by this candidate | Exact intended seam |
|---|---|
| patches/mcp-gateway/0003-bounded-metadata.patch | Applies after0001/0002 to the same fixed upstream commit; introduces the following small internal gateway changes |
| upstream src/mcp_gateway/config.py: BackendConfig | One boolean `isolate_metadata: false`; opt-in only, no change to existing backend defaults |
| upstream src/mcp_gateway/gateway.py: build_gateway per-backend block | Keep current FastMCPProxy for every non-opted backend. For an opted backend, add a mounted FastMCP plus the proposed component provider; retain the current persistent execution factory |
| upstream src/mcp_gateway/bounded_metadata.py | The request-local schema guard plus fresh bounded metadata provider, with all four raw component families. Internal, mounted-only helper; no independent server entrypoint |
| upstream src/mcp_gateway/upstream.py: client construction | Construct metadata client from the same reviewed transport settings; no token passthrough and no arbitrary transport reconstruction |
| app/windows/MCPRelay.cs: Config, tunnel argument closure and one tunnel-only apply action | Optional single second loopback port pair, validated before side effects; restart only the existing tunnel supervisor |

The two prospective launcher fields are `secondLocalPort` and `secondRemotePort`.
Both absent/zero means the exact old single-forward representation. Both must
be integers1..65535 when present. A half pair, duplicate remote listener or
duplicate local backend port fails before a restart. Bind/target hosts stay
literal127.0.0.1; no caller-supplied host, destination, SSH option or arbitrary
forward array. The existing primary LocalPort/RemotePort remains authoritative.

Proposed configuration shape (placeholders are not deployable values):

```yaml
backends:
  <existing-node>:
    # Existing URL/auth remain byte-for-byte unchanged; no opt-in implied.
    isolate_metadata: false
  probe_<existing-node>:
    url: http://127.0.0.1:<second-remote-port>/mcp
    enabled: true
    isolate_metadata: true
    auth:
      type: bearer
      token: <already-approved-fixture-secret-reference>
```

Do not feed this draft to the old config loader: its BackendConfig currently
does not declare the field and may ignore unknown fields. Product implementation
must validate the new boolean strictly and fail check/start on an unrecognized
isolation profile/version; no apparent activation through an ignored option.
Rollout must bind config schema and patch/package identity before activation.

Opt-in proof starts with bearer, unversioned tools. Other auth modes for an
opted backend fail before assembly. Existing OAuth/headers/none backends keep
their original client/proxy path; do not reject them globally. Unsupported
version descriptors/requests on an opted backend fail explicitly. Unselected
versioned calls retain the original lookup/validation path; do not reuse the
prototype's gateway-wide version rejection. Namespace overlap with an opted
alias is rejected before assembly; the old generic alias is not renamed.

When any backend opts in, scoped schema middleware resolves an unversioned
tools/call against that exact tool and normal authorized context. Its verified
marker is per HTTP Request and tool. Versioned non-opted calls pass through the
existing SDK path; opted versioned calls fail before execution. Real tools/list
remains a real bounded aggregate discovery. Existing outer dereference/header
checks and all normal execution middleware/interceptors/tool._run remain.
This branch distinction needs an integration test before product promotion;
the new compatibility study does not claim to implement this config switch.

Metadata connect250ms/read2s/overall3s are the current isolated proving budgets,
not an inferred WAN SLO. Reuse existing execution retries/read allowance and
credential source. No execution/read-resource/render-prompt deadline is3s.
Before product scope freezes, Reviewer must accept or adjust the explicit
production metadata budget from actual route latency evidence. No arbitrary
exception swallowing; only declared timeout/METHOD_NOT_FOUND behavior is bounded.

## Preserving non-tool and proxy behavior

The new test-only ComponentProviderProposal adds the missing three public
Provider extension methods to the accepted raw tool provider:

```text
_list_resources          -> metadata list -> ProxyResource.from_mcp_resource(execution_factory,...)
_list_resource_templates -> metadata list -> ProxyTemplate.from_mcp_template(execution_factory,...)
_list_prompts            -> metadata list -> ProxyPrompt.from_mcp_prompt(execution_factory,...)
```

Normal Provider get/transform/auth/disabled filtering and normal server dispatch
remain responsible for execution. Raw metadata is converted BEFORE namespace
or URI/name transforms, preserving backend identity. Constructor metadata,
returned content and namespaced descriptors are compared with the stock
FastMCPProxy, not merely tool-name presence. No provider's private cache is edited.

Important topology fact: build_gateway mounts per-backend servers into an outer
gateway. Stock FastMCPProxy's own initialize/discover metadata middleware and
ping handler do not become the outer gateway's hooks. The new differential
tests use the same mounted topology: gateway name/instructions remain outer
gateway facts; legacy ping succeeds locally and modern ping is METHOD_NOT_FOUND.
These tests actually negotiate modern discover using auto mode. An exact modern
version pin can adopt synthetic metadata without a discovery round trip and
was rejected as a metadata test harness in the first experiment.

This is NOT a general standalone FastMCPProxy replacement. The proposed internal
builder is mounted-only, with no independent HTTP endpoint and no copying or
re-registering low-level SDK ping/schema handlers. If scope instead requires a
standalone proxy, stop that promotion and review its metadata/ping contract.
Do not add a generic adapter framework to solve that unrequested topology.

Compatibility evidence is targeted: legacy and modern component descriptors,
read/template/get-prompt results, outer initialization/discovery identity and
ping, plus resource execution3.25s > metadata3s. It does not prove every
sampling/elicitation/continuation/subscription/session transform combination.
The proposed product must retain the same configured Client handlers/mode; it
must not invent ProxyClient defaults or silently change the existing plain-Client
persistent factory. Any deployed reliance beyond tested paths is a promotion
prerequisite, not an automatic unsupported-feature deletion.

## TLS and custom transport contract

Pinned transport source explicitly says `verify` is ignored when a custom HTTP
factory is supplied. Merely copying URL/headers/auth, as the narrow prototype
did, is insufficient for a production transport clone.

New negative/parameter tests prove a preserved SSLContext reaches the actual
AsyncHTTPTransport constructor with retries0; headers are copied, auth object
identity is preserved, and the original transport remains untouched. They make
NO TLS network/CA/client-certificate handshake claim. No certificate/key is
generated, no verification is disabled, and no fixture trust is installed.

Proposed initial supported transport profile is the exact existing
NoForwardStreamableHttpTransport and accepted retrying/default HTTP factory.
Custom subclasses/factories, TLS verification=false, or mixed custom-factory plus
explicit-verify semantics fail BEFORE assembly unless separately reviewed.
Do not introspect an arbitrary factory closure or replace its proxy/CA/cert/auth
behavior. Non-opted backends retain that factory unchanged. The future gateway
check must report the specific backend/profile error without secret values.

The pinned tests use FastMCP4.0.5/MCP2.3.0 and the hash-locked environment.
Production pyproject currently allows fastmcp>=4.0.5,<5. Product activation must
bind the tested dependency set or reject an unreviewed version; changing a
production dependency lock is a prospective scope item, not performed here.

## Smallest second-forward lifecycle

Use one extra `-R 127.0.0.1:F1_remote:127.0.0.1:F1_local` on the SAME existing
SSH process, retaining F0's exact argument and the current authentication,
host-key validation, keepalive and ExitOnForwardFailure settings. No second
SSH connection, ControlMaster socket, stdin command/control channel or service.

Adding/removing F1 restarts the tunnel and therefore briefly drops F0's TCP
connections. It does NOT keep existing F0 sessions alive. Its configuration and
generic node process identity are preserved, and F0 must recover. The field
approval must explicitly accept that bounded connection disruption. If the
Owner requires zero F0 connection interruption, this plan is insufficient;
do not silently add multiplexing or another persistent tunnel.

Current RestartServices restarts bridge AND tunnel. It must not be used.
Prospective action in the existing tray validates current file/plan identity,
loads only the new forward pair into the tunnel argument closure and calls
existing `tunnel.Restart()`. No bridge restart, tray Quit, autostart change,
process-name scan or Config.Load credentials probe is a substitute. Field still
requires a reviewed executable and exact action; the current installed launcher
cannot apply F1 through this draft representation.

The Windows disposable executable compiles WITH unchanged MCPRelay.cs and invokes
the real existing Supervised/Job Objects on owned Node fixture children. A TCP
stand-in models two channels. It proves original/second route recovery, backend
outage isolation, same bridge pid/start across tunnel-only restart/rollback,
port rejection, stale-plan rejection and owned cleanup. It is NOT SSH/MCP E2E.
The OpenSSH -G check separately parses repeated loopback -R with a private empty
config, no user/system config or key/auth/host-file access and no connection.
It proves option representation only, not server permission/bind/reconnect.

Existing installer rewrites the entire authorized_keys file. DO NOT rerun it
for this bounded field trial. An authorized operator must approve and change
only the exact existing K0 row, retaining its public-key identity/restrictions
and F0 permission, plus one F1 loopback permission. Server support must be
validated by that operator before applying; this packet does not read keys or
claim a server-side authorized_keys parser test.

## Field prerequisite / rollback packet

All current live identities remain MISSING, not guessed from old observations.

| Object | Required private artifact before approval | Exact change / rollback |
|---|---|---|
| Product tuple | Reviewed gateway patch/dependency/package and tray version; explicit WO8/WO9 integration/version decision | No silent combining PR40/41; retain deployed three-module SQLite rollback |
| G0 | Fresh sanitized alias, config section hash and health identity | No alias/URL/auth change; compare same section after trial |
| G1 | Approved `probe_<node>` alias, exact backend port and existing fixture-auth reference | Add only G1; remove only that entry if expected bytes still match |
| F0 / L0 | Current tunnel pid/start, primary argument, launcher/config hashes and proposed supported action | Keep F0 bytes and node pid/start; restore prior tunnel plan, not the whole tray |
| F1 | Exact local/remote ports, loopback collision check, readiness identity | Add/remove one pair on same tunnel; no public bind or new tunnel credential |
| K0 | Operator-held exact row identity, before/proposed hashes and parser evidence | One extra loopback permission on same row; rollback only that row after drift check |
| Fixture | Owner-approved existing auth handling, executable hash, pid/start, one deterministic read marker | No new credential; exact owned start/stop only after approval |
| Central | Supported gateway registration, exact visible names and authorized normal caller | Discover/read G0 and G1 directly; no shell, local SDK or delegated proof substitution |

Approval must name every affected object and bounded disruption. Proposed trial
remains <=15min, <=2 probe outage/reconnect cycles, one owned fixture, no Controller.
No operation is authorized by a checked box in this document.

1. Before mutation, verify expected package/config/row/port/node/process identity
   and seal private backups of only affected bytes. Abort on ambiguity or drift.
2. An authorized operator adds K0 permission, reviewed launcher pair and G1.
   Use the reviewed tunnel-only action; verify node pid/start did not change.
3. Normal central caller discovers/calls exact G0/G1 names. Record redacted
   node/backend/call correlation. Fixture outage must preserve G0; complete
   tunnel loss must make BOTH unavailable; restore and prove both recover.
4. Measure finite delta CPU/RSS/process count and actual SSH/network keepalive
   with approved structured observations. Idle HTTP log0 is not packet0.
5. Stop on failed identity/auth/isolation, node restart, unexpected listener,
   resource excess or exhausted trial window. Restore G1/F1/K0 only if each
   still equals this trial's expected value. On third-party drift, stop and
   retain evidence; do not overwrite or batch-kill unrelated processes.
6. Verify G0 health, original forward/row bytes, node identity, no remaining
   owned probe and preserved WO8 fixture/backups. Report rollback result even
   if proving failed. Do not touch ADCP RuntimeStore/TASK-090/TASK-084/#242.

Missing registration/permissions or inability to accept F0 interruption is a
specific external blocker. Source tests do not authorize live inventory or
prove remote handoff. Full WO, direct Scheduled, M1.5/M2/M3 gates stay unchanged.

## Review disposition requested

Review this ONE proposed product/config delta and supported mounted-only scope,
then freeze any required implementation/field contract. Product implementation,
dependency change and live permission/deployment actions remain separate from
these tests. Next is independent scope review of the exact new candidate;
do not self-approve, merge, deploy or turn on Controller admission.
