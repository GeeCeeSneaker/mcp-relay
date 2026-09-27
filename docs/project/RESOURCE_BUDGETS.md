# Resource Budgets

These budgets enforce the Owner's requirement that MCPRelay remain lightweight on both PC and VPS. They are initial engineering budgets, not marketing claims. M1 must measure real usage before budgets are tightened/frozen.

## 1. General rules

1. Do not upgrade the VPS solely for MCPRelay before measured evidence shows the existing host is a bottleneck.
2. Prefer deleting unnecessary processes/layers before increasing CPU/RAM.
3. Separate MCPRelay overhead from the child workload it launches. A compiler/Python process consuming resources is not counted as idle relay overhead.
4. Record idle steady state and at least one representative tool-call state.
5. Report process-level RSS/CPU where practical and total incremental host effect when measurable.
6. Resource targets may be relaxed only by documented review based on measurements and capability value.

## 2. VPS baseline capacity

The architecture should be able to operate on a **1 vCPU / 1 GiB RAM** VPS for the initial one/few-node private deployment, assuming that VPS has reasonable network connectivity and is not already memory-starved by unrelated workloads.

MCPRelay must not require compute-oriented VPS sizing.

Initial measurement target for the MCPRelay-specific VPS stack at idle:
- no sustained CPU load without requests;
- target incremental RSS <= 200 MiB;
- >300 MiB incremental idle RSS requires investigation/justification before acceptance;
- no swap thrashing/OOM under the M1 representative request path.

These are optimization budgets, not an excuse to fail a functionally valid compatibility spike before measurements exist.

## 3. Windows node budget

Initial target for node-side relay components (excluding tool-launched child workloads):
- idle CPU approximately quiescent; sustained >1% on an otherwise idle test machine requires investigation;
- target aggregate idle RSS <= 300 MiB;
- >400 MiB aggregate idle RSS requires investigation/justification;
- no Docker Desktop/VM required by MCPRelay;
- background network traffic should be limited to tunnel keepalive/necessary control traffic when idle.

M1 must record the actual process tree so we know which component dominates memory.

## 4. Network/latency budget

M1 should record:
- client -> public MCP endpoint round-trip for a small representative tool call;
- tunnel/gateway overhead where it can be reasonably isolated;
- reconnect behavior observed during a controlled process/network restart if WO scope includes it.

No hard latency SLO is frozen in M1 because Internet/LLM/client latency dominates. The review focus is avoiding obvious architecture-added seconds of latency for small local calls.

## 5. Disk/package budget

M1 records dependency/runtime footprint only. Do not optimize installer size before packaging begins.

M3 will set package-size budgets after the exact frozen runtime/dependency set is measured. Production packaging must not download mutable `latest` dependencies on every start.

## 6. Scale assumptions

Initial design assumption: private use, low concurrency, a small number of nodes/agents. Do not optimize for hundreds/thousands of nodes until that becomes a real requirement.
