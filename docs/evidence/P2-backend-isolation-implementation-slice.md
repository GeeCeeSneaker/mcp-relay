# WO-0010 first executable gateway slice

Status: **IN_PROGRESS / NO INSTALL**. Implements the first slice requested in
[#38 PM dispatch](https://github.com/GeeCeeSneaker/mcp-relay/issues/38#issuecomment-6229920142),
on the original PR #42 branch/session. This does not accept the complete WO or
authorize installation, field restart, merge, or ADCP Controller operation.

## Actual change

`patches/mcp-gateway/0003-bounded-metadata.patch` applies to the fixed upstream
source after accepted patches 0001/0002. It implements real config/assembly;
the product test uses `create_app` without replacing the production factory.

- Existing backends default to `isolate_metadata: false`. Activation requires a
  strict boolean, explicit `metadata_profile: bounded-v1`, bearer auth, supported
  transport/factory/TLS settings, unambiguous namespace, and exact tested package
  versions. Unsupported activation fails before mounting any backend.
- The selected backend uses short-lived metadata clients created with the
  existing Client's public `new()` API, preserving handlers/mode/auth/headers/TLS.
  Execution uses the original persistent Client factory and ordinary FastMCP
  provider/auth/transform/dispatch path. No schema or liveness cache is added.
- Tools, resources, resource templates and prompts use the same mounted provider.
  Only METHOD_NOT_FOUND becomes an empty component list; other errors remain
  errors. Versioned opted tools are refused before execution; stock versioned
  dispatch remains on the original path.
- Request-local schema verification refuses opted calls when discovery fails;
  cancellation does not produce a successful schema marker. Argument/header
  validation and original execution remain in the SDK path.

`bounded-v1` is an isolated proving profile: connect 250 ms, HTTP read/write/pool
2 s, metadata operation 3 s. Following R1, aggregate component catalog calls on
**opted mounts only** have a 250 ms budget. A slow opted mount can be omitted;
an empty opted catalog is neither a complete inventory nor a liveness assertion.
Non-opted mounts retain their original waits and complete descriptors. Stock
version metadata still takes the real global catalog path, so it can wait for
both its own supported discovery and bounded opted sibling discovery.
These budgets are not WAN acceptance criteria. Actual tool/resource/prompt
execution is not given the metadata deadline. Default-off gateways do not acquire
the dependency gate or aggregate-catalog middleware.

## Original first-slice evidence (bbcb207, before R1)

Windows, Python 3.12.14, Node 24.21.0, FastMCP 4.0.5 / MCP 2.3.0. Activation also
checks mcp-types 2.3.0, httpx2/httpcore2 2.13.0 and pydantic 2.14.1. Dependencies
remain hash-locked in the existing test requirements; no installed product changed.

Commands (fresh disposable output directory):

```text
python tests/prepare-routing-gateway.py --out <fresh-source> --with-isolation
python tests/metadata_activation.py --gateway-source <fresh-source>
python tests/backend-routing.py --gateway-source <fresh-source> --node-exe <pinned-node> --sample-seconds 1 --production-mixed --strict-matrix
git -c core.autocrlf=false diff --check
```

Results on 2026-10-17 UTC: fixed-source blob verification and patch check/apply
passed; **18 activation/guard tests passed**; **91 mixed matrix cases passed,
0 failed**, plus the harness's 12 setup/resource checks. Real G0 default-off / G1
opted assembly covers cold/warm discovery, existing/fresh sessions, two refusal /
reconnect cycles, stalled metadata, cancelled metadata, auth, malformed arguments,
header matching/mismatch and zero execution after refused schema/version lookup.
All temporary fixture processes finished; permanent process delta was zero.

Healthy G0 unversioned operations stayed within the unchanged 750 ms local
proving bound. Fresh healthy G0 with stalled/cancelled G1 took 281–297 ms.
Stock version-metadata results matched a stock-only control, taking 532–547 ms
while G1 stalled. Stalled selected lookup failed in 2.031–2.047 s under the
unchanged 4 s failure bound. Resource/prompt execution took 3.312/3.297 s and tool
execution 4.297–4.625 s, exceeding the metadata budget successfully. Component
namespace/URI/name identity, missing methods and explicit non-tool errors passed.

R1 found that the original all-mount 250 ms catalog deadline violated stock
compatibility; acknowledging the omission did not authorize it. Those timings
are historical evidence, not acceptance of the original implementation.

The earlier 87-case run contained two red assertions that incorrectly assumed
stock requested-version metadata must fail. The test now compares against the
actual stock-only control instead of changing product behavior or thresholds.
Prior red evidence remains preserved. The old prototype matrix is separate;
the new product workflow does not invoke the prototype replacement. GitHub can
still schedule older workflows from the cumulative PR diff.

## R1 correction and actual slow-stock regression

[Independent review6230272793](https://github.com/GeeCeeSneaker/mcp-relay/pull/42#issuecomment-6230272793)
requires retaining the original non-opted catalog path. Product correction is
limited to mounting `CatalogBound` only when that backend is opted in; no timeout
or dependency was increased. The new regression is part of the same actual
product workflow and invokes `create_app` without substituting its builder.

`routing_stock_compatibility.py` hosts an owned bearer-authenticated HTTP G0 with
350 ms metadata delay on all four catalog families, two real versions of one
header-annotated tool, a resource, template and prompt. A stock-only gateway is
the control. Both real versions must return their distinct version markers
before any mixed comparison can pass. The SDK wire version is a string under
`_meta.fastmcp.version`; prior dict-valued metadata was not this proof.

For G1 healthy/refused/stalled/cancelled, compare all stock descriptor fields
against the control, confirm the delayed stock catalog actually completed, then
exercise both real versions on fresh authenticated sessions with matching header,
mismatched header and malformed arguments (zero execution on rejection), and
resource/template/prompt dispatch. G1 stalls all four metadata families; caller
cancellation must reach G1 and close with zero execution. CI logs expose canonical
descriptor hashes/counts and distinct real-version control results. The stock
global path is allowed its original supported wait; its measured latency is
reported rather than deleting slow components to meet the fast fixture's bound.

Focused reproduction command adds `--stock-compatibility-only` to the product
command above. It is not full acceptance. The complete workflow runs both the
original isolation matrix and these regressions. Exact head, red baseline and
Windows/Linux terminal results are recorded in the R1 handoff on PR42/#38.

Local fixed-source R1 result (2026-10-17 UTC): **18 activation tests PASS;
134 mixed cases / 0 failures**, comprising the retained 91 isolation cases and
43 slow-stock cases, plus 16 setup/resource checks. The previous bbcb207 applied
source fails 20/43 focused cases: all 16 full-descriptor comparisons and four
header-rejection controls. This red baseline is preserved, not reclassified as
passing diagnostic evidence. The initial new harness used the wrong dict-valued
wire version and failed its stock-only control; corrected string-valued control
proves both actual versions before comparing mixed results.

Corrected local slow-stock catalogs took 375–391 ms, retaining the deliberately
slow descriptors. Fresh real-version/header calls took 1.109–1.297 s in mixed
states versus 1.125–1.406 s in stock-only controls. This is an observed stock
discovery wait, not a claim that every stock call satisfies the separate fast
generic fixture's unchanged 750 ms bound. Selected opted metadata deadlines,
long-execution controls and owned cleanup still pass; permanent process delta 0.

## Remaining binding gates

- Native Windows Job create/setup/assign/terminate outcomes and forced-failure
  tests are not implemented by this slice. Existing native code is unchanged.
- Serialized config/plan identity, stale/concurrent apply refusal, paired ports,
  primary-preserving tunnel-only apply/restart/rollback and exact process identity
  remain unimplemented. Earlier stand-in plan tests do not satisfy this gate.
- Independent review and Windows/Linux actual-product CI remain required;
  exact candidate SHA and CI readback are recorded on PR #42 / issue #38.
- Normal central Scheduled/direct path and SSH tunnel field E2E remain NOT_RUN.
  No G/F/K/L live object, port, key row, auth, registration, install or restart was
  changed. No dedicated Controller interface or remote-handoff capability is
  claimed. Full WO acceptance remains BLOCKED.

Original implementation session: `01a1389f-3741-7533-a47e-1fa0491d7020`.
Platform turn context at `2026-10-17T05:03:49.125Z` records `gpt-6.1-sol` / `high`.
This is developer-session evidence, not a Controller runtime attestation.
