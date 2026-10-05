# openAgents

面向自己或可信团队的通用 Agent 底座。保留 OpenHands 的执行引擎与 Canvas，通过业务工具、完整 system prompt 和 Skills 接入新的智能体业务。

本仓库同时包含修改后的前端与 Agent Server/SDK/TypeScript 客户端，避免只上传界面而缺少后端实现。当前为开发版本，使用随仓库提供的本地 SDK，不依赖尚未发布的新接口。

| 目录                                            | 内容                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `canvas/`                                       | 智能体选择、业务包管理、通用会话、任务、审批、成果、业务 UI 扩展        |
| `software-agent-sdk/`                           | 完整配置解析、真实 SDK 执行、持久任务、委派、审批、成果服务及规范客户端 |
| `software-agent-sdk/examples/agent_foundation/` | 研究与运营两个示例业务、工具、prompt、Skills                            |
| `canvas/docs/general-agent-foundation.md`       | 架构、契约、恢复边界、调研依据                                          |
| `canvas/specs/general-agent-foundation.md`      | 稳定行为规格及验收要求                                                  |

## 启动

准备 Node.js 24+、Python 3.12+、uv。推荐在 Linux 或 WSL2 部署；锁定的 LiteLLM 包包含 Rust 扩展，安装环境需要可用的 Rust 构建工具。使用已有浏览器访问界面。

```sh
git clone https://github.com/study-wzl/openAgents.git
cd openAgents
npm run setup
npm start
```

打开 `http://127.0.0.1:8000`。启动器仅监听本机，关闭产品遥测；状态、凭据引用、任务和成果保存在 `.runtime/`。端口和状态目录可通过 `.env` 配置，参见 `.env.example`。`Ctrl+C` 停止本次启动的进程，历史记录保留。

第一次使用，在设置的模型 Profiles 中保存名为 **`business`** 的模型配置及对应服务端密钥，然后在首页输入以下业务包的**服务端绝对路径**，校验并安装：

```text
<本仓库>/software-agent-sdk/examples/agent_foundation/research
<本仓库>/software-agent-sdk/examples/agent_foundation/operations
```

选择协调助手并输入任务。它可调用两个专家，专家使用各自配置及独立目录。运营示例的写操作需要在任务面板确认；完成后可下载报告。示例使用演示数据，不创建真实业务工单。普通运行使用真实模型，自动验收只替换模型响应。

## 增加业务

1. 复制一个示例包，修改包 ID、版本、智能体、完整 prompt 和 `SKILL.md`。
2. 工具使用 MCP，或部署时注册 Python 工具并在清单中引用注册名；可在 `.env` 设置 `OPENAGENTS_TOOL_MODULES=my_business.tools` 和 `OH_EXTRA_PYTHON_PATH` 加载自己的已安装工具模块。运行任务时不会安装依赖或导入包内任意代码。
3. 声明每个工具的确认、超时与取消策略，以及允许委派的专家。凭据保留服务端引用。
4. 在首页验证、安装业务包。可选表单和结果卡片使用独立安装、显式启用的 Canvas Extension。

业务 prompt 完整替换 coding 默认值；显式工具和 Skills 不继承全局插件或长期记忆。包更新仅影响新任务，历史保留版本摘要和资源。工具实现、远程 MCP 与模型配置仍属于部署环境，变化后可能阻止旧任务恢复。

服务重启后需要人工恢复；结果不明的写调用必须先核实，填写依据并记录执行结果，再显式恢复。停止请求不表示撤销外部操作。第一版只支持单 Agent Server、一层委派和最多四个并行专家。

## 开发与验证

修改 SDK 后，在 Canvas 目录设置 `OH_AGENT_SERVER_LOCAL_PATH` 为 SDK 绝对路径，执行 `npm run sdk:local` 后再测试或构建。`npm ci` 会恢复 npm 发布客户端，所以每次重装依赖后都需要重新准备本地客户端。

```sh
cd canvas
npm test
npm run lint
npm run build
npm run build:lib
npm run check-translation-completeness
npm run test:e2e:foundation
```

浏览器验收前需 `npx playwright install chromium`，SDK 需已安装 dev 依赖。验收启动真实 Agent Server，以确定性模型响应检查委派、审批、成果与刷新；详细结果及环境限制见 [验证记录](VALIDATION.md)。

后端测试与客户端测试在 SDK 目录运行，参见 [示例说明](software-agent-sdk/examples/agent_foundation/README.md) 与架构文档。公共库导出保留兼容；Cloud/ACP/自动化的底层代码保留，首期新业务只验收自托管 OpenHands 路径。

本项目基于 MIT 开源的 OpenHands，来源与版本见 [UPSTREAM.md](UPSTREAM.md)。
