# mcp-relay 安全审计与修复建议（2026-10-23）

本报告由 Owner 要求推送到对应项目仓库，供现有开发和维护流程使用。状态为**审计发现与工作建议，尚未实施修复或完成部署验收**。

审计与发布前复核基线：默认分支 `main`，提交 `a8910d390ba276a578d6b8f0ee2475430d28a909`。本轮复核时 HEAD 未变化。结论绑定该代码快照；未来修复应另附实现提交与实际运行版本。

## 结论与证据边界

应优先更新 Windows 内置 Node 和 VPS 安装器固定的 uv，并补齐实际部署版本、鉴权配置和网关依赖清单。已确认的是仓库的打包/安装配置落后于安全修复基线；没有证据证明服务已遭入侵，也未验证各公告的所有利用条件。

本轮读取了组件清单、生产与测试 npm 锁文件、Windows 构建脚本、VPS 安装脚本、`node-runtime/server.mjs` 及固定上游网关依赖。网关状态曾显示节点在线，但能力目录与只读调用返回 `Unknown tool`，故未取得 Windows/VPS 的实际进程、监听、安装包或容器证据。OSV 批量查询因分析环境网络不可用未完成；本报告采用官方公告、上游修补与代码逐项核对，不代表全量自动扫描通过。

## 需要处理的发现

### MCP-SEC-01：内置 Node 24.21.0 低于安全修复基线（P1）

[`components.lock`](https://github.com/GeeCeeSneaker/mcp-relay/blob/a8910d390ba276a578d6b8f0ee2475430d28a909/components.lock)和 [`packaging/windows/build.ps1`](https://github.com/GeeCeeSneaker/mcp-relay/blob/a8910d390ba276a578d6b8f0ee2475430d28a909/packaging/windows/build.ps1#L12)均固定 Node `v24.21.0`。[Node 官方 2026-10-21 安全发布](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)给出的 24.x 修复版本为 `24.22.1`，包括 Brotli 越界写（CVE-2026-111497）及 TLS/DNS 等修补。

最小修复是同时更新构建版本、对应官方工件 SHA256 和组件清单，重新构建安装包，随后核对实际启动的内置 `node.exe` 路径及版本。只更新系统 PATH 中的 Node 无法替换已安装的内置运行时。当前服务源码未发现直接 Brotli 调用，不能将该版本命中直接宣称为 relay 公网 RCE。

### MCP-SEC-02：安装器固定旧 uv，可能保留受影响 CA（P1）

[`scripts/vps-install.sh`](https://github.com/GeeCeeSneaker/mcp-relay/blob/a8910d390ba276a578d6b8f0ee2475430d28a909/scripts/vps-install.sh#L19)固定 `UV_VERSION=0.12.19`，随后使用它获取 Python 和安装网关。根据 [uv 官方公告](https://github.com/astral-sh/uv/security/advisories/GHSA-hq85-5cpj-mr62)，默认内置 CA 模式需要升级至 `0.13.4`；[Python 安全团队说明](https://discuss.python.org/t/information-for-python-users-regarding-emudhra-emsign-ca-certificate-security-incident/109576)另推荐 `certifi>=2026.10.19`、`pip>=26.2.2`。这些是此次 CA 事件的基线，不是所有未来漏洞的安全保证。

最小修复是同步更新 uv 版本与下载校验和，先修安装工具信任链，再更新实际使用的 Python 环境。脚本重跑不能恢复旧 uv。pip 自带 certifi，不能用“业务 venv 的 certifi 已更新”代替 pip 的核验；系统/自定义 CA 只有在明确配置并已移除受影响证书时才构成对应缓解条件。

### MCP-SEC-03：网关真实依赖和鉴权边界仍待核验

网关固定上游 `R0Wi/mcp-gateway@59c1efd00e0c1baea4ed7861429200d2d6be0e83`，并应用本仓库补丁，但上游仅声明依赖范围、没有完整 `uv.lock`。因此不能由源码提交固定推断已部署 FastAPI、Starlette、Python MCP 或 certifi 的确切版本。维护时保存实际依赖清单或沿用现有部署方式补充可复现锁定即可，不需要新建依赖管理平台。

[`node-runtime/server.mjs`](https://github.com/GeeCeeSneaker/mcp-relay/blob/a8910d390ba276a578d6b8f0ee2475430d28a909/node-runtime/server.mjs#L52)仅在 `MCPRELAY_BRIDGE_TOKEN` 非空时执行固定 Bearer 比较；为空时 `authorized()` 返回 true。默认监听 `127.0.0.1`，但实际监听与 token 是否配置未取得现场证据。应确认现有部署的入口鉴权确实生效，尤其是可被其他用户或网络访问的入口；核验只记录“已配置/未配置”，不得输出真实 token。

## MCP SDK / Hono 公告的实际适用性

生产锁定 `@modelcontextprotocol/server 2.2.0`、`@modelcontextprotocol/node 2.1.0`；测试锁定 `sdk 1.30.1`、`client 2.2.0`。代码使用 `createMcpHandler(mcpServer)` 工厂，每次创建低层 `Server` 并自行校验工具参数。

| 公告 | 本项目判断 | 工作建议 |
| --- | --- | --- |
| [GHSA-46jr-4wx8-v453 / CVE-2026-111768](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-46jr-4wx8-v453)，输入验证内存耗尽 | 版本落入范围，但上游元素预算修补作用于高层 `McpServer`，本项目使用低层 `Server`，该放大路径尚未证实可达 | 可更新兼容 SDK，并按真实负载设置 `createMcpHandler` 的请求体上限及自有参数预算；不要把 `McpServer` 专属选项传给 `new Server`；仅升级不等于启用新限制 |
| [GHSA-jm63-cq47-j5jp](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-jm63-cq47-j5jp)，共享实例串会话 | 每次通过工厂创建 Server，未满足共享实例条件 | 保留工厂用法，普通回归即可 |
| [GHSA-rvq5-wwqv-78pq](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-rvq5-wwqv-78pq)，OAuth audience | 当前使用专属固定 token，未使用 SDK OAuth 验证器 | 不报为已确认 OAuth 漏洞；实际 token 配置仍需核验 |
| [Hono GHSA-5r4p-p66f-jhc7](https://github.com/honojs/hono/security/advisories/GHSA-5r4p-p66f-jhc7)及 [node-server GHSA-rmxm-3fg6-px4f](https://github.com/honojs/node-server/security/advisories/GHSA-rmxm-3fg6-px4f) | 未调用 `serveStatic`，没有相应静态文件路径入口 | 不为未发现的利用路径强行升级不兼容的传递依赖 |
| [GHSA-6prh-2h8m-c8cw / CVE-2026-111769](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6prh-2h8m-c8cw)，跨源跳转传递自定义头/请求体 | 当前仅确认测试依赖版本命中，未证实生产客户端路径 | 维护测试依赖时将 sdk 升至 `1.32.0`、client 升至 `2.3.0` 或更新兼容修复版；核对测试目标与跳转行为 |

旧组件清单中记录的 `npm audit 0` 属于当时检查结果，不能代替本次公告核对。没有 `taskStore`，也不能把其他 SDK 世代的 taskStore 公告套到本项目。

## 建议的最小工作包与验收

建议沿用当前开发/部署流程，将 Node/uv 版本与校验和、组件清单、兼容 SDK 维护合为一个有边界的安全维护工作包；运行态证据由现有 Controller/维护者补充。此报告不替代正式任务绑定，不发起 Controller 执行，也不改变本项目现有信任和角色边界。

验收需要同时满足：新 Windows 工件内置 Node 达到修复基线；安装器重跑不会恢复旧 uv；实际使用的 pip/certifi/CA 已逐项核验；缺失或错误凭据仍被既有受控入口拒绝；正常连接、能力目录、只读调用及断线恢复通过现有烟测。现场输出只保留版本、路径、配置存在性及脱敏结果。网关“在线”与实际工具可调用是两项证据，需恢复并成功执行能力目录与一项只读操作后才能关闭运行态缺口。

另外核对目标环境是否在 [LiteLLM 2026-10-21 投毒窗口](https://docs.litellm.ai/blog/security-incident-oct-21-2026)使用过恶意 `1.107.0` 工件。仓库未发现直接依赖不等于主机无历史安装；疑似环境先用系统工具读取包元数据和镜像记录，避免先启动 Python/pip。仅在确认恶意工件执行或其他失陷证据后，才进入隔离、重建和相关凭据轮换。

关闭发现时记录实现提交、安装工件/版本、实际运行路径及对应验收结果。未取得现场证据的条目继续保持待核实，不以文档提交或构建成功代替部署验收。
