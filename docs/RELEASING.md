# 发布指南

[返回 README](../README.md)

## 发布边界

当前 v0.1.x 是开发者模式安装的预览版。GitHub Release 不等同于 Chrome Web Store 上架，也不表示所有视频平台均已验收。保留 README 的验证矩阵，不能将结构模拟测试描述为真实登录态测试。

开发者日常构建不需要凭据。维护者推送使用已有 SSH 配置；创建 Release / 修改仓库资料可使用 GitHub CLI 的登录授权。私有仓库的经典 token 需要 `repo` 权限；细粒度 token 需目标仓库访问权，以及相应 Contents / Metadata / Administration 写权限。不要把凭据写入代码、命令参数、Git 远程 URL 或发布附件。

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
npm run test:e2e
npm run test:drop-frames
npm run test:preferences
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
| `gif-toolkit-chrome-<version>-third-party-sources.zip` | 19 个固定版本的编码器 / 依赖源码归档及构建索引 |
| `SHA256SUMS.txt` | 两个 ZIP 的 SHA-256 |

源码附件从公开固定 URL 获取，缓存到 `artifacts/vendor-sources/`，不读取 `.env`。首次下载需要网络；命中缓存仍会校验摘要。具体上游版本、移动分支的解析时间、构建命令和可重复构建边界见 [SOURCES.md](../third_party/SOURCES.md)。

`release:verify` 检查：包版本一致、生产权限未混入测试权限、无 `.env` / Git / 测试目录或 source map、许可齐全、编码器与锁定 npm 包字节一致、源码附件与锁文件摘要一致。发布前另外检查暂存文件，防止工作区中的私人文件进入 Git。

## 4. 提交和发布

提交源码、文档、锁文件和许可证，不提交 `node_modules/`、`dist/`、`artifacts/`、`test-results/` 或 `.env*`。使用普通推送；发现远程新提交时先同步处理，不强制覆盖。

为已验证提交创建带注释标签，例如 `v0.1.5`。创建 GitHub **draft release**，以 `docs/releases/v0.1.5.md` 作为正文，上传三个附件。验证名称、文件大小、标签指向的提交和资产摘要后再公开该 Release。v0.1.5 标记为 **pre-release**，仓库本身可见性保持不变。

发布完成后再次查询远程标签、Release 状态、附件下载地址和仓库 About，确认都对应同一次提交。GitHub 自动生成的 Source code 是项目源码，不是可直接加载的扩展包；说明下载哪个 ZIP。

## 5. 仓库 About

描述简要说明“网页媒体转 GIF、本机处理、默认大小和主要操作”，不要宣称平台无限制支持。Topics 使用 `chrome-extension`、`gif`、`gif-maker`、`video-to-gif`、`webp`、`ffmpeg-wasm`、`typescript`、`local-first` 等实际技术和功能。

Homepage 指向仓库 README 或实际文档页面，不填写不存在的官网。没有用户明确要求时，不改变仓库公开 / 私有状态。
