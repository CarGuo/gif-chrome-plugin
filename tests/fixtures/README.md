# 自生成回归素材

这些媒体只用于测试，不属于任何用户网页内容。

- `motion.mp4`：FFmpeg `testsrc2`，320 × 180，12 fps，3 秒。
- `portrait.mp4`：FFmpeg `testsrc2`，540 × 960，12 fps，3 秒。
- `animation.gif` / `animation.webp`：由横屏素材生成，160 × 90，6 fps，约 1 秒。
- `transparent.webp`：透明画布上的移动矩形，160 × 90，6 fps，约 1 秒，用于透明和帧合成验证。
- `drop-frames.gif`：Pillow 11.3 自生成的 32 × 24 纯色动画，红 / 绿 / 蓝 / 红 / 绿 / 蓝，停留 300 / 100 / 200 / 100 / 400 / 100 毫秒。验证重复帧、小数时间边界、周期删除、结尾延时及新颜色不丢失。`optimize=False, disposal=2, loop=0`。

生成时使用本机已有 FFmpeg；日常运行这些测试及插件不依赖桌面 Gif Toolkit。
