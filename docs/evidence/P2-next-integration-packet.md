# WO-0010 exact-candidate field packet — NO INSTALL / NOT FIELD-READY

Authority: [PR42 review6231397205](https://github.com/GeeCeeSneaker/mcp-relay/pull/42#issuecomment-6231397205)
accepts the bounded engineering slices and assigns this refresh of the existing
packet. It does not accept whole WO/M1, approve merge/deployment/live checks,
alter permissions or activate Controller. Separate live Issue43 is not presumed
fixed by this candidate. No private host inspection was performed for this refresh.

## Exact source, configuration and evidence

Engineering source is **14c27332b54cff1ed2338161470e2380fb3342a5**, tree
**9911a0f7112501a51bbb637bdd2d75bef4aad516**. A later documentation-only head
must retain these runtime blobs; it is not a new installed version or independent
acceptance of a changed executable. Relay main/base remains
a8910d390ba276a578d6b8f0ee2475430d28a909 at preparation. Installed/deployed SHA
and binary hashes are **MISSING**; candidate SHA is not deployment evidence.

The following are Git blob SHA-1 identities, not private file SHA-256 hashes:

| Artifact at engineering source | Exact identity |
|---|---|
| app/windows/MCPRelay.cs | 04a0299e78a8f52ad171f1ef83fdef65a428fdbf |
| patches/mcp-gateway/0001-persistent-backend-client.patch | 508e5a30afdd6ce55400f3fa12eb79c5f6eb66ee |
| patches/mcp-gateway/0002-backend-connect-retries.patch | 5d29b61df613874327605357c4fda18feb3ae523 |
| patches/mcp-gateway/0003-bounded-metadata.patch | ab2ec37657a269a5f60b7ffac8acf712800b344b |
| tests/routing-gateway-source.json | b920c9eb8b9c801cbcdbf76a5ea1209f09b3bd66 |
| tests/routing-requirements.txt | 9330f19a421d1c4aa0723af41a5d22d9d7438504 |
| node-runtime/package-lock.json | 2c718e3b3f07b1135bfe3e175662c8b50cc93f40 |
| tests/routing-probe.mjs (disposable fixture source) | 7af6d1b8182289525cc4fd24476a33beca80fd39 |

Gateway source manifest pins upstream **59c1efd00e0c1baea4ed7861429200d2d6be0e83**
and 19 file identities; apply 0001, then 0002, then 0003. Tests verify source
bytes and patch check/apply. The tested environment uses Python 3.12, Node
24.21.0 and the hash-locked requirements. Opt-in activation requires exact
FastMCP 4.0.5, MCP/mcp-types 2.3.0, httpx2/httpcore2 2.13.0, pydantic 2.14.1.
A deployment must bind reviewed build/package/executable hashes, actual dependency
inventory and explicit WO8/WO9 integration decision; do not combine PR40/41 or
replace the deployed three-module SQLite rollback by inference.

Accepted source/log evidence, reusable without another green-receipt rerun:

- [Windows native CI39014569118/job117343875703](https://github.com/GeeCeeSneaker/mcp-relay/actions/runs/39014569118/job/117343875703):
  92 native +16 TCP +78 serialized checks, two R2 cases, complete owned cleanup,
  no fallback. Actual files/Jobs/process identities; not installed tray or SSH.
- [Gateway CI39014569152](https://github.com/GeeCeeSneaker/mcp-relay/actions/runs/39014569152):
  Windows117343875675 and Linux117343875918 each 18 activation +134/0 matrix
  +16 checks. Actual create_app, production_mixed=true, prototype=false.
- Tested merge f73a9090422b1489735aabb81587767f2e9154c6 has the exact source tree
  above. [Full receipt](https://github.com/GeeCeeSneaker/mcp-relay/issues/38#issuecomment-6231353326),
  [gateway behavior](P2-backend-isolation-implementation-slice.md) and
  [serialized lifecycle/limits](WO-0010-serialized-tunnel-changes.md).

The older prototype/component/TLS tests remain supporting compatibility studies,
not product activation or live TLS/SSH/central proof.

## Supported config and revised lifecycle

G0 keeps its existing alias, URL, auth, transport, handlers and ordinary stock
proxy path. Only G1 opts in; this is the supported candidate shape, with private
placeholders that are not deployable values:

```yaml
backends:
  <G0-existing-alias>:
    # Retain the actual existing entry; this fragment does not replace it.
    isolate_metadata: false
  <G1-approved-probe-alias>:
    url: http://127.0.0.1:<F1-remote-port>/mcp
    enabled: true
    isolate_metadata: true
    metadata_profile: bounded-v1
    auth:
      type: bearer
      token: <existing-approved-fixture-secret-reference>
```

Do not add a metadata_profile to G0. Strict boolean/profile, exact dependency,
namespace, bearer and supported transport/TLS checks must pass before assembly.
Old unpatched loaders may ignore unknown fields: inspect actual installed
schema/package identity, not apparent config acceptance. Unsupported opted
auth/version/transport fails explicitly; non-opted behavior is preserved.
The mounted provider retains all four component families and normal auth/schema/
header/transform/execution paths. It is not a standalone proxy replacement.

Bounded-v1 metadata connect is 250 ms, HTTP read/write/pool 2 s, operation 3 s;
only opted aggregate catalogs have a 250 ms budget. These are isolated proving
budgets, not WAN acceptance. Missing opted catalog entries are not health proof.
Stock descriptors/version lookup retain supported waits. Actual tool/resource/
prompt execution does not inherit the metadata deadline. No registry, schema
cache, extra proxy, credential platform or poller is introduced.

L0 proposal is a separate full config file differing only in
`secondLocalPort` / `secondRemotePort`. Both absent or both integer zero preserve
single-forward; otherwise both JSON integers 1..65535, neither duplicating the
primary local/remote port. Half/mixed-zero/string/float/bool/null pairs fail.
Unknown/non-pair settings must remain equal. The primary `-R`, SSH auth/host-key/
keepalive/ExitOnForwardFailure settings stay exact; one extra loopback `-R`
uses the same SSH connection. No arbitrary hosts/options/forward arrays.

The reviewed **Apply tunnel-only config** tray action hashes actual before/after
bytes and serialized SSH plans, binds node/tunnel PID+UTC start identities into
an expected-hash receipt, and revalidates both files under exclusive handles.
Drift/replay/concurrent apply refuses before stop. It retires the exact old
supervisor and waits for checked process/Job release before creating a distinct
retry-disabled candidate supervisor in the same tunnel role. Candidate readiness
precedes config write/flush/readback and enabling ordinary retries. This replaces
the earlier prospective direct tunnel.Restart approach; it never calls
RestartServices, restarts the generic node or creates a competing SSH process.

A failed candidate permits at most one rollback, after its checked release,
exact prior-byte restoration/readback and unchanged node identity. Failed or
uncertain stop, assignment, restoration or rollback latches blocked status and
prevents replacement/maintenance. Do not retry a blocked action, clear the latch,
quit the tray, restart the app/node or kill by name as an improvised recovery.
Native start/assignment is not atomic; unknown assignment descendants remain a
hard uncertainty. The field must not inject these native fault tests on live hosts.

Authentication marker plus two seconds is local stabilization only. Each
ready/release wait is 20 s, native stop waits 2 s; neither is an end-to-end F0
outage guarantee. Actual SSH forwarding and central reads below decide recovery.
The config write is in-place, exclusive and flushed/read back, **not crash-atomic**.
In-memory previous bytes do not replace an independently verified private backup.

## Private live-object sheet — all current values MISSING

Keep real machine paths, node/host identities, key/account details, auth values,
raw configs/logs and backups private. Public evidence uses opaque G/F/K/L labels,
approved artifact/hash references, sanitized tool names and timestamps/outcomes.
Even an alias/tool name is published only after confirming it contains no private
node identifier. The responsible authorized operator supplies the facts; this
packet does not authorize searching for credentials or doing live inventory.

| Object | Required fresh private identity / baseline | Bounded change and verification |
|---|---|---|
| Product tuple | deployed source/package/executable/dependency hashes, exact gateway/tray versions, reviewed integration and rollback package | Pin above source/patch set; deployment is a separate gate |
| G0 | existing alias/URL/auth reference, exact section bytes/hash, normal caller and baseline read marker | Preserve entry/auth; same generic read after each change |
| G1 | approved non-overlapping alias, F1 endpoint, supported fixture-auth reference, exact before/after section hashes | Add/remove only G1 after drift check; no outer auth/public endpoint change |
| F0 | exact SSH PID/start, primary argument and listener identity, generic node PID/start, baseline primary sessions | Same primary args/settings; new tunnel PID expected, node PID/start fixed during trial |
| F1 | approved local/remote pair, both loopback, collision/bind/permission evidence | One pair on existing connection, no wildcard/public bind |
| K0 | operator-held exact restricted row/key identity, before/after byte hashes, server parser/support evidence | Only one extra loopback PermitListen on same row; retain key/restrictions/F0 |
| L0 | current launcher/config bytes/hash, proposed bytes/hash, serialized plan/receipt hashes, exact executable and supported action | Only pair diff; byte-hash readback after apply or restoration |
| Fixture | exact reviewed executable/source, existing approved auth handling, deterministic read marker, PID/start and listener | One owned disposable backend; exact stop/restart, no service |
| Central | supported registration/version, exact names mapped privately to G0/G1, normal authorized caller incl. bounded Scheduled route | Real direct discovery/calls with node/backend/call correlation; no shell/local SDK/delegated substitute |
| Recovery / budget | verified private backup refs, writer quiescence and exact tunnel-only recovery procedure, F0 interruption limit and resource ceilings | Owner must approve concrete values and actions; missing or impossible recovery is NO-GO |

G/F/K/L labels are evidence references, not a new workflow/state registry.
Current deployment, Controller PID/start/health/admission/hold and remote handoff
are unverified here; do not fill from historical chat or isolated fixtures.

## Approval boundary and minimal field sequence

Current authorization ends at this document/evidence preparation. No host check,
merge, package installation, live restart, row/config edit, Scheduled enablement
or Controller actuation is granted. An owner-approved packet must first name
the exact product tuple and every affected private object, actor, allowed reads/
writes, rollback actions, resource ceilings and time limits.

Candidate installation may restart the tray/node/gateway and disrupt existing
connections. It is **not** hidden inside a tunnel-only trial. Either an explicitly
approved deployment has already been reconciled and baseline G0 works, or a
separate exact deployment/recovery authorization is required. Freeze the trial's
node identity only after that baseline; the field cannot use an old launcher.

The proposed trial remains <=15 min, <=2 owned-probe outage/reconnect cycles,
one disposable fixture, no Controller. **F0_MAX_INTERRUPTION_SECONDS is MISSING**:
the owner must set a finite numeric per-transition deadline from stop onset to
first successful normal-central G0 read, and accept loss of existing F0 TCP
sessions. No zero-interruption claim. Set a rollback deadline within the same
approved window and verify the exact recovery steps fit it. Product wait values
are not substituted for either deadline. Without these filled values, do not run.

1. **Read-only baseline after specific approval.** Verify actual deployed tuple,
   G0/F0/K0/L0 identities, collisions, existing primary session impact and
   normal-central G0 read. Capture exact node/tunnel and approved process/resource
   baselines. Do not inspect ADCP RuntimeStore or operate old tasks for this trial.
2. **Private backup and preflight.** Seal exact affected config bytes (active,
   proposed, G sections and K0 row) and required package rollback artifacts in an
   existing approved private location. Independently read back byte lengths and
   SHA-256 hashes; preserve ACL/access and unrelated rows/sections. Verify the
   supported candidate loader/profile and proposed diff without live activation.
   Mismatch, unavailable backup, third-party drift or unsupported rollback: stop.
3. **One bounded activation.** Start the one approved fixture, record PID/start,
   marker and loopback listener. Authorized operator conditionally adds only
   F1 permission to K0 after before-hash check; never rerun the installer (it
   rewrites authorized_keys). Apply L0 using the reviewed tray action, recording
   receipt, stop onset, old-release and new PID/start. Check node identity/F0
   settings. Once actual forward readiness is observed, conditionally add only
   G1 through the already reviewed gateway config lifecycle. Its supported
   reload/restart action and possible G0 disruption must be named in approval;
   no assumed hot reload. No second SSH connection or new credential.
4. **Real recovery and isolation proof.** Use the supported normal central path:
   discover exact G0/G1 names, make the existing generic read and deterministic
   probe read, and correlate sanitized node/backend/call results. A local SSH
   auth marker, -G parse, TCP connect, generic shell or local SDK does not pass.
   Within <=2 approved fixture outage/reconnect cycles, exact-stop only the probe:
   G1 fails distinctly while G0 succeeds; restart only that owned probe and prove
   G1 recovery. A separately named, bounded tunnel-only reconnect establishes
   both-backends unavailable vs probe-only unavailable, then both recover with
   unchanged node PID/start. Observe actual server loopback forwarding plus
   direct central reads; do not invent an unimplemented hold/loss action.
5. **Bounded observations.** Record actual F0 outage/recovery intervals against
   its approved deadline, call error classes/latencies and exact forwarding
   identities. Collect finite exact-process CPU/RSS/thread/process deltas and
   real network/SSH keepalive observations using approved structured capabilities,
   with temporary fixture overhead separated. Idle HTTP log0 is not packet0.
   Central unattended proof uses only the specifically approved bounded Scheduled
   caller; A/B/C do not become generally enabled. Missing registration/tools/
   permission or inability to demonstrate whole-tunnel loss is a concrete gap.
6. **Normal rollback and readback.** While each current object still matches
   this trial's after-hash/identity, remove only G1, then apply the saved L0
   before-bytes via a fresh expected-hash tunnel-only receipt to remove F1.
   Confirm exact tunnel replacement/release, F0 recovery and unchanged node.
   Restore only K0's exact prior row bytes after current-row drift check; preserve
   other rows. Stop the exact owned fixture and verify no owned listener/process
   remains. Read back every restored affected byte/hash and G0 normal-central
   health; preserve prior WO8 fixture/three-module rollback and WO9 artifacts.

At any failed auth/identity/isolation, node restart, unknown child, unexpected
listener, resource excess or exhausted deadline, stop further proving changes.
A missed recovery deadline is FAIL even if service later recovers; report actual
duration and recovery status. Do not abandon cleanup at the timer boundary.

For partial write/crash, never trust an old in-memory receipt: reconcile current
writer/process/Job identities first, and use the independently read-back private
before-bytes only under an explicitly approved quiescent-writer restoration step.
A blocked supervisor or uncertain old tree cannot be replaced by another SSH
process. If the only available recovery is whole-tray/node restart, it is outside
the node-preserving trial: hold, preserve evidence and return the exact required
operator decision. No force overwrite of drift, blanket file/row restore,
process-name/batch kill or automatic repeated apply. This missing emergency
procedure must be resolved in the private approval packet, not assumed here.

## Evidence handback and unchanged ADCP gates

For each step record observed_at, opaque object/candidate identities, expected/
observed hash outcome, exact stop/replacement receipts, result/error class,
measured outage/recovery and resource deltas, and rollback outcome even on FAIL.
Keep private artifact references separate from sanitized public proof. Record
which calls were direct normal-central and Scheduled, and which were merely
local support observations. Whole WO/M1 stays pending until its real E2E and
resource criteria, plus #35/#37 deployment/Scheduled gates, are accepted.

ADCP [docs/30 at accepted b251bde22fdc882be16f18baa48ea38bcce4f00f](https://github.com/GeeCeeSneaker/AI-Development-Control-Plane/blob/b251bde22fdc882be16f18baa48ea38bcce4f00f/docs/30-execution-node-stack-implementation-plan.md)
requires **M1 -> M1.5 exact runtime reconciliation -> M2 read endpoint -> M3
mutation**. Later authorized M1.5 uses accepted sqlite_schema/sqlite_query and
exact pid@start/process_usage to reconcile RuntimeStore active/unresolved
bindings/runs, Provider ambiguity, workspace/result ownership, TASK-090/TASK-084,
ingress mode/#242 and a no-Agent idle/resource baseline (or exact measurement
blocker). This packet neither performs nor waives that gate. No Controller
endpoint/start/RESUME/admission or queue release, no duplicate old START, no
RuntimeStore/#242/backup alteration, no deletion of migration controls.
Separate live Issue43 requires its own exact evidence/disposition.

**Next:** independent review of this refreshed exact-candidate packet. Private
live-object facts, numerical interruption/rollback/resource budgets, supported
deployment/gateway lifecycle and emergency restore actions remain explicit
NO-GO items for a later owner decision. No new design task or infrastructure.
