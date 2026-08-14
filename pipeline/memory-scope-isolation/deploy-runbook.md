## 环境要求

- FR-7:`jq`、`node`、`curl`;本机 3111 端口 worker 已由 FR-6(T-B1)拉起且可探活(`http://localhost:3111/agentmemory/livez` 返回 200);鉴权密钥取 `$AGENTMEMORY_SECRET` 或回落 `~/.config/agentmemory/service.env`(占位符,真实值见该文件,不在此列出)。
- 工作树构建产物 `/home/ky/git/source-project/agentmemory/dist/standalone.mjs` 须已是含补丁的新产物(T-B0 前置,`grep -c agentId dist/standalone.mjs` 非零)。

## 部署步骤

### FR-7 | MCP stdio 主路径切到工作树构建产物(两份 `.mcp.json` 同改)

1. 解析客户端实际加载的插件缓存路径:
   ```
   jq -r '.plugins["agentmemory@agentmemory"][0].installPath // empty' ~/.claude/plugins/installed_plugins.json
   ```
   预期输出:`/home/ky/.claude/plugins/cache/agentmemory/agentmemory/0.9.28`(取不到时回落该路径)。

2. 备份两份(先备份再写):
   ```
   cp -p /home/ky/.claude/plugins/cache/agentmemory/agentmemory/0.9.28/.mcp.json /home/ky/.local/state/agentmemory-msi-mcp/plugin-cache-0.9.28.mcp.json.pre-msi.bak
   cp -p /home/ky/git/source-project/agentmemory/plugin/.mcp.json /home/ky/.local/state/agentmemory-msi-mcp/repo-plugin.mcp.json.pre-msi.bak
   ```
   预期输出:两份备份文件生成,`diff` 备份与源文件为空(内容一致)。

3. 写仓库那份(先写仓库,再写缓存),只替换 `command`/`args` 两键,`env` 原样保留:
   ```
   jq --arg target "/home/ky/git/source-project/agentmemory/dist/standalone.mjs" \
     '.mcpServers.agentmemory.command = "node" | .mcpServers.agentmemory.args = [$target]' \
     /home/ky/git/source-project/agentmemory/plugin/.mcp.json > /tmp/repo.mcp.json.tmp \
     && mv /tmp/repo.mcp.json.tmp /home/ky/git/source-project/agentmemory/plugin/.mcp.json
   ```
   预期输出(写后 `command`/`args`):`command="node"`,`args=["/home/ky/git/source-project/agentmemory/dist/standalone.mjs"]`,`env` 三项不变。

4. 写缓存那份(与步骤 3 等价,目标文件换成缓存路径):
   ```
   jq --arg target "/home/ky/git/source-project/agentmemory/dist/standalone.mjs" \
     '.mcpServers.agentmemory.command = "node" | .mcpServers.agentmemory.args = [$target]' \
     /home/ky/.claude/plugins/cache/agentmemory/agentmemory/0.9.28/.mcp.json > /tmp/cache.mcp.json.tmp \
     && mv /tmp/cache.mcp.json.tmp /home/ky/.claude/plugins/cache/agentmemory/agentmemory/0.9.28/.mcp.json
   ```
   预期输出:写后与步骤 3 结果逐字一致(`diff` 两份为空)。

5. 探活验证(实跑判据):
   ```
   bash pipeline/memory-scope-isolation/generated/cases/C-FR7-1.sh    # 仓库配置层
   bash pipeline/memory-scope-isolation/generated/cases/C-FR7-1b.sh   # 运行态配置层 + 两份一致性
   bash pipeline/memory-scope-isolation/generated/cases/C-FR7-2.sh    # 制品层:真实 MCP stdio 协议写入 + worker 读回
   ```
   预期输出:三条均 `CASE ... PASS`,exit 0。`C-FR7-2` 会向真实记忆库写入一条 `concepts` 含 `pipeline-probe` 的探针记录(design.md 风险 R-4,已被接受,不在此清理)。

6. 客户端层生效(`C-FR7-3`,人工/manual,不阻塞本卡):改动只对**下次**新建立的 MCP stdio 连接生效,需人工重启或重连宿主 MCP 客户端后再发一次 `memory_save` 核验落库记录带 `agentId`;观察时点须确认两份文件仍指向工作树产物。

## 回滚步骤

### FR-7

1. 缓存那份回滚(用备份覆盖回去):
   ```
   cp -p /home/ky/.local/state/agentmemory-msi-mcp/plugin-cache-0.9.28.mcp.json.pre-msi.bak /home/ky/.claude/plugins/cache/agentmemory/agentmemory/0.9.28/.mcp.json
   ```
   等效退路:重装插件会用仓库内容重新铺开缓存那份。

2. 仓库那份回滚(用备份覆盖回去):
   ```
   cp -p /home/ky/.local/state/agentmemory-msi-mcp/repo-plugin.mcp.json.pre-msi.bak /home/ky/git/source-project/agentmemory/plugin/.mcp.json
   ```
   等效退路:`git show HEAD:plugin/.mcp.json`(仓库那份受版本控制,备份之外的第二回滚源)。

3. 一致性说明:两份可单独回滚,但**只回滚一份会造成发布态与运行态不一致**;正常情况下要么两份同回,只回一份须在当次操作记录里写明理由与后续处置。回滚后两份 `command`/`args` 均应回到 `"npx"` / `["-y","@agentmemory/mcp"]`,`env` 不变;无其它状态需还原。

## 待确认红线

- `C-FR7-3`(人工重启/重连宿主 MCP 客户端后核验落库)为 manual 项,已在 s2b/s3 登记 `uncovered`,不阻塞本卡;需在客户端下次实际重启/重连时由人工核验,不由本 runbook 自动触发重启操作。
- 仓库那份 `plugin/.mcp.json` 写入了本机绝对路径,随插件对外发布前必须改回 `npx -y @agentmemory/mcp`(design.md R-3 约束①),本次不做自动拦截,列为长期注意事项交 s6 收尾登记,不在本卡处理。
