# dsh-plugin-marketplace

DSH 的中心化插件市场与自主维护 Registry。市场界面不再直接展示
GitHub `dsh-plugin` topic 的所有结果，只展示经过本仓库扫描器验证并写入
`registry/plugins.json` 的插件。

## 工作方式

1. GitHub Action 每两小时搜索一次 `topic:dsh-plugin archived:false`。
2. 扫描器读取候选仓库默认分支当前 commit，并将其解析为不可变的 40 位 SHA。
3. 扫描器在该 SHA 下静态读取并验证 `package.json`、`dsh.bundle.patch`
   指向的 YAML 文件及 loader entry；若同一精确版本已发布到 npm，还会下载
   SHA-512 完整性固定的 tarball，只读检查其中的 manifest、patch 和运行入口。
   整个过程不会安装依赖，也不会执行第三方代码或 YAML 中的 `!!js` 内容。
4. 验证成功的仓库进入 `registry/plugins.json`；失败原因写入
   `registry/rejected.json`，不会出现在市场中。安装证据有冲突或不足时，插件仍
   可展示，但只提供引导安装，并写入 `registry/install-review.json` 等待复核。
5. 未变化且已确认可从精确 GitHub commit 自动安装的仓库复用上次结果；引导安装
   和 npm 来源每两小时重新核验，以便新发布的 npm 版本自动解除错误的引导分类。
   临时网络失败保留上一次有效结果，不会造成市场条目批量下架。
6. Registry 同时记录安装来源、兼容 Profile、构建授权、重启和人工步骤；客户端
   只对当前 Profile 中满足自动安装条件的插件开放一键安装。
7. 自动安装仍会在执行前读取 Registry 和仓库内容，并只允许执行 Registry 验证的
   精确 GitHub commit 或精确 npm 版本。目标 Profile 不明、需要构建授权或额外
   步骤的插件只显示安装说明。

`registry/state.json` 是增量扫描状态；其中保留最近 7 天的每日 Star 基线。
`registry/discovery.json` 发布分类和 Star 增长元数据，又不改变旧客户端严格读取的
`plugins.json` v2 格式。`registry/install-review.json` 记录安装
分类所依据的 README 命令、Profile、生命周期脚本和运行产物；
`registry/guided-audit.json` 每轮逐项记录所有引导安装条目的 README 命令、npm
tarball 验证结果及保留引导安装的原因。公开 Registry 的格式由
`registry/schema.json` 描述。

## 安装市场插件

```sh
dsh plugin --profile web add github:YELEBAI/dsh-plugin-marketplace#v0.5.0
```

本地开发安装：

```sh
dsh plugin --profile web add D:/path/to/dsh_Market
```

重启 DSH 后打开“设置 → 插件 → 插件市场”。市场内包含“插件市场”和“已安装插件”
两个子页面；后者读取当前运行 Profile，可检查 Registry 更新、执行更新、卸载，
也可把 bundle 从 `dsh.profile.bundles` 中停用或重新启用。启停不删除依赖，重启
DSH 后生效；更新其他插件也不会意外重新启用已停用 bundle。“已安装插件”页和
“重启后生效”提示条均提供“重启 DSH”按钮：确认后会等待当前插件任务结束，使用
相同启动参数和 Profile 自动重启，页面在服务恢复后自动刷新。
插件市场自身不等待定时 Registry 刷新：“已安装插件”页会直接读取本仓库主分支
`package.json` 的版本。发现新版本后显示“自更新”，执行时仍把安装来源固定为刚刚
解析出的精确 commit，不会把可变的 `main` 直接交给 pnpm。
市场还提供扫描时生成的分类筛选，以及“近期热门”排序。热门程度按当前 Star 数与
最近 7 天最早日快照之间的正增长计算；每天只保存一个基线，不会增加 GitHub API
请求。刚加入 Registry、还没有历史基线的插件增长值为 0。
npm 包内自带构建后的 `lib/`
和当次发布的 Registry 快照，因此远程 Registry 暂时不可用时仍可读取快照。

## 指定中心 Registry

插件默认读取本仓库主分支的中心 Registry：

```text
https://raw.githubusercontent.com/YELEBAI/dsh-plugin-marketplace/main/registry/plugins.json
```

自建 Registry 时可以覆盖默认地址：

```powershell
$env:DSH_PLUGIN_REGISTRY_URL = 'https://raw.githubusercontent.com/OWNER/REPOSITORY/main/registry/plugins.json'
dsh web --profile web
```

也可以通过插件配置的 `registryUrl` 指定同一个 HTTPS 地址。远程内容在内存中
缓存 15 分钟，支持 ETag；刷新失败时使用最近一次有效内容，再失败才回退到包内
快照。`registryCacheMinutes` 和 `registryRequestTimeoutMs` 可调整缓存与超时。
新版市场会在 Registry 同目录读取可选的 `discovery.json`；自建 Registry 未提供
该文件时仍可正常搜索和安装，只会把分类暂时显示为“其他”并把 Star 增长记为 0。

## 自动扫描

.github/workflows/daily-registry-scan.yml` 默认每两小时在第 17 分钟执行，也支持
在 Actions 页面手动运行。扫描和引导审计优先使用 Actions Secret
`REGISTRY_GITHUB_TOKEN` 中的只读 PAT；未配置时回退到仓库自动提供的
`GITHUB_TOKEN`。PAT 不参与 Registry 提交，写入仍由 Actions checkout 的内置
凭据完成。按 GitHub 当前计费规则，公开仓库使用标准 GitHub-hosted runner 免费；
私有仓库会消耗账户套餐包含的分钟数，超额后计费。
参见 [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。

在仓库“Settings → Secrets and variables → Actions”中添加
`REGISTRY_GITHUB_TOKEN` 后即可启用 PAT 额度。令牌只保存在 GitHub Secrets，
不要写入工作流、README 或任何提交。

首次在本机生成 Registry：

```powershell
corepack enable
pnpm install
$env:GITHUB_TOKEN = gh auth token
pnpm registry:test
pnpm registry:scan
pnpm registry:audit
```

不要把 token 写入仓库。扫描器处理 GitHub Search 的 1,000 条结果上限，会按
仓库创建时间自动细分到秒，并在 Search 配额重置后继续；文件大小上限为
`package.json` 256 KiB、补丁 64 KiB、
npm 压缩包 50 MiB、解包内容 150 MiB。

## 验证规则

候选仓库必须满足：

- `package.json` 是有效 JSON，包含合法的小写 npm 包名与语义化版本；
- `dsh.bundle.patch` 存在、是仓库内安全相对路径；
- 声明 `dsh.client` 时，平台必须是 `web` 且导出 `./client`；
- bundle patch 是有效 YAML 操作数组；
- patch 至少插入一个 `name` 等于该 npm 包名的 loader entry；
- 所有被发布字段和精确 commit 均通过 Registry schema 校验。

Registry v2 的每个插件还包含 `install` 字段。安装分类不是只看某一个文件或
关键词，而是交叉检查：

- `package.json` 中的 host/client 入口及可选 `dsh.marketplace` 声明；
- Git tree 中是否真的提交了入口对应的运行产物；
- README 是否明确给出 `dsh plugin --profile ... add github:...`；
- README 使用旧 owner/别名时，其 GitHub repository ID 是否与候选仓库一致；
- README 中的 `<profile>` / `<name>` 表示调用者选择 Profile；Registry v2 会保守映射
  到 DSH 自带的 `web`、`headless` 模板，带 Web client 的插件只映射到 `web`；
- `add` 与安装源之间允许 pnpm 的 `-w` / `--workspace-root` 等选项，但仍要求 DSH
  官方 CLI 必需的 `--profile`，省略 Profile 的示例不会成为自动安装证据；
- `preinstall` / `install` / `postinstall` / `prepare` 生命周期脚本；
- README Profile 与 manifest 声明是否冲突。
- 与 GitHub manifest 同名同版本的 npm 发行版是否存在；扫描器会验证官方 Registry
  URL、SHA-512 完整性、tarball 内 package identity、bundle patch、全部运行入口，
  并拒绝包含 `preinstall` / `install` / `postinstall` 或根级 `binding.gyp` 的发行包。

`preinstall`、`install`、`postinstall` 或缺少运行产物时始终要求构建授权。
`prepare` 本身不再直接判为引导安装：GitHub 源只有在运行产物已提交、作者 README
明确记录 GitHub 安装命令且未声明 `allowBuilds` / build approval 时才可自动安装；
正常 npm 发行包不会在安装依赖时执行 `prepare`，因此只要 tarball 已包含全部运行
产物并通过上述静态验证，就可以使用精确 npm 版本自动安装。
证据缺失或互相矛盾的仓库保持引导安装，
并进入 `registry/install-review.json`，不会靠猜测放开一键安装。插件作者也可以在
`package.json` 中声明更明确的信息：

```json
{
  "dsh": {
    "marketplace": {
      "profiles": ["web"],
      "requiresBuildApproval": false,
      "requiresRestart": true,
      "manualSteps": false
    }
  }
}
```

中心 Registry 可通过 `policy/install-overrides.json` 为已核对官方 README 的仓库
补充专用 Profile 或人工安装信息。当前自动执行只接受与验证 commit 完全一致的
GitHub spec，或内容已通过 tarball 级复验的精确 npm `包名@版本`；可变 tarball URL
和 manual 来源仍只提供引导说明。

这能挡住错误 topic、普通仓库和结构不完整的伪插件，但不能证明插件代码本身
无恶意。安装仍意味着插件在下一次启动后拥有本机进程权限，因此 UI 保留风险确认。

## 开发与发布

构建会复用 DSH checkout 内的 esbuild，默认位置是
`D:/DSH/deepseek-harness`，可用 `DSH_CHECKOUT` 覆盖：

```powershell
pnpm registry:test
pnpm registry:discovery
pnpm discovery:test
pnpm profile:test
pnpm restart:test
pnpm self-update:test
pnpm build
pnpm verify
pnpm exec tsc --noEmit
```

发布前更新版本、生成 Registry、重新构建 `lib/`，然后提交这些产物并打 tag。
市场 Remote 方法使用 `marketplace/installPlugin`；避免使用
`marketplace/install`，因为 `install` 是 DSH Remote namespace service 的内部
生命周期方法名，会和客户端 API 方法发生冲突。
