# Engineering Principles

These rules are mandatory for architecture, implementation, testing, packaging and review.

## 1. Minimal solution first

Choose the smallest design that satisfies the current functional target, ingress security and basic operational reliability.

Do not add a component, wrapper, service, daemon, database, abstraction, protocol, queue, cache, policy engine, control plane, UI or compatibility layer merely because it may become useful later.

For every permanent component, review must be able to answer:

- What current requirement or observed failure does this component solve?
- Why can an existing component or simple configuration not solve it?
- What breaks if we remove it?
- Is the maintenance burden smaller than the problem it prevents?

If these questions do not have concrete answers, the default decision is deletion/non-adoption.

## 2. Existing software before custom infrastructure

Prefer mature, narrowly scoped open-source components over custom implementation for commodity infrastructure such as TLS, OAuth, reverse tunneling and MCP transport adaptation.

A custom tunnel, auth server, MCP transport or device-control protocol requires evidence that available components cannot meet a proven requirement.

## 3. One concern, one enforcement layer

Each concern should have one primary owner. The current candidates are named in parentheses (see ADR-0002):

- TLS ingress (existing VPS proxy or Caddy): public TLS termination/routing.
- MCP gateway: public MCP authentication and backend aggregation.
- Reverse tunnel (OpenSSH reverse forward; rathole/frp fallback): outbound NAT traversal.
- Local adapter (Supergateway or minimal SDK bridge): stdio-to-Streamable-HTTP adaptation.
- Desktop Commander: local tools and execution.

Do not duplicate TLS, auth, policy or routing at multiple layers without a demonstrated failure mode.

## 4. No abstraction before demonstrated reuse

Do not build a generic node framework, plugin system, device registry, installer framework or cross-platform abstraction until the first working Windows path identifies the exact shared contract.

Linux is planned, but Windows is implemented first. Shared code is extracted only after a second real platform/use case shows what is actually common.

## 5. Vertical slice before platform work

The first milestone is a real end-to-end call from a remote MCP client to a Windows tool. Packaging, dashboards, fleet management and generalized configuration come later.

A beautiful installer around an unproven network/auth stack is not progress.

## 6. Security protects the real boundary

The first-stage trust model is private/self-use. Spend security complexity at the real public boundary:

- encrypted transport;
- authenticated public MCP ingress;
- no node-side public MCP listener;
- no secrets in Git/log evidence;
- loopback-only VPS backend exposure where possible.

Do not create enterprise RBAC, local policy engines or speculative hostile-insider defenses in v0.x unless a concrete requirement appears.

## 7. Outbound node connectivity by default

A node should work behind NAT/dynamic residential networking and should not require inbound port forwarding. The node initiates and maintains its connection to the VPS.

A general VPN is not justified while MCPRelay is the only required cross-network service.

## 8. Resource efficiency is an acceptance criterion

Idle CPU/RAM and incremental VPS resource consumption must be measured for meaningful milestones. Software inefficiency is not solved by upgrading hardware without review.

No VPS upgrade should be proposed solely for MCPRelay until measured evidence shows the current host is a real bottleneck.

## 9. Evidence should be sufficient, not maximal

Keep the minimum evidence required to reproduce and independently review behavior:

- exact code/dependency version;
- relevant configuration with secrets removed;
- commands/tests executed;
- CI result;
- representative end-to-end request/result;
- resource measurements where required;
- known failures/blockers.

Do not build a separate evidence platform, receipt framework or telemetry database.

## 10. Tests protect behavior, not ceremony

Prioritize tests for:

- public endpoint authentication behavior;
- tunnel/backend reachability boundaries;
- MCP protocol/tool invocation compatibility;
- restart/reconnect behavior when introduced;
- installer/service lifecycle when introduced;
- previously observed regressions.

Do not preserve unnecessary architecture merely because tests were written around it.

## 11. Minimalism review is continuous

Every substantial Work Order and every independent review must explicitly ask:

1. Did this change add a new permanent component/dependency/process?
2. Is each addition required by the current milestone?
3. Can any existing layer now be deleted?
4. Did a temporary spike accidentally become production architecture?
5. Did code/config/test volume grow faster than the capability delivered?

A change may be functionally correct and still be REOPENED for unnecessary complexity.
