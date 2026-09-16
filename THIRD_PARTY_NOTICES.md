# Third-party components

The extension bundles all executable code locally. It does not load executable code from a CDN at runtime.

| Component | Pinned version | License / source |
|---|---|---|
| @ffmpeg/ffmpeg | 0.12.15 | MIT · [notice](third_party/licenses/ffmpeg-wrapper/LICENSE) · https://github.com/ffmpegwasm/ffmpeg.wasm |
| @ffmpeg/core | 0.12.10 | GPL-2.0-or-later (package declaration) · [FFmpeg notices](third_party/licenses/ffmpeg/) · [source/build index](third_party/SOURCES.md) |
| gifuct-js | 2.1.2 | MIT · [notice](third_party/licenses/gifuct-js/LICENSE) · https://github.com/matt-way/gifuct-js |
| js-binary-schema-parser | 2.0.3 | MIT · [notice](third_party/licenses/js-binary-schema-parser/LICENSE) · https://github.com/matt-way/jsBinarySchemaParser |
| React / React DOM | 19.2.0 | MIT · [React](third_party/licenses/react/LICENSE) / [React DOM](third_party/licenses/react-dom/LICENSE) · https://github.com/facebook/react |
| scheduler | 0.27.0 | MIT · [notice](third_party/licenses/scheduler/LICENSE) · https://github.com/facebook/react |

FFmpeg core includes FFmpeg and its compiled libraries. The installation ZIP includes project and third-party license texts under `third_party/licenses/`. The release distributes a companion source ZIP, with immutable revisions and SHA-256 checksums in [sources.lock.json](third_party/sources.lock.json). See [SOURCES.md](third_party/SOURCES.md) for the upstream core release commit, dependency sources and build instructions. The core JS/WASM files are distributed without modifications. Wrapper licensing does not replace the core binary's license.

The upstream core build uses FFmpeg n5.1.4, x264, x265, libvpx, LAME, Ogg, Theora, Opus, Vorbis, zlib, libwebp, FreeType, FriBidi, HarfBuzz, libass and zimg. Emscripten 3.1.40 and its SDL2 port source are also included in the companion archive. Components retain their respective GPL, LGPL, BSD, MIT, zlib and other permissive terms; consult each component's notice and source headers. Including an upstream source archive does not mean every optional file in that archive is compiled into this extension.

The project code is licensed under [GPL-2.0-or-later](LICENSE). This is a preview distribution through GitHub Releases; Chrome Web Store publication has not been performed.

Chrome APIs and image / video decoding are provided by the browser. No original Gif Toolkit desktop code or Cat Catch code is copied into this project.
