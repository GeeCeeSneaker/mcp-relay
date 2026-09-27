# Development Log

This log records durable project-level development and review events. It is not a substitute for Work Orders or PR discussion.

## 2026-09-27 — Project governance bootstrap

- Repository baseline before bootstrap: `main@9c2ff1c44eaf31afdb42037c7327f6734a58b6ad`.
- Established project charter, engineering principles, architecture hypothesis, development governance, work-order protocol, roadmap, current execution plan and resource budgets.
- Recorded ADR-0001 selecting the minimum current architecture hypothesis: Desktop Commander + Supergateway + rathole client on the Windows node; rathole server + MCP gateway + Caddy on the VPS.
- Explicitly rejected WireGuard, ToolHive, HAProxy, Docker Desktop, local TLS/OAuth, a management UI and a custom long-connection protocol for the initial implementation because no current requirement justifies them.
- Established the permanent Reviewer boundary: repository/PR/Issue/CI/evidence review is authorized; local/VPS operation is not authorized unless the Owner explicitly grants it for a specific action.
- Published WO-0001 for a minimal Windows-to-VPS-to-ChatGPT end-to-end proof.

Review status: governance bootstrap authorized by Owner request; implementation has not started.
