# 0.1.6 性能修复与验证

日期：2026-09-16。设备：Apple M1 Pro、16 GB 内存。浏览器：Chrome 152.0.7977.84 和 Playwright Chromium 148.0.7778.96。所有时间均为本机单次测量，网络、设备和视频内容会影响结果。

## 问题与原因

[用户提供的视频](https://x.com/algebrandon/status/2099851773905363243) 为 127.85 秒、1152×720。设置是 5×、4,000,000 字节、800 px 上限、10 fps，额外丢帧关闭。倍速后的时长是 **25.57 秒**，需 **256 帧**，不是原片的 1279 帧。

0.1.5 已按倍速采样；慢在后续的固定候选枚举。第一轮按 800×500 生成 256 帧，调色板耗时 13.48 秒，GIF 编码耗时 17.06 秒，得到 42.95 MB。接着反复生成调色板、编码全片，依次减少颜色、尺寸和帧率，17 次才低于 4 MB。截图的 Pass 6 / 65% 是候选序号换算的进度，不能代表剩余工作量。

调色板用于把视频颜色映射到 GIF 可表示的有限颜色；GIF 编码把这些画面、帧间变化和延时写成动画。两步有必要，但不应在明显超出预算的大尺寸上盲目重做。

## 最终流程

1. 下载完整视频。直接视频按来源下载；公开 X 视频使用公开嵌入接口，严格匹配帖子与所选封面，选择匹配视频的最高码率 MP4。
2. 在 Worker 以 `源时间 = 选区起点 + 输出帧序号 × speed / fps` 读取画面，直接建立倍速后的时间轴。无需为了调速额外编码一份中间 MP4。
3. 在倍速时间轴上抽取最多 24 帧，分布在 6 个连续短窗口，包含首尾。用低尺寸样本实际编码和优化，按面积及输出帧数估算体积。
4. 先定尺寸，再采样完整选区。采用桌面 gif-toolkit 视频路径使用的 Bayer 抖色策略；调色板仍统计全部保留画面，避免丢失末尾新颜色。
5. 编码后交给 Gifsicle 优化。各次有损优化都从同一个原始 GIF 开始；若仍超限，以实测字节修正尺寸，复用已采样的原始 PNG。
6. 只有尺寸和优化仍无法达到预算，才自动减少帧数。用户显式选择的丢帧模式仍作为最后步骤执行。成品必须通过完整时长、帧数、尺寸和字节限额检查。

Mediabunny / WebCodecs 解码、图像解码、FFmpeg 与 Gifsicle 均在 Worker 执行。Offscreen 负责排队与存储，侧栏只处理交互和状态。尚不能下载的 MSE/HLS 保留既有页面采样路径；下载错误不自动切换路径。

实现依据：本地 `gif-toolkit/src/main/processor.ts`、`processor-utils.ts` 的实测体积反馈，`ffmpeg.ts` 的倍速 / 缩放及 Bayer 配置；[FFmpeg 调色板过滤器](https://ffmpeg.org/ffmpeg-filters.html#palettegen)、[Gifsicle 优化参数](https://www.lcdf.org/gifsicle/man.html)、[Mediabunny](https://mediabunny.dev/)。Ezgif 使用服务器端的原生处理工具，见其[项目说明](https://ezgif.com/about)；本次未上传同一视频到 Ezgif 计时，不宣称与其等速。

## 实测

| 路径 | 处理时间 | 完整 GIF 编码次数 | 成品 |
| --- | ---: | ---: | --- |
| 旧核心诊断，Chrome 152 | 311.52 s | 17 | 3,861,811 B，296×185，154 帧，25.67 s |
| 旧完整扩展，Chromium 148 | 300 s 超时，仍在第 17 次编码 | 未完成 | 不作为完成结果 |
| 新完整扩展，Chromium 148，本地输入 | 11.46 s | 1 | 3,445,103 B，313×195，256 帧，25.57 s |
| 新完整扩展，Chrome 152，本地输入 | 12.16 s | 1 | 同上 |
| 新完整扩展，Chrome 152，真实 X 解析与 CDN | 下载 71.89 s + 后续 13.81 s = 85.70 s | 1 | 与本地输入成品逐字节一致 |

新 Chrome 本地输入的分阶段时间：下载本地文件 0.11 s、估算 1.77 s、完整采样 2.60 s、完整编码 5.00 s、三次 Gifsicle 优化合计 2.44 s。完整编码中的调色板为 3.34 s，GIF 编码为 1.66 s；其余时间是加载、校验和存储。估算阶段另有一次 24 帧小样本编码，不计作“完整 GIF 编码”。

旧核心诊断直接使用生产内容脚本和编码函数，但没有完整扩展消息与存储链路；新的完整扩展测试包含它们。因此 311.52 / 12.16 不能作为严格同环境的精确加速倍率。另用相同 Chromium 和完整扩展测试脚本复测旧版本，300 秒仍未完成，佐证反复编码的主要瓶颈。

本地输入是同一视频下载后的 25,000,047 字节 MP4。本地与实际 X 下载成品的 SHA-256 均为 `3a7f6fab2a1978c3888da3d4854fa4c283b05b7dd6f1ac518a1a5a498c41fdaa`。上述视频保持用户 10 fps 设置，末帧延时用于精确到 25.57 秒，没有自动丢帧或截短选区。下载测试验证页面播放器零 seek。

## 复测与证据

```sh
node scripts/benchmark.mjs /absolute/path/video.mp4 --speed 5 --channel chrome
node scripts/benchmark.mjs /absolute/path/video.mp4 --speed 5 --channel chrome --x-post POST_URL --poster POSTER_URL
```

测试使用独立临时浏览器配置和真实扩展，不连接用户浏览器配置。X 模式仍使用受控播放器，只将公开接口与 CDN 下载接入生产链路，不能替代原生 X DOM、权限弹窗、侧栏到保存的完整验收。

本地可复核记录（不入 Git）：

- `.research/performance/baseline.json`、`baseline-output.gif`：旧核心诊断。
- `.research/baseline-source/test-results/benchmark/report.json`：旧完整扩展 300 秒结果。
- `test-results/benchmark/report.json`：新 Chromium 完整扩展。
- `test-results/benchmark-chrome/report.json`、`output.gif`：新 Chrome 完整扩展。
- `test-results/benchmark-x-chrome/report.json`、`output.gif`：公开 X 下载完整链路。

58 项单元 / 契约测试、类型检查、生产构建与五组浏览器回归（端到端、丢帧、偏好、右键、下载）通过。剩余工作：重载实际安装的 0.1.6，在用户登录态 X 页面完成侧栏操作验收；没有发布 GitHub Release。
