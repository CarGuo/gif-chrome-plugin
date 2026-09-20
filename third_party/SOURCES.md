# Encoder source distribution

Gif Toolkit Chrome v0.1.10 distributes the **unmodified** ESM JavaScript and single-threaded WASM files from npm `@ffmpeg/core@0.12.10`. The JavaScript wrapper is `@ffmpeg/ffmpeg@0.12.15`. The wrapper's MIT license does not replace the GPL license of the compiled core.

## Download

The packaging commands produce the following files in `artifacts/`. The tag workflow verifies and publishes both archives together when a version is released; the currently published package is on the [v0.1.10 release page](https://github.com/CarGuo/gif-chrome-plugin/releases/tag/v0.1.10).

- `gif-toolkit-chrome-0.1.10.zip`: loadable extension with license texts and this source index.
- `gif-toolkit-chrome-0.1.10-third-party-sources.zip`: encoder build source, FFmpeg and all 22 source archives listed in `sources.lock.json`, including Emscripten and its SDL2 port source, plus the Mediabunny sources.
- `SHA256SUMS.txt`: SHA-256 checksums for both ZIP files. Each inner source archive also has its own SHA-256 in `sources.lock.json`.
- GitHub's tag source archive supplies the extension's TypeScript/React source, tests, package lock, packaging scripts and these notices.

No GitHub token is required to build the extension. Access to release files follows the repository's visibility and GitHub access controls.

## Exact upstream references

The core release commit is **`71aa99d37c02a7b4c435275ca9ef50e612f6efa1`** in `ffmpegwasm/ffmpeg.wasm`; its `packages/core/package.json` declares 0.12.10. **The similarly named repository tag `v0.12.10` is not this core release**: that older tag contains core 0.12.6.

The core release's `Dockerfile` pins FFmpeg n5.1.4 and Emscripten 3.1.40 and lists the codec/filter libraries. This distribution resolves its dependency references to immutable commits. The two moving references (`x264` / `4-cores` and `lame` / `master`) are resolved at the upstream core release date, 2025-01-07. Emscripten's `tools/ports/sdl2.py` identifies SDL release-2.24.2.

The wrapper release is commit **`f78aed147c4185484da8eba1d97c51354a5e3352`**. Runtime npm package versions and integrity hashes are in the extension's `package-lock.json`. `release:verify` compares distributed core bytes with the pinned installed npm package.

## Rebuild / inspect

1. Extract the `ffmpeg-wasm-<revision>.tar.gz` archive. It contains `Dockerfile`, `build/`, `src/bind/`, `src/fftools/`, package definitions and upstream license text.
2. The other archives contain the corresponding libraries. Preserve their individual notices. `sources.lock.json` maps upstream repositories/references to the archived commits and hashes.
3. Follow the upstream Docker build with Emscripten 3.1.40. For the single-thread core, from the extracted upstream project run:

   ```sh
   docker buildx build --build-arg FFMPEG_ST=yes --target exportor -o ./core-output .
   ```

4. For fixed source revisions, replace Dockerfile dependency refs with the revisions in `sources.lock.json`, or adapt its source stages to the provided archives. Build tools and base container images may require network access. The `zimg` repository declares test-only submodules; the default library build in `build/zimg.sh` does not enable those tests.
5. The resulting ESM core goes in the extension's local `ffmpeg/` directory during packaging. A modified core requires updating the source bundle, notices, integrity records and output verification.

This release ships upstream npm binaries; rebuilding the toolchain locally has not been verified to produce byte-identical output. The archives and scripts make the source and build inputs available for inspection and rebuilding; they are not a claim of a reproducible binary build.

## Generate the companion archive

In the Gif Toolkit repository, run `npm run package:sources`. It downloads only the pinned public source URLs and verifies all SHA-256 values; cached archives are verified again before reuse. It never reads `.env`. `npm run release:verify` checks both final ZIPs and generates `SHA256SUMS.txt`.

License texts are under `licenses/` beside this file in the extension, and inside each upstream source archive. Libraries and optional source files keep their own copyright and license terms.

## Added in 0.1.6

- `gifsicle-wasm-browser` 1.5.19: the build writes `tool.workerLocalUrl` verbatim to the extension as `gifsicle-worker.js`. Its upstream source snapshot and Gifsicle 1.92 source are included in the lock and companion archive. The referenced `wasm-codecs` Dockerfile/build script documents the Emscripten build used as the wrapper’s starting point.
- Mediabunny 1.56.3: its exact `src/`, package metadata and MPL-2.0 notice from the pinned npm package are included under `mediabunny/` in the companion source archive. The extension does not modify these sources.

## Added in 0.1.7

- `googlevideo` 4.1.1 and `mpd-parser` 1.4.0, with their runtime dependencies, are bundled locally. Versions and npm integrity values are pinned in `package-lock.json`; upstream license texts are distributed under `third_party/licenses/` and listed in `THIRD_PARTY_NOTICES.md`.
- `@bufbuild/protobuf` 2.15.0 provides the public protobuf wire reader/writer. Its Apache-2.0 license is from upstream revision `f72f5295c853b7be8c0828f350e4f2803c8afdde` (`v2.15.0`). The upstream Google BSD notice from its wire/varint implementation is preserved separately in `licenses/bufbuild-protobuf/BSD-NOTICE.txt`.
- YouTube session binding preserves unknown protobuf client-identity fields without modifying the upstream protocol library. No remote player JavaScript is evaluated, and playback tokens are not included in either archive.
