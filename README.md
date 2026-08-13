# dsh-plugin-marketplace

DSH 的中心化插件市场与自主维护 Registry。市场界面不再直接展示
GitHub `dsh-plugin` topic 的所有结果，只展示经过本仓库扫描器验证并写入
`registry/plugins.json` 的插件。

## 工作方式

1. GitHub Action 每天搜索一次 `topic:dsh-plugin archived:false`。
2. 扫描器读取候选仓库默认分支当前 commit，并将其解析为不可变的 40 位 SHA。
3. 扫描器在该 SHA 下静态读取并验证 `package.json`、`dsh.bundle.patch`
   指向的 YAML 文件及 loader entry；不会安装依赖，也不会执行第三方代码或
   YAML 中的 `!!js` 内容。
4. 验证成功的仓库进入 `registry/plugins.json`；失败原因写入
   `registry/rejected.json`，不会出现在市场中。
5. 未变化且已经验证/拒绝的仓库复用上次结果；有新提交、首次发现或上次网络
   失败的仓库会重新验证。被移除 topic、归档或删除的仓库会退出公开列表。
6. 客户端安装前再次读取 Registry，并只允许安装 Registry 记录的精确 commit。

`registry/state.json` 是增量扫描状态；`policy/denylist.json` 可人工封禁仓库。
公开 Registry 的格式由 `registry/schema.json` 描述。

## 安装市场插件

```sh
dsh plugin --profile web add github:YELEBAI/dsh-plugin-marketplace#v0.1.0
```

本地开发安装：

```sh
dsh plugin --profile web add D:/path/to/dsh_Market
```

重启 DSH 后打开“设置 → 插件 → 插件市场”。npm 包内自带构建后的 `lib/`
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

## 自动扫描

`.github/workflows/daily-registry-scan.yml` 默认每天 UTC 02:17 执行，也支持
在 Actions 页面手动运行。工作流使用仓库自动提供的 `GITHUB_TOKEN`，验证后只
提交三个 Registry JSON 文件。按 GitHub 当前计费规则，公开仓库使用标准
GitHub-hosted runner 免费；私有仓库会消耗账户套餐包含的分钟数，超额后计费。
参见 [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。

首次在本机生成 Registry：

```powershell
corepack enable
pnpm install
$env:GITHUB_TOKEN = gh auth token
pnpm registry:test
pnpm registry:scan
```

不要把 token 写入仓库。扫描器处理 GitHub Search 的 1,000 条结果上限，会按
仓库创建日期自动分区；文件大小上限为 `package.json` 256 KiB、补丁 64 KiB。

封禁一个已通过验证的仓库时，在 `policy/denylist.json` 中加入：

```json
{
  "repositories": [
    { "repo": "owner/repository", "reason": "policy violation" }
  ]
}
```

下一次扫描后该仓库会从公开列表移除。解除封禁后，下次扫描会重新验证。

## 验证规则

候选仓库必须满足：

- `package.json` 是有效 JSON，包含合法的小写 npm 包名与语义化版本；
- `dsh.bundle.patch` 存在、是仓库内安全相对路径；
- 声明 `dsh.client` 时，平台必须是 `web` 且导出 `./client`；
- bundle patch 是有效 YAML 操作数组；
- patch 至少插入一个 `name` 等于该 npm 包名的 loader entry；
- 所有被发布字段和精确 commit 均通过 Registry schema 校验。

这能挡住错误 topic、普通仓库和结构不完整的伪插件，但不能证明插件代码本身
无恶意。安装仍意味着插件在下一次启动后拥有本机进程权限，因此 UI 保留风险确认。

## 开发与发布

构建会复用 DSH checkout 内的 esbuild，默认位置是
`D:/DSH/deepseek-harness`，可用 `DSH_CHECKOUT` 覆盖：

```powershell
pnpm registry:test
pnpm build
pnpm verify
pnpm exec tsc --noEmit
```

发布前更新版本、生成 Registry、重新构建 `lib/`，然后提交这些产物并打 tag。
市场 Remote 方法使用 `marketplace/installPlugin`；避免使用
`marketplace/install`，因为 `install` 是 DSH Remote namespace service 的内部
生命周期方法名，会和客户端 API 方法发生冲突。
