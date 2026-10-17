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
2 s, metadata operation 3 s. In an activated mixed gateway, aggregate component
catalog calls on each mount have a 250 ms budget. A slow mount may therefore be
omitted from a catalog, including a healthy but slow stock mount; an empty result
is neither a complete inventory nor a liveness assertion. This is necessary for
fresh Python SDK global discovery to stay bounded. Stock version metadata still
takes the real global catalog path, so it can wait for bounded sibling discovery.
These budgets are not WAN acceptance criteria. Actual tool/resource/prompt
execution is not given the metadata deadline. Default-off gateways do not acquire
the dependency gate or aggregate-catalog middleware.

## Local exact-source evidence

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

The earlier 87-case run contained two red assertions that incorrectly assumed
stock requested-version metadata must fail. The test now compares against the
actual stock-only control instead of changing product behavior or thresholds.
Prior red evidence remains preserved. The old prototype matrix is separate;
the new product workflow does not invoke the prototype replacement. GitHub can
still schedule older workflows from the cumulative PR diff.

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
