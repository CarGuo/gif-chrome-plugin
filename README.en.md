# Gif Toolkit · Chrome

**Turn a moment on a webpage into a GIF that fits.**

A Chrome side panel extension for webpage videos, GIFs and WebP images. Select clips, adjust speed and export locally. Defaults: **4 MB · 800 px longest side · 10 fps**. No desktop application or conversion server required.

[简体中文](README.md) · [Download v0.1.10](https://github.com/CarGuo/gif-chrome-plugin/releases/tag/v0.1.10) · [Changelog](CHANGELOG.md) · [Report an issue](https://github.com/CarGuo/gif-chrome-plugin/issues)

> **Published version: v0.1.10, Chrome 148+ required.** Install in developer mode. The extension is not listed in the Chrome Web Store. See the verification table below for the remaining X and YouTube acceptance gaps.

## Features

- Right-click media to open the side panel, or scan a page from the toolbar.
- Select multiple sources and clips; each clip becomes a separate GIF. The full duration is selected by default.
- Speed from 0.1× to 10×, common presets and an estimated output duration.
- A file-size budget and dimensions up to 800 px on both axes, preserving aspect ratio without enlarging small images.
- Download the largest available representation within the size ceiling. Full-source selections end at the downloaded file's actual end, independently of the page player's estimated duration. See the [0.1.8 regression record](docs/DOWNLOAD-0.1.8.md) (Chinese).
- Optional frame removal, **off by default**: merge consecutive identical frames or remove every 2nd, 3rd or 4th frame. The duration at the chosen speed is preserved.
- Background queue, cancellation, GIF preview and edit again. Results scroll in their own bounded list; save one GIF, selected GIFs or all available GIFs.
- A dedicated History view with search, status filters, dates and source links. See GIF storage usage, clear cached files while keeping records, or delete history. Files already saved to your computer are unaffected.
- Editable titles with automatic numbering for duplicate media titles on a page; Base64url filenames with a generation timestamp and unique task ID.
- English and Simplified Chinese UI, selected by Chrome's UI language.

## Install and update

1. Download **`gif-toolkit-chrome-0.1.10.zip`** from the [release page](https://github.com/CarGuo/gif-chrome-plugin/releases/tag/v0.1.10) and extract it to a permanent folder.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the extracted folder containing `manifest.json`.
4. Pin Gif Toolkit to the toolbar.

GitHub's automatic “Source code” download is for development and must be built first.

To update, extract the new package into the existing installation folder, reload the extension, refresh the source page and reopen the panel. Check the displayed version. Removing the extension clears its local data.

## Use

1. Open a media page and let its video display a frame.
2. Right-click the media and choose **Make a GIF…**.
3. Select clips and set **Speed** at the top of **Selected clips**.
4. Adjust the budget, dimensions, frame rate or optional **Drop frames** under **Make it fit**.
5. Generate, preview and save.

If X or YouTube intercepts right-click, open Gif Toolkit from the toolbar first. Choose **Enable video discovery and right-click on this site**, allow access and reload the page. **Alt + right-click** keeps the site's menu. Animated images may require access to their image CDN and can be inspected before editing their ranges.

## Compression and limits

Downloadable videos are fetched first and decoded with WebCodecs in a Worker. Speed is applied to the sampling clock before a representative probe estimates dimensions. The extension resizes first, encodes a GIF, and optimizes it with Gifsicle. Measured bytes guide bounded size corrections; automatic frame reduction starts only after resizing and optimization cannot meet the budget. Explicit frame-removal settings are applied as a finishing operation. It never shortens the clip to meet a budget. An unreachable target produces an error.

Turning optional frame removal off does **not** disable automatic size optimization. 4 MB means **4,000,000 bytes**, not 4 MiB.

- Up to **600 sampled frames per clip** after speed adjustment: about 60 seconds of output at 10 fps.
- Maximum downloaded media: 128 MiB. Maximum sampled PNG storage: 160 MiB. Queue: 24 tasks. History: 30 finished tasks.
- All video paths acquire local media bytes before conversion: files, file blobs, HLS, DASH and provider adapters. Page frame capture has been removed. Keep the source page open while establishing its download session. Ambiguous streams require an explicit choice.
- DRM, live streams and sources whose complete media cannot be acquired are unsupported. Clip concatenation, cropping, exporting the original video, source-clip preview and a real thumbnail filmstrip are not included.

## Verification status

| Scenario | Status |
| --- | --- |
| Ordinary landscape/portrait videos; multiple sources and clips | Passed local real-browser end-to-end tests |
| GIF, animated WebP and transparent WebP | Passed conversion and independent output decoding |
| Defaults, speed, optional frame removal, size limits and history | Passed UI and output checks |
| Standard YouTube video | SABR integration is present; **complete download acceptance has not passed**. Old page-capture tests do not validate downloading |
| X video / animated posts | Public media resolver and complete MP4 downloading implemented, matched to the selected poster; **full logged-in acceptance remains pending** |
| HLS (TS / fMP4), DASH and file blobs | Complete downloads and conversion passed, with no page seeking |
| Vimeo embedded in the supplied OpenAI page | The corresponding 49.07-second source passed live iframe-source downloading and conversion |
| YouTube Shorts and complex feeds | Dedicated acceptance pending |

## Privacy

No application accounts, analytics or conversion server. Frames and generated GIFs stay on your device. Downloading video/GIF/WebP input contacts its source website and may use existing credentials for that origin. Public X posts also contact the public embed endpoint and video CDN, after requesting their host permissions. Local history stores titles, source URLs, settings and results. See [Privacy and permissions](docs/PRIVACY.md).

## Development and licensing

```sh
npm ci
npm run check
npx playwright install chromium
npm run test:e2e
npm run test:drop-frames
```

Load `dist/` in Chrome after building. Node.js 20.18+ is required. No `.env` or GitHub token is needed to build or use the extension.

[CI and Release](https://github.com/CarGuo/gif-chrome-plugin/actions/workflows/ci.yml) runs type checks, unit/browser tests and package verification for PRs and `main`. Pushing a `vX.Y.Z` tag that matches the project version automatically publishes the extension ZIP, third-party source ZIP and SHA-256 checksums. Tags publish regular releases, including versions below 1.0; see the [release guide](docs/RELEASING.md).

Further documentation: [User guide](docs/USER_GUIDE.md) · [Development](docs/DEVELOPMENT.md) · [Releasing](docs/RELEASING.md) · [0.1.7 media verification and remaining gaps](docs/MEDIA-0.1.7.md) (Chinese).

Licensed under [GPL-2.0-or-later](LICENSE). See [third-party notices and source distribution](THIRD_PARTY_NOTICES.md). Inspired by the [Gif Toolkit desktop project](https://github.com/CarGuo/gif-toolkit); powered by [FFmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) and [gifuct-js](https://github.com/matt-way/gifuct-js).
