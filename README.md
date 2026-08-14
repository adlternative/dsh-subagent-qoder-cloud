# dsh-subagent-qoder-cloud

DeepSeek Harness (dsh) subagent provider — 将任务委派给 **Qoder Cloud Agents** 执行。

## 安装

```bash
dsh plugin --profile web add github:adlternative/dsh-subagent-qoder-cloud
```

然后编辑 `~/.dsh/profiles/web/cordis.patch.yml`，添加插件注册（详见 [INSTALL.md](INSTALL.md)）。

## 零配置启动

只需一个环境变量 `QODER_CLOUD_PAT`，插件自动完成：
- 查找/创建 Cloud Agent（"深度研究"、"仓库分析"）
- 查找/创建 Cloud Environment（首个 cloud + unrestricted）
- 根据 prompt 内容自动路由到合适的 agent

```bash
export QODER_CLOUD_PAT="pt-your-token-here"  # 从 https://qoder.com/cloud/secrets 获取
dsh --profile web --patch ./qoder-cloud-patch.yml
```

## 自定义配置

用户可以指定自己的 agent 和 environment：

```yaml
# qoder-cloud-patch.yml
- insert:
    - id: subagent-qoder-cloud
      name: /path/to/dsh-subagent-qoder-cloud/src/index.js
      config:
        # ─── 认证 ───
        patEnv: QODER_CLOUD_PAT         # 环境变量名（必填）

        # ─── 可选：指定 Agent ───
        agentId: agent_xxxxxxxxxxxx      # 指定后跳过自动路由，所有任务用此 agent

        # ─── 可选：指定 Environment ───
        environmentId: env_xxxxxxxxxxxx  # 指定后跳过自动发现

        # ─── 可选：其他 ───
        apiBase: https://api.qoder.com/api/v1/cloud   # API 网关地址
        providerName: qoder-cloud        # 注册到 ctx.subagents 的名字
        timeoutMs: 600000                # 单次运行超时（默认 10 分钟）

- id: tool-subagent
  config:
    provider: qoder-cloud
    toolName: subagent
    backgroundMode: one-shot
    maxDepth: provider-managed
```

## 配置优先级

| 配置项 | 指定时 | 未指定时（默认行为） |
|--------|--------|---------------------|
| `agentId` | 所有任务固定用该 agent | 根据 prompt 自动路由：含 GitHub URL → "仓库分析"，其他 → "深度研究" |
| `environmentId` | 固定用该 env | 自动查找首个 `type=cloud` + `network=unrestricted` 的 env；没有则创建 |
| `patEnv` | 从指定的环境变量读 PAT | 默认读 `QODER_CLOUD_PAT` |
| `apiBase` | 用指定地址 | `https://api.qoder.com/api/v1/cloud` |
| `timeoutMs` | 用指定超时 | 600000ms (10 分钟) |

## 自动路由规则

当 `agentId` 未指定时，插件根据 prompt 内容选择 agent：

| 检测条件 | 选择 Agent | 工具集 |
|----------|-----------|--------|
| 含 `github.com/user/repo` URL | **仓库分析** (ultimate) | Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch |
| 含 "仓库/repo/源码分析/架构分析" | **仓库分析** (ultimate) | 同上 |
| 其他（默认） | **深度研究** (auto) | Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, ImageSearch, ImageGen, DeliverArtifacts |

首次使用时，若 agent 不存在会自动创建。

## 使用场景示例

### 场景 1：用默认配置做调研
```yaml
config:
  patEnv: QODER_CLOUD_PAT
  # 自动路由 + 自动发现 env
```

### 场景 2：团队共享固定 Agent
```yaml
config:
  patEnv: TEAM_QODER_PAT
  agentId: agent_xxxxxxxxxxxxxxxxxxxx      # 团队定制的 agent
  environmentId: env_xxxxxxxxxxxxxxxxxxxx   # 团队专用 env
```

### 场景 3：使用私有部署
```yaml
config:
  patEnv: QODER_CLOUD_PAT
  apiBase: https://your-company.qoder.com/api/v1/cloud
  environmentId: env_your_private_env
```

## 架构

```
dsh 本地模型
  ↓ 调用 subagent tool (prompt: "分析 github.com/foo/bar")
  ↓
dsh-subagent-qoder-cloud 插件
  ├── detectAgentType(prompt) → "仓库分析"
  ├── ensureAgent("仓库分析") → 找到/创建 agent_xxx
  ├── ensureEnvironment() → 找到/创建 env_xxx
  ├── POST /sessions (agent + env)
  ├── GET  /sessions/{id}/events/stream (SSE)
  ├── POST /sessions/{id}/events (push user.message)
  │    ↓ Cloud Agent: git clone → Read → Grep → WebSearch → 回复
  └── 收到 session.status_idle → 返回结果
  ↓
dsh 主模型拿到分析报告
```

## 内置 Agent 定义

### 深度研究
- 模型：auto
- System：拆解子问题 → 搜索权威来源 → 完整阅读 → 综合报告（行内引用 + 置信度分析）
- 工具：WebSearch, WebFetch, Bash, Read, Write, Edit, Glob, Grep, ImageSearch, ImageGen, DeliverArtifacts

### 仓库分析
- 模型：ultimate
- System：git clone → 结构分析 → 源码深入 → 输出架构报告（含目录树 + 代码引用）
- 工具：Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch

## 要求

- Node.js ≥ 22
- dsh ≥ 0.1.0-rc.5
- `QODER_CLOUD_PAT` 环境变量（从 [qoder.com/cloud/secrets](https://qoder.com/cloud/secrets) 获取 PAT）
