# 安装指南

## 前置条件

- dsh ≥ 0.1.0-rc.5 已安装（`npm install -g @deepseek-ai/dsh --registry https://registry.npmjs.org`）
- 有 Qoder Cloud PAT（从 [qoder.com/cloud/secrets](https://qoder.com/cloud/secrets) 获取）
- 设置环境变量：`export QODER_CLOUD_PAT="pt-your-token-here"`（加到 `~/.zshrc` 或 `~/.bashrc`）

## 步骤 1：安装插件到 dsh profile

```bash
# 方式 A：从 GitHub 安装
dsh plugin --profile web add github:anthropics/dsh-subagent-qoder-cloud

# 方式 B：从 git 仓库安装
dsh plugin --profile web add git+https://github.com/anthropics/dsh-subagent-qoder-cloud.git

# 方式 C：从本地目录 link（开发用）
dsh plugin --profile web link /path/to/dsh-subagent-qoder-cloud
```

## 步骤 2：配置 cordis patch

编辑 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
# Qoder Cloud subagent
- insert:
    - id: subagent-qoder-cloud
      name: dsh-subagent-qoder-cloud
      config:
        patEnv: QODER_CLOUD_PAT
        # agentId: agent_xxx          # 可选：锁定特定 agent
        # environmentId: env_xxx      # 可选：锁定特定 environment
        # timeoutMs: 600000           # 可选：超时设置

# 将 subagent tool 绑定到 qoder-cloud provider
- id: tool-subagent
  config:
    provider: qoder-cloud
    toolName: subagent
    backgroundMode: one-shot
    maxDepth: provider-managed
```

## 步骤 3：修改 standard preset（使 preset 内的 subagent 也走 qoder-cloud）

```bash
# 找到 preset 文件
PRESET=$(node -e "console.log(require.resolve('@deepseek-ai/dsh/config/agent-presets/standard/agent.cordis.yml'))")
echo "Preset file: $PRESET"

# 修改 tool-subagent 的 provider（约第 189 行）
# 将 provider: spawn 改为 provider: qoder-cloud
# 将 backgroundMode: continuable 改为 backgroundMode: one-shot
# 添加 maxDepth: provider-managed
```

或者手动编辑 `$PRESET`，找到：
```yaml
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        backgroundMode: continuable
```

改为：
```yaml
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: qoder-cloud
        toolName: subagent
        backgroundMode: one-shot
        maxDepth: provider-managed
```

## 步骤 4：启动

```bash
# Web UI
dsh web
# 或 headless 模式
dsh --profile headless "用 subagent 调研 xxx"
```

## 验证安装

```bash
# 检查插件是否在组合树中
dsh --profile web --dump-config | grep subagent-qoder-cloud

# 检查 tool-subagent 是否指向 qoder-cloud
dsh --profile web --dump-config | grep -A4 "id: tool-subagent$"

# 测试运行
dsh --profile headless "用 subagent 搜索 TypeScript 最新版本号，一句话回答"
```

## 快速启动（临时测试，不修改 profile）

不想改 profile 文件？用 `--patch` 临时加载：

```bash
# 创建 patch 文件
cat > /tmp/qoder-cloud.yml << 'EOF'
- insert:
    - id: subagent-qoder-cloud
      name: dsh-subagent-qoder-cloud
      config:
        patEnv: QODER_CLOUD_PAT
- id: tool-subagent
  config:
    provider: qoder-cloud
    toolName: subagent
    backgroundMode: one-shot
    maxDepth: provider-managed
EOF

# 启动（插件已通过步骤 1 安装）
export QODER_CLOUD_PAT="pt-your-token"  # 从 https://qoder.com/cloud/secrets 获取
dsh --profile web --patch /tmp/qoder-cloud.yml
```

如果未安装插件，也可以直接指向源码路径（开发/测试用）：

```bash
# 克隆到本地
git clone https://github.com/anthropics/dsh-subagent-qoder-cloud.git
cd dsh-subagent-qoder-cloud && npm install

# patch 中用绝对路径
cat > /tmp/qoder-cloud.yml << EOF
- insert:
    - id: subagent-qoder-cloud
      name: $(pwd)/src/index.js
      config:
        patEnv: QODER_CLOUD_PAT
- id: tool-subagent
  config:
    provider: qoder-cloud
    toolName: subagent
    backgroundMode: one-shot
    maxDepth: provider-managed
EOF

export QODER_CLOUD_PAT="pt-your-token"
dsh --profile web --patch /tmp/qoder-cloud.yml
```

## 卸载

```bash
# 移除插件
dsh plugin --profile web remove dsh-subagent-qoder-cloud

# 恢复 cordis.patch.yml（删除插入的部分）
# 恢复 standard preset 的 tool-subagent 为 provider: spawn
```
