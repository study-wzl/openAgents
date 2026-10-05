# 验证记录

验证日期：2026-10-05。环境：Windows x64、Node.js 24.21.0、Python 3.12.10。使用真实 Agent Server、SDK 会话、工具、任务服务和 SQLite；模型响应使用确定性替身。

| 检查                          | 结果                                                       |
| ----------------------------- | ---------------------------------------------------------- |
| Canvas 全量单元测试           | 8,099 通过，0 失败；保留上游 33 skipped、7 todo            |
| 最后界面修改后的聚焦回归      | 352 通过，覆盖消息、规划历史、确认按钮、通用任务和文件界面 |
| SDK TypeScript 客户端单元测试 | 349 通过，0 失败                                           |
| 真实后端 Chromium E2E         | 2 通过；批准和拒绝、两专家、刷新、成果下载                 |
| 业务 UI 示例                  | 3 个 Node 测试通过，清单与入口验证通过                     |
| Canvas lint、TypeScript、格式 | 通过；现有样式警告仍保留                                   |
| 客户端 lint / build           | 通过；现有类型风格警告仍保留                               |
| 应用与公共库构建              | 均通过                                                     |
| i18n 声明生成与完整性         | 通过；新增中文/英文，其他语言使用英文后备文本              |
| 修改的 Python 文件            | Ruff 通过；包管理、运行服务、客户端契约相关 Pyright 通过   |
| 统一启动器冒烟检查            | 首页 200、ready、能力声明正确；业务 API 未带密钥返回 401   |

后端最终组合验收 **576 通过，0 失败**，在最后恢复修复后统一执行，不重复计数。前端 352 项聚焦回归包含此前全量测试的部分用例，用于验证最后的历史只读修改，不累加为新的全量总数。

## 可重复执行的后端验收

在 SDK 目录完成 `uv sync --frozen --group dev` 后执行：

```sh
uv run --frozen pytest \
  tests/agent_server/test_foundation_packages.py \
  tests/agent_server/test_foundation_examples.py \
  tests/agent_server/test_agent_foundation_runtime.py \
  tests/agent_server/test_agent_foundation_store.py \
  tests/agent_server/test_event_service.py \
  tests/agent_server/canvas_extensions/test_canvas_extensions_manifest.py \
  tests/agent_server/test_server_details_router.py \
  tests/agent_server/test_openapi_contract.py \
  tests/agent_server/test_openapi_discriminator.py \
  tests/agent_server/test_api_authentication.py \
  tests/agent_server/test_agent_profile_conv_start.py \
  tests/sdk/agent/test_agent_serialization.py \
  tests/sdk/conversation/test_local_conversation_plugins.py \
  tests/sdk/profiles/test_resolver.py \
  tests/sdk/test_settings.py \
  tests/sdk/context/test_agent_context.py \
  tests/sdk/mcp/test_mcp_observation.py -q
```

验收检查真实模型输入的 prompt、工具与 Skills，包命名空间与环境隔离，MCP/Python 结构化结果与文件，一轮两个子任务的并发确认，拒绝/重复决定、停止和超时、软关闭及 RUNNING 硬退出快照、未知写调用的人工核验、跨子任务未知结果阻断、后续原生消息政策、成果授权下载、包生命周期和界面回退。

前端与浏览器命令在根 README 中；GitHub Actions 的根级 `foundation.yml` 使用本地 SDK 客户端构建，并运行相同验收。这里只记录本地实测结果，不预先声称远程 CI 已通过。

## 环境与部署限制

Windows 上锁定 LiteLLM 1.93.0 的 Rust 构建未完成；本地 Python 验证使用相同版本源码的纯 Python 路径，其余依赖已安装。EventService 中原有 `LLMStreamChunk` 类型别名在该后备环境有一处静态诊断；新增恢复和任务代码通过静态检查与真实 SDK 行为测试。这不等于完成 Windows 原生依赖的生产安装验收。统一启动器复用了准备好的依赖与构建目录进行冒烟检查；全新部署推荐 Linux/WSL2，并完成正常的锁定依赖安装。

未调用真实在线模型供应商或真实业务账号；示例工具操作演示数据。服务端、客户端和 Canvas 的上游版本号保留，新契约尚未发布，必须使用本仓库随附的本地 SDK。第一版只承诺可信团队单实例、一层委派和人工恢复。
