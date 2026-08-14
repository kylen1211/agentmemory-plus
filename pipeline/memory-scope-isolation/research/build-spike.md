# build-spike: 工作树 dist/cli.mjs 构建与拉起可行性验证

范围:纯技术可行性 spike,不改产品代码,不动 systemd/现网数据目录/npx 缓存。

## 已核验事实

1. **命题**:仓库能用 `npm run build` 成功产出 `dist/cli.mjs`(仓库此前从未构建过一次)。
   **命令**:`cd ~/git/source-project/agentmemory && time npm run build`(实际命令 = `tsdown && cp 若干静态文件到 dist/`)。
   **输出摘要**:构建成功,`real 0m4.583s`;`dist/cli.mjs` 105,446 字节(可执行位已置);`dist/` 总大小 5.6M,含 `index.mjs`(732KB)、`standalone.mjs`(50KB)、`cli.mjs` 及配套 chunk/`.map`/`iii-config.yaml`/`docker-compose.yml`/`.env.example`/`viewer/` 等 20+ 顶层文件,与 `package.json.files` 声明的发布物一致。
   **结论**:构建可行、耗时约 4.6 秒,产物完整,`npm run build` 无需额外前置步骤(`node_modules` 已存在,未触发 `npm install`)。
   **日期**:2026-08-14

2. **命题**:把 `ExecStart` 指向源码工作树构建出的 `dist/cli.mjs` 绝对路径,可以正常拉起 worker,且运行行为与当前全局包版本一致(无相对路径/环境依赖差异)。
   **命令**:未直接改 systemd(边界禁止),改用等价隔离手段验证——`node dist/cli.mjs --port 6111 --data-dir <scratch>/spike-data --verbose`,并列对照:同一隔离条件下用当前 systemd 实际在跑的全局包 `node /home/ky/.nvm/versions/node/v24.18.0/lib/node_modules/@agentmemory/agentmemory/dist/cli.mjs --port 6111 --data-dir <scratch>/spike-data-ctrl --verbose`;两次均用独立 `AGENTMEMORY_III_CONFIG`(端口改写副本)、独立 `AGENTMEMORY_SECRET`(非现网值)、独立 `--data-dir`,不触碰 `~/.agentmemory/`;`curl http://localhost:6111/agentmemory/livez` 核对两者响应一致性;结束后 `kill -9` 全部子进程,`ss -tlnp` 复核端口清空、`curl localhost:3111/agentmemory/livez` 复核现网未受影响。
   **输出摘要**:两次运行(workspace 构建 vs 全局包)行为逐项一致——都成功 resolve `~/.agentmemory/bin/iii`(基于 `$HOME`,与安装目录无关)、成功 spawn iii-engine、REST(6111)/Streams(6112)均正常监听、`[agentmemory] Starting worker v0.9.28...` 完整走完 embedding/LLM provider/知识图谱/编排层初始化;两者在非默认端口(6111)下都出现同一个既有产品行为(与本次工作树切换无关):`engine ws`(`restPort+46023` 端口,cli.mjs 侧公式)在两侧均 `ECONNREFUSED` 持续重连,`/agentmemory/livez` 两侧均返回 `404`——用生产默认端口 3111 对照(`~/.agentmemory/bin/iii` 在 3111 下确实监听 `*:49134` 且 `livez` 返回 `200 {"status":"ok",...}`),证明这是"非默认端口下 iii 引擎未开放 engine-ws 端口"的既有行为,与"从哪个目录启动 cli.mjs"无关(全局包在相同条件下复现了完全相同的现象)。两份 `dist/cli.mjs` 内容 md5 不同(tsdown 产物 chunk hash 非确定性,预期内),但版本号均为 `0.9.28`。
   **结论**:命题成立——workspace 构建产物 `dist/cli.mjs` 拉起行为与当前全局包版本一致,未观察到因安装位置差异导致的相对路径解析或环境依赖问题;`cli.mjs` 内部对配置文件的路径 fallback 虽用了 `import.meta.url`/`__dirname`,但生产 systemd 单元已用 `Environment=AGENTMEMORY_III_CONFIG=%h/.agentmemory/iii-config.yaml` 显式指定绝对路径覆盖该 fallback,`iii` 二进制的定位也基于 `homedir()` 而非包安装目录,因此切换 `ExecStart` 指向工作树不会引入新的路径解析差异。
   **日期**:2026-08-14

## 未能核验

- **命题**:真实 systemd `ExecStart` 切换后(而非手动 `node` 命令行模拟)能否正常拉起。
  **未能核验原因**:边界严格禁止修改/重启 `agentmemory.service`,本次只用手动 `node dist/cli.mjs` 命令行 + 显式环境变量模拟,未验证 systemd `EnvironmentFile`/`%h` 展开、`Restart=always`、`ExecStopPost` 等 unit 语义在切换 `ExecStart` 后的行为;也未在 `WorkingDirectory=%h/.agentmemory`(生产实际值)下测试——本次两次对照测试的 cwd 均为仓库根目录,而非 `~/.agentmemory`(因关键路径已用 `AGENTMEMORY_III_CONFIG`/`--data-dir` 显式覆盖,cwd 差异预期影响很小,但未逐条穷举 `cli.mjs` 里所有 `process.cwd()` fallback 分支,例如 `.env.example`/`docker-compose.yml` 的兜底查找路径)。

## 附:构建副作用记录

`npm run build` 会把 `plugin/scripts/antigravity-bridge.mjs` 等源文件加上可执行权限位(tsdown 构建脚本自带的 `chmod`/copy 行为,日志中 "Granting execute permission to..." 对应)。本次已用 `chmod 644` 手工复原该文件的权限位,确认 `git diff --stat HEAD` 对仓库跟踪文件(除 `pipeline/` 本次任务产物外)无残留改动;`dist/` 目录已被 `.gitignore` 排除,不计入版本控制。

## 环境清理确认

已核实收尾状态:`systemctl --user is-active agentmemory` = `active`(未重启/未停止);`curl localhost:3111/agentmemory/livez` 仍返回现网正常响应;本次 spike 启动的所有进程(workspace `dist/cli.mjs`/全局包对照 `dist/cli.mjs`/两者各自 spawn 的 `iii` 子进程)均已 `kill -9` 并经 `ps aux`/`ss -tlnp` 复核无残留;未写入或修改 `~/.agentmemory/`(现网数据目录)、`~/.npm/_npx/`(仅 `ls` 只读查看,未改动)、`~/.config/systemd/user/agentmemory.service`(仅 `cat` 只读查看)。
