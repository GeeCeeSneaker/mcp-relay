# Acceptance Test Plan

This plan defines durable behavioral acceptance. Exact commands may evolve with selected components.

## AT-LOCAL — Local capability runtime

Pass when, on the node without tunnel/gateway:
- MCP initialize/handshake succeeds;
- `tools/list` returns exactly the fixed risk-class tools (ADR-0007): `list_capabilities`, `invoke_read`, `invoke_write`, `invoke_destructive`, `invoke_exec`, each with its class's MCP annotations (read-only / non-destructive write / destructive / destructive + open-world);
- `list_capabilities` returns the capability catalog: every required capability (DC-compatible names: `list_directory`, `read_file`, `start_process`, …) with its class, `invoke_with`, description and argument schema; the node environment (file roots, guard lists, shells); the error-code table; one `catalog_version` for the complete catalog, identical for every filtered `view`;
- all capability calls below go through `invoke_<class>({capability, args})`. A capability is refused through another class's tool (`wrong_class`, nothing runs), and invalid arguments are refused with the schema (`invalid_args`);
- failures return `Error [<code>]: … (next: <action>)` with a stable code from the catalog's table;
- directory listing succeeds on a dedicated test fixture;
- file read succeeds;
- controlled file create/edit/write succeeds;
- deterministic command returns `mcp-relay-ok`;
- a long-running process can be started, and its output observed and terminated; process operations require the opaque `handle` returned by `start_process` (not a PID), and `list_sessions` never shows handles;
- **state persistence:** a process started in one HTTP request/session can be read and terminated, with its handle, from a *separate* client connection/session;
- file guard lists hold: protected paths are never read, listed, searched or changed; read-only paths are readable but never changed;
- the audit log records one line per call (ids, capability, class, ok, duration, PID for process operations, error code), never arguments or results, and stays within its size cap;
- repeated sequential calls remain valid;
- all of the above pass in **both protocol generations** (2025 handshake and 2026-07-28);
- requests without the bearer token are rejected, and commands cannot read the token;
- the server listens on loopback only (no `0.0.0.0`/`::` listener);
- extended checks (`tests/compare-ext.mjs`, Windows): UTF-8/Chinese output, large output, interactive REPL, child-tree termination, allowed-roots enforcement.

Record the capability-server version, idle RSS of the node process tree, and confirm there is no third-party egress.

The checks are implemented once in the project smoke client (`tests/`). AT-TUNNEL and AT-PUBLIC re-run the same checks against their URL.

## AT-TUNNEL — Reverse connectivity

Pass when:
- node connects outbound from NATed environment without inbound router mapping;
- transport is authenticated/encrypted;
- VPS backend is not unintentionally public;
- AT-LOCAL representative calls succeed through the tunnel;
- killing/restarting tunnel client/server recovers automatically after restart without topology reconfiguration;
- wrong tunnel credential cannot establish the usable backend.

## AT-PUBLIC — TLS and remote authentication

Pass when:
- public MCP URL has valid HTTPS;
- supported authenticated client can initialize and invoke tools;
- unauthenticated/invalid/expired auth cannot invoke tools;
- gateway routes only to intended backend;
- client auth metadata/discovery behaves correctly for the accepted standard/client.

## AT-CHATGPT — Actual ChatGPT client

Pass when actual ChatGPT connects to the self-hosted endpoint and successfully performs at least:
- list/identify available tools;
- list directory;
- read a fixture file;
- execute a harmless deterministic command;
- perform one controlled write/edit;
- receive useful output/errors.

If account interaction can only be performed by Owner, developer evidence may mark `OWNER_VALIDATION_REQUIRED`; final v1 cannot claim AT-CHATGPT PASS until Owner/authorized operator records the result.

## AT-RECOVERY — Reliability

v1 pass requires successful automatic recovery from:
- node tunnel process restart;
- local MCP runtime restart;
- gateway restart;
- VPS tunnel-server restart;
- node network disconnect/reconnect;
- Windows reboot after packaged service phase;
- Linux reboot after Linux phase.

Target recovery after underlying connectivity/process availability returns: <=60 seconds unless an upstream component has a documented slower bound. Faster is preferred; do not add machinery merely to chase a smaller number.

## AT-WINDOWS-PACKAGE

On a clean supported Windows environment:
1. install release package;
2. provide documented minimal configuration/secret;
3. start/status succeeds;
4. remote E2E call succeeds;
5. reboot -> automatic reconnect -> remote E2E succeeds;
6. upgrade to next test package preserves intended config;
7. uninstall removes project services/runtime while preserving explicitly documented user config/log policy.

No Docker Desktop or manual npm dependency installation should be required for the normal packaged path.

## AT-MULTI-NODE

With two Windows nodes:
- both are simultaneously reachable;
- client can intentionally target each;
- same tool names do not cause ambiguous routing;
- node A call never executes on node B;
- stopping A does not prevent B operations;
- adding/removing B requires no code change.

## AT-LINUX

On supported Linux:
- installation/service lifecycle works;
- same public endpoint/client model works;
- representative file read/write, terminal and process tests pass;
- reboot/reconnect passes;
- adding Linux does not break Windows node behavior.

## AT-RESOURCE

Measure at idle after warm-up and during a representative call.

Windows node relay stack, excluding child workload:
- target idle aggregate RSS <=300 MiB;
- >400 MiB requires investigation/justification;
- idle CPU should be approximately quiescent; sustained >1% requires investigation.

VPS MCPRelay-specific stack:
- designed to fit 1 vCPU / 1 GiB host;
- target incremental idle RSS <=200 MiB;
- >300 MiB requires investigation/justification;
- no swap thrash/OOM under representative private-use calls.

Resource target miss is not automatically a functional failure, but v1 release must either remediate or document why additional cost is justified and minimal.

## AT-SECURITY-BOUNDARY

Required negative tests:
- public MCP endpoint without auth;
- invalid token/session/credential;
- tunnel with wrong node credential;
- direct public access to per-node backend port;
- secret scan of repository/release metadata;
- node configuration does not bind local MCP backend to unnecessary public interfaces;
- a node's tunnel credential cannot open another node's backend port or obtain a shell on the VPS (with the OpenSSH tunnel: forward-only account, `permitlisten` restricted).

This is not a penetration-test program. Test the actual trust boundary without inventing enterprise threat models.

## AT-REPRODUCIBILITY

A fresh implementer can use repository docs + separately supplied secrets to reconstruct:
- VPS stack;
- one Windows node;
- later one Linux node.

All third-party versions are recorded. No production path depends on an unpinned `latest` fetch at each start.

## AT-MINIMALISM

At each milestone and final release, document:
- permanent processes/components currently required;
- project-owned runtime code size/role;
- new dependencies since prior milestone;
- components/configs deleted;
- any responsibility duplicated across layers;
- whether Caddy/Supergateway/other adapter can now be removed because another accepted component absorbed its responsibility.

A functionally passing release may still require simplification before final acceptance if unnecessary permanent architecture remains.
