# Example: install and use dsh-subagent-qoder-cloud

# 1. Install into your dsh web profile
dsh plugin --profile web add /path/to/dsh-subagent-qoder-cloud

# 2. Create a cordis patch overlay: ~/.dsh/profiles/web/cordis.patch.yml
#    (or pass --patch ./qoder-cloud.yml at launch)
cat > qoder-cloud.yml << 'EOF'
- insert:
    - id: subagent-qoder-cloud
      name: dsh-subagent-qoder-cloud
      config:
        agentId: agent_019e390add9f7bac9b6cc806db46fcbd
        environmentId: env_019e2590d33f711fabf42f2857cecd8a

    - id: tool-subagent-qoder
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: qoder-cloud
        toolName: delegate_to_cloud
        backgroundMode: one-shot
EOF

# 3. Launch with the patch
export QODER_PAT="pt-your-token-here"
dsh web --patch ./qoder-cloud.yml

# 4. Now the model has a "delegate_to_cloud" tool that sends work to Qoder Cloud
