# 自生成回归素材

这些媒体只用于测试，不属于任何用户网页内容。

- `motion.mp4`：FFmpeg `testsrc2`，320 × 180，12 fps，3 秒。
- `portrait.mp4`：FFmpeg `testsrc2`，540 × 960，12 fps，3 秒。
- `animation.gif` / `animation.webp`：由横屏素材生成，160 × 90，6 fps，约 1 秒。
- `transparent.webp`：透明画布上的移动矩形，160 × 90，6 fps，约 1 秒，用于透明和帧合成验证。
- `drop-frames.gif`：Pillow 11.3 自生成的 32 × 24 纯色动画，红 / 绿 / 蓝 / 红 / 绿 / 蓝，停留 300 / 100 / 200 / 100 / 400 / 100 毫秒。验证重复帧、小数时间边界、周期删除、结尾延时及新颜色不丢失。`optimize=False, disposal=2, loop=0`。

生成时使用本机已有 FFmpeg；日常运行这些测试及插件不依赖桌面 Gif Toolkit。

0.1.7 分片协议回归素材由同一 `motion.mp4` 生成，测试无需联网或安装 FFmpeg：

```sh
ffmpeg -i motion.mp4 -c:v libx264 -g 12 -an -hls_time 1 -hls_list_size 0 -hls_segment_type mpegts hls-ts/index.m3u8
ffmpeg -i motion.mp4 -c:v libx264 -g 12 -an -hls_time 1 -hls_list_size 0 -hls_segment_type fmp4 hls-fmp4/index.m3u8
ffmpeg -i motion.mp4 -c:v libx264 -g 12 -an -f dash -seg_duration 1 dash/index.mpd
ffmpeg -i motion.mp4 -c:v libx264 -bf 0 -an -g 12 -movflags frag_keyframe+empty_moov+default_base_moof fragmented.mp4
```

`fragmented.mp4` 用于构造 MSE 播放器，不设置 B 帧，保证夹具的播放器时间轴从 0 开始；HLS/DASH 独立验证分片解复用和合并。`.ts` 是 MPEG-TS 视频字节，因此 TypeScript 排除整个媒体夹具目录。

0.1.9 发布检查将媒体夹具中的 `.ts` 和 `.m4s` 明确标为 Git binary。普通 `*.ts text` 规则会把 MPEG-TS 中碰巧出现的 CRLF 字节改写，导致提交后的测试素材损坏；仓库检出必须保留生成文件的原始字节。

0.1.8 的 `full-source` 场景将实际 MSE `duration` 设为 3.08 秒，声明的完整 HLS 文件仍为 3 秒。网页与文件元数据都来自真实媒体实现，不替换 `HTMLMediaElement.duration`。旧版本完成下载后误报 `invalidSegment`；完整选区修复后在 2× 输出 1.5 秒，其他显式截取仍保持 0.5–2.5 秒。
