# Controller reference bridge

This optional node capability adapter forwards two exact-reference operations to
the ADCP Controller's newline-delimited loopback JSON-RPC server. It uses the
existing MCP `/mcp` registration, capability catalog, authentication and risk-class
dispatch. It adds no scheduler, directive consumer, execution authority or store.
GitHub and Controller remain responsible for validation, model selection,
execution and result delivery.

## Configuration and compatibility

The bridge is **disabled by default**: leave `MCPRELAY_CONTROLLER_RPC_PORT` unset
or empty. The two capabilities are then absent from the catalog. Ordinary Relay
capabilities are unchanged.

For a separately authorized deployment, the node process can receive these local
environment settings (example only; this does not start Controller):

```powershell
$env:MCPRELAY_CONTROLLER_RPC_PORT = '43127' # existing Controller RPC listener
$env:MCPRELAY_CONTROLLER_RPC_PROTOCOL = 'adcp-reference-rpc/1'
$env:MCPRELAY_CONTROLLER_RPC_TIMEOUT_MS = '10000'
```

The host is always `127.0.0.1`; callers cannot choose any endpoint. Port must be
1–65535. Protocol defaults to `adcp-reference-rpc/1`, and timeout defaults to
10000 ms (allowed integer range 10–30000 ms). Invalid enabled configuration
fails node initialization. Existing node authentication remains necessary;
capability annotations do not authorize execution.

`adcp-reference-rpc/1` is the local adapter compatibility profile for the PR288
Controller at commit `7539d0fbce292f6e8b97d34bd3038fe603082abc`. Its wire format is
one UTF-8 newline-terminated JSON-RPC 2.0 request and result per connection.
Response IDs must match the generated method-qualified request ID. Only the
bounded reference result/receipt schema is accepted; RPC errors, incompatible
versions, invalid JSON, unexpected fields, mismatched references and oversized
responses fail closed. This profile is not a new wire handshake or a claim of
compatibility with future Controller schemas.

## MCP calls

These are capability names exposed through the existing fixed MCP tools, not
two new top-level MCP tools. Discover them with `list_capabilities`; invoke using
the existing read/exec routes:

```json
{"name":"invoke_read","arguments":{"capability":"controller.get_result","args":{"repository":"GeeCeeSneaker/AI-Development-Control-Plane","runtime_issue_number":123,"directive_comment_id":"456"}}}
```

```json
{"name":"invoke_exec","arguments":{"capability":"controller.apply_decision","args":{"repository":"GeeCeeSneaker/AI-Development-Control-Plane","runtime_issue_number":123,"directive_comment_id":"456"}}}
```

The numbers above are illustrative references, not instructions to execute.
Only these three fields are allowed; Issue must be a positive safe integer and
comment ID a positive decimal string of at most 20 digits. No endpoint, prompt,
shell, model or effort overrides are accepted here. `get_result` is read-only.
`apply_decision` can START, RESUME or STOP and uses the existing **exec** class
with destructive execution annotations. A STOP acknowledgment is not evidence
that its target has terminated.

Each call has one connection, one absolute deadline and no retries. The bridge
allows at most 16 in-flight calls and a 16 KiB response frame. A transport or
schema failure produces `controller_outcome_unknown`, action `reconcile`, and
the exact reference. **Do not redispatch `apply_decision` after such a failure.**
Query `controller.get_result` for the same reference instead. Closing the client
or Relay does not cancel Controller-owned work; a missing response does not
prove no execution occurred. Successful queries return Controller's bounded
`UNKNOWN`, `NOT_ADMITTED`, `REJECTED`, `IN_PROGRESS` or `TERMINAL` result, without
converting an admission acknowledgment into completion.

## Reproducible isolated proof

Prerequisites: Node.js with the repository's locked runtime and test dependencies,
Python 3.12 with ADCP's test dependencies, and a clean checkout of the exact PR288
Controller commit above. No installed services or production configuration are
used. From the Relay repository root:

```text
python -B tests/controller-bridge.py --controller-source D:/path/to/clean/ADCP-PR288
```

The runner checks Controller HEAD/cleanliness, prints its retained temporary
fixture directory and bridge SHA256, and exercises actual MCP SDK requests
through a temporary Relay node, the real adapter and real Controller RPC and
composition. Store/workspaces and GitHub/Provider/host/delivery effects are
temporary/fake. It owns and cleans up only its own child processes.

Seven scenarios cover default-off/ordinary capability handling; execution to
terminal result and replay with `gpt-6.1-sol/high`; the same with
`gpt-6-luna/max`; argument/risk/trust/wrong-Issue rejection and same-Issue STOP;
lost-response reconciliation; client/bridge disconnect ownership; and bounded
malformed/unavailable backends with ordinary capabilities still working.
The model pairs verify configuration propagation to FakeProvider and receipts,
not availability or execution of a production model. Backend protocol negatives
use a small deliberately malformed loopback server; positive execution scenarios
use the accepted Controller source.

This proof does not establish installed Relay/Controller health, remote access,
production admission, deployment readiness or permission to start any task.
