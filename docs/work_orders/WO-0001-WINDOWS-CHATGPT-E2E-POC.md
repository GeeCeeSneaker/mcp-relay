# WO-0001 — Windows -> VPS -> ChatGPT Minimal End-to-End PoC

- Work Order ID: `WO-0001`
- Status: `OPEN`
- Priority: `P0`
- Change Class: `C1 implementation under ADR-0001`; any core component substitution is C2/C3 and requires amendment
- Target milestone: `M1`
- Tracking Issue: `#1`

## 1. Objective

Build and prove the smallest end-to-end vertical slice that allows a remote MCP client, with ChatGPT as the target client, to invoke Desktop Commander tools on one Windows PC through our VPS.

This Work Order exists to validate the architecture before packaging or fleet work. A documented compatibility failure is an acceptable outcome; unbounded architecture growth is not.

## 2. Governing documents

Read before implementation:
- `README.md`
- `docs/project/PROJECT_CHARTER.md`
- `docs/project/ENGINEERING_PRINCIPLES.md`
- `docs/project/SYSTEM_ARCHITECTURE.md`
- `docs/project/DEVELOPMENT_MANAGEMENT.md`
- `docs/project/WORK_ORDER_PROTOCOL.md`
- `docs/project/RESOURCE_BUDGETS.md`
- `docs/adr/ADR-0001-MINIMAL-REMOTE-MCP-ARCHITECTURE.md`

## 3. Frozen candidate chain

Use only this initial chain unless this Work Order is amended:

```text
ChatGPT / standard remote MCP client
 -> HTTPS
 -> Caddy (VPS)
 -> lightweight MCP gateway candidate + required auth
 -> VPS loopback per-node backend
 -> rathole-server
 -> encrypted/authenticated tunnel
 -> rathole-client (Windows)
 -> Supergateway
 -> Desktop Commander
```

Candidate gateway: `R0Wi/mcp-gateway`.

The implementer must record exact versions/releases/commit references for all third-party components actually tested. Do not use floating `latest` as the reproducibility record.

## 4. Required tasks

### A. Repository/runtime skeleton

Create only the files/scripts/config templates required to reproduce this PoC. Keep secrets out of Git. Provide `.example`/template configuration where necessary.

Do not create a generalized framework, installer, control plane or plugin system.

### B. Local Desktop Commander HTTP exposure

Prove Desktop Commander can be launched through Supergateway as a Streamable HTTP MCP backend on the Windows node.

Requirements:
- local listener is not publicly exposed;
- the implementation records exact startup/configuration;
- verify a representative safe Desktop Commander tool call locally before adding the tunnel.

### C. Reverse tunnel

Configure rathole so the Windows node initiates an authenticated/encrypted connection to the VPS.

Requirements:
- no home-router/public inbound port required on Windows;
- VPS backend for this node binds to loopback where the component permits;
- only required rathole listener/control port(s) are public;
- reconnect behavior/configuration is documented even if full lifecycle hardening is deferred to M2.

### D. VPS MCP ingress/auth

Configure Caddy + candidate MCP gateway so the public surface is one HTTPS MCP endpoint.

Requirements:
- unauthenticated requests must not obtain functional remote-control access;
- auth flow must be compatible with the target client path rather than a private header convention that ChatGPT cannot use;
- gateway reaches the Windows backend only through the local rathole-exposed endpoint.

### E. Compatibility gate

First prove the candidate gateway can satisfy the real standard/ChatGPT remote MCP authentication/discovery flow.

If a core incompatibility is found that cannot be solved by a bounded configuration correction:
1. stop implementation at that boundary;
2. preserve a minimal reproducible failure description/log with secrets removed;
3. mark WO `BLOCKED`;
4. state the smallest replacement options, but **do not implement them** without review/amendment.

No silent substitution of ToolHive, WireGuard, HAProxy, a custom auth server or a custom relay.

### F. End-to-end functional proof

On a dedicated harmless test location/fixture, prove at least:
- directory listing;
- file read;
- one harmless command execution that returns a deterministic marker such as `mcp-relay-ok`.

Do not commit sensitive local paths/usernames/file contents merely to prove the call.

Two evidence levels are distinguished:

1. `GENERIC_REMOTE_MCP_PROOF`: public endpoint auth + remote MCP client successfully invokes the local Windows tools.
2. `CHATGPT_PROOF`: ChatGPT itself connects to the endpoint and performs the representative calls.

The milestone cannot be independently marked fully VERIFIED without `CHATGPT_PROOF`. If the implementer cannot perform that account-side step, submit everything else as candidate-ready and mark `OWNER_VALIDATION_REQUIRED`; the Owner can perform the final client connection without sharing secrets.

### G. Resource measurements

Record, with test conditions:
- Windows relay process tree and aggregate idle RSS/CPU;
- VPS MCPRelay-specific processes and incremental idle RSS/CPU where practical;
- one representative request state;
- any obvious latency added by the gateway/tunnel path;
- disk/runtime dependency footprint observed.

Compare against `RESOURCE_BUDGETS.md`. Do not optimize by adding architecture.

### H. Minimal automated checks

Add only useful checks that can run in CI without private infrastructure, for example configuration validation, lint/static tests and any small unit tests for project-owned glue/scripts.

Do not mock the entire network stack merely to create a large test count. Real E2E evidence is required separately.

## 5. Explicit non-goals

Do not implement in WO-0001:
- Windows installer/MSI/one-click packaging;
- Windows service supervisor unless strictly necessary to run the PoC;
- Linux support;
- multiple nodes;
- node enrollment service;
- web dashboard;
- database/control plane;
- auto update;
- WireGuard;
- ToolHive;
- HAProxy;
- Docker Desktop dependency;
- local node OAuth/TLS stack;
- custom MCP server/transport;
- custom WebSocket/reverse-tunnel protocol;
- enterprise RBAC/policy engine.

## 6. Required repository artifacts

At minimum:
- reproducible config templates for node and VPS;
- minimal startup/run instructions;
- exact dependency/version manifest or equivalent record;
- any project-owned scripts actually necessary for repeatability;
- CI/static tests appropriate to those scripts/configs;
- sanitized E2E evidence summary;
- resource measurement summary;
- updated `docs/DEVLOG.md`;
- updated WO completion/handoff section.

Do not commit generated runtime data, secrets, private keys or raw sensitive machine captures.

## 7. Acceptance criteria

WO-0001 is eligible for `PASS` only when the exact reviewed candidate demonstrates:

1. one Windows PC behind normal NAT requires no public inbound MCP port;
2. node -> VPS path is authenticated/encrypted;
3. VPS exposes one public HTTPS MCP endpoint for this PoC;
4. unauthenticated public access cannot invoke Windows tools;
5. remote MCP traffic reaches Desktop Commander through the candidate chain;
6. directory listing, file read and deterministic harmless command execution succeed;
7. ChatGPT-specific proof is present, or the candidate is explicitly held at `OWNER_VALIDATION_REQUIRED` rather than falsely marked complete;
8. exact third-party versions/config are recorded;
9. resource measurements are provided and any budget overrun is explained;
10. no unauthorized architecture layer was added;
11. no secret/sensitive local evidence is committed;
12. repository docs/DEVLOG accurately reflect the exact candidate state.

## 8. Stop/block conditions

Stop and report rather than broaden scope when:
- ChatGPT/client auth/discovery is incompatible with the candidate gateway;
- rathole cannot carry the required transport semantics reliably in the bounded PoC;
- Supergateway cannot correctly expose the required Desktop Commander MCP behavior;
- solving the blocker appears to require a new core component/custom protocol;
- required local/VPS permission is unavailable.

## 9. Candidate handoff format

Before moving status to `REVIEW`, append:

```text
Implementation Status: CANDIDATE_READY | BLOCKED
Review Status: PENDING_REVIEW
PR:
Exact Head SHA:
Base SHA:
Components/Versions:
Files Changed:
Local Validation:
GitHub CI:
Generic Remote MCP Proof:
ChatGPT Proof: PASS | OWNER_VALIDATION_REQUIRED | FAIL
Windows Resource Evidence:
VPS Resource Evidence:
Known Open Issues:
Scope Deviations: NONE | <explicit list>
```

Only the independent Reviewer may change the Work Order to `VERIFIED`.

## 10. Reviewer constraint

The Reviewer will not log into, configure or operate the Windows PC/VPS for this Work Order. Review is based on committed code/config, exact-head GitHub state, CI and submitted sanitized runtime evidence. Any missing local evidence remains a blocker/Owner-validation item.

## Completion / Review

Not yet started.
