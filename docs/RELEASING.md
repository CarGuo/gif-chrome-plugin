# 发布指南

[返回 README](../README.md)

## 发布边界

版本 tag 发布正式 GitHub Release，包括 v0.x；扩展通过开发者模式安装。GitHub Release 不等同于 Chrome Web Store 上架，也不表示所有视频平台均已验收。保留 README 的验证矩阵，不能将结构模拟测试描述为真实登录态测试。

开发者日常构建不需要凭据。维护者推送使用已有 SSH 配置；自动发布使用 GitHub Actions 自带的 `GITHUB_TOKEN`，无需添加个人 token、Secrets 或上传 `.env`。工作流仅在发布作业声明 `contents: write`，其余检查作业只有读取权限。仓库或组织策略需要允许 Actions、工作流引用的官方 Actions 及该写权限。不要把凭据写入代码、命令参数、Git 远程 URL 或发布附件。

## 1. 准备版本

1. 检查现有远程提交和标签，不覆盖已发布标签。
2. 更新 `package.json` / `package-lock.json` 的版本及 `CHANGELOG.md` 的变更原因、验证与剩余工作。
3. 同步中英文 README、使用指南、Release 下载链接和 `third_party/SOURCES.md` 中的版本。
4. 新增依赖或更换编码器时，核对许可证、源码版本、构建来源和 SHA-256；只更新包名或“最新版”链接不够。

## 2. 验证构建

```sh
npm ci
npm run check
npx playwright install chromium
npm run test:transports
npm run test:e2e
npm run test:drop-frames
npm run test:preferences
npm run test:history
npm run test:results
npm run test:reliability
npm run test:context-menu
npm run test:download
```

平台行为有变动时额外运行 `npm run test:platform`，并对真实登录态进行手动验收。它需要网络，站点状态可能影响结果。没有完成的场景写入 Release 限制，不用宽松断言掩盖失败。

## 3. 生成附件

```sh
npm run package
npm run package:sources
npm run release:verify
```

`artifacts/` 生成三个附件：

| 文件 | 用途 |
| --- | --- |
| `gif-toolkit-chrome-<version>.zip` | 用户安装；根目录包含 `manifest.json`、编码器和许可证 |
| `gif-toolkit-chrome-<version>-third-party-sources.zip` | 22 个固定版本的源码归档、Mediabunny 对应源码及构建索引 |
| `SHA256SUMS.txt` | 两个 ZIP 的 SHA-256 |

源码附件从公开固定 URL 获取，缓存到 `artifacts/vendor-sources/`，不读取 `.env`。首次下载需要网络；命中缓存仍会校验摘要。具体上游版本、移动分支的解析时间、构建命令和可重复构建边界见 [SOURCES.md](../third_party/SOURCES.md)。

`release:verify` 检查：包版本一致、生产权限未混入测试权限、无 `.env` / Git / 测试目录或 source map、许可齐全、编码器与锁定 npm 包字节一致、源码附件与锁文件摘要一致。发布前另外检查暂存文件，防止工作区中的私人文件进入 Git。

## 4. 提交和发布

提交源码、文档、锁文件和许可证，不提交 `node_modules/`、`dist/`、`artifacts/`、`test-results/` 或 `.env*`。使用普通推送；发现远程新提交时先同步处理，不强制覆盖。

### 推送 tag 自动发布

[CI and Release](../.github/workflows/ci.yml) 会在推送 `v*` tag 时自动执行完整测试、打包与发布。版本必须是 `major.minor.patch` 三段数字，tag 必须严格等于 `v` + `package.json.version`，并与 `package-lock.json` 两处版本一致；不一致立即失败。所有符合该规则的 tag 均发布正式 Release，不根据主版本号推断预发布状态。v0.1.11 修正了旧工作流将所有 0.x 自动标为 prerelease 的规则。

以下以 **0.1.9** 为例；实际发布使用尚未存在的版本 tag。发布前须先完成该版本的实际变更、文档和验收，不要仅为触发 CI 空升版本：

```sh
npm version 0.1.9 --no-git-tag-version
# 更新 CHANGELOG、版本文档及 docs/releases/v0.1.9.md，检查后提交。
# 同时暂存本次修改的源码、测试和许可证。
git add package.json package-lock.json CHANGELOG.md README.md README.en.md docs third_party/SOURCES.md
git commit -m "Release Gif Toolkit Chrome v0.1.9"
git push origin main
# main CI 通过后，在同一提交打 tag。
git tag -a v0.1.9 -m "Gif Toolkit Chrome v0.1.9"
git push origin v0.1.9
```

tag 必须指向包含该工作流的提交。之前已经推送的 `v0.1.5` 不会因新增 CI 被追溯发布；不移动旧 tag、不覆盖旧发行包。本次 CI 配置本身不改变扩展版本。

打开仓库 [Actions](https://github.com/CarGuo/gif-chrome-plugin/actions/workflows/ci.yml) 查看进度。顺序为：

1. 校验版本，安装锁定依赖，运行类型检查、单元测试、生产构建及九组浏览器测试（媒体获取、端到端、下载、丢帧、偏好、历史清理、结果选择保存、故障恢复、右键）。
2. 生成扩展 ZIP、固定来源的第三方源码 ZIP、`SHA256SUMS.txt`，运行 `release:verify`。
3. 只把三个校验过的附件交给独立发布作业，再核对一次 SHA-256。
4. 创建该 tag 的草稿 Release，优先使用 `docs/releases/<tag>.md`；没有该文件时使用 GitHub 自动生成的发布说明。
5. 上传三个附件，再从 GitHub 下载回读，对比校验文件并核对两份 ZIP 的 SHA-256。全部通过后才自动发布草稿。

PR / `main` 提交会执行相同的验证和打包，但不会发布。Actions 的 **Run workflow** 仅用于手动检查，即使选中 tag 也不会发布；自动发布只由 tag 的 push 事件触发。浏览器测试使用隔离的本地素材，不能替代真实平台登录态验收。

### 失败与重跑

- 检查、测试、源码下载或摘要校验失败：不发布 Release。在 Actions 查看失败步骤；失败时已有的测试 JSON / PNG 作为诊断附件保留 7 天。
- 网络等临时错误解决后，对原 tag 的工作流点击 **Re-run all jobs**；若仅发布步骤失败且发行附件未过期，可使用 **Re-run failed jobs**。
- 上传中断会留下草稿，重跑继续上传并校验。已经公开的同 tag Release 会直接跳过，保持既有附件不变。
- tag 版本错误或代码错误：在新提交修正并使用新版本 tag，不强制移动已发布标签。发行作业的中间附件保留 7 天，过期后需重新运行全部作业。
- 若 GitHub 策略阻止 Actions 或写权限，先在仓库 / 组织设置解决限制；个人 `.env` 无法替代工作流权限。

需要手动发布已有旧 tag 时，仍可在 GitHub 创建草稿，粘贴对应的版本说明、上传本地生成并校验的三个附件，然后发布为正式 Release。仓库本身可见性保持不变。

发布完成后再次查询远程标签、Release 状态、附件下载地址和仓库 About，确认都对应同一次提交。GitHub 自动生成的 Source code 是项目源码，不是可直接加载的扩展包；说明下载哪个 ZIP。

## 5. 仓库 About

描述简要说明“网页媒体转 GIF、本机处理、默认大小和主要操作”，不要宣称平台无限制支持。Topics 使用 `chrome-extension`、`gif`、`gif-maker`、`video-to-gif`、`webp`、`ffmpeg-wasm`、`typescript`、`local-first` 等实际技术和功能。

Homepage 指向仓库 README 或实际文档页面，不填写不存在的官网。没有用户明确要求时，不改变仓库公开 / 私有状态。
