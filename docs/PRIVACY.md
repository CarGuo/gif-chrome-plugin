# 隐私与权限 / Privacy and permissions

适用版本 / Version: **0.1.13** · 更新日期 / Updated: **2026-09-25**

## 数据处理

Gif Toolkit 不设账号、统计上报、广告追踪或转码服务器。编码器随扩展本地打包，网页画面和生成的 GIF 在浏览器所在设备处理。

- **本地导入**：用户从设备选择的视频只在本机读取，文件字节存于扩展 IndexedDB，处理全程不发起任何网络请求、不申请网络来源权限。导入项跨会话保留，可在来源卡片点「×」单独删除、点「清空全部已导入视频」批量删除，或在片段区点「移除导入」；正在被任务使用的内容不会被删除。
- **页面读取**：读取用户当前操作或明确授权网站中的媒体元素、标题、来源链接、尺寸及时间信息。所有网页视频先下载，在扩展工作线程中解码；不再逐帧拖动页面播放器。
- **网络请求**：下载视频或 GIF / WebP 时，扩展直接请求素材的原始 URL，可能携带该来源已有的登录凭据。X 公开帖还会向 `cdn.syndication.twimg.com` 请求该帖的公开媒体信息，再从 `video.twimg.com` 下载匹配所选播放器海报的 MP4；不读取 Cookie API。HLS/DASH 会请求清单及所选清晰度的分片。YouTube 会读取当前播放器发出的 SABR 媒体请求参数，在内存中复用当前视频的播放会话；不会生成或绕过站点授权。相关请求仍受原站的网络与隐私政策影响。
- **会话观察**：仅记录媒体清单地址、Blob 类型及 YouTube SABR 请求参数，不读取普通请求的响应正文。会话请求正文、PoToken 及播放配置只在内存中处理，不写入任务历史；来源 URL（包括临时签名链接）会随来源信息保存在本地。
- **本地历史与素材**：设置、任务状态、媒体标题、页面 / 素材 URL、选区、成品 GIF 以及导入的本地视频字节存于扩展的 Chrome Storage / IndexedDB 中。没有跨设备同步功能。
- **删除**：历史页“清理缓存”只删除扩展内的 GIF 文件，保留任务元数据；“清空历史”或删除任务会删除对应元数据和文件。自动保留最近 30 个结束任务；网页视频的原始输入和处理临时数据在任务结束后释放。导入的本地视频不随历史清理删除，需在制作页单独「移除导入」。卸载扩展会清除其全部本地数据（含本地导入）。已保存到下载目录的文件需自行删除；扩展不清除 Chrome 的全局缓存或其他网站数据。
- **错误反馈**：扩展不会自动发送错误报告。用户通过 GitHub 提交的内容受 GitHub 的政策约束，请不要包含私人媒体、Cookie 或 token。

## 权限用途

| 权限 | 用途 |
| --- | --- |
| `contextMenus` | 为媒体和页面提供生成 / 选择入口 |
| `activeTab` | 用户点击扩展或菜单后访问当前页面 |
| `scripting` | 注入媒体扫描、右键处理及 MAIN 世界媒体请求观察代码 |
| `sidePanel` | 显示选择、设置和任务界面 |
| `storage` | 保存偏好、来源状态和任务元数据 |
| `downloads` | 将已生成 GIF 保存到磁盘 |
| `offscreen` | 关闭侧栏后仍可调度工作线程、管理媒体 Blob |
| 可选 `http://*/*` / `https://*/*` | 普通文件、平台解析器和 iframe 按来源授权；HLS/DASH 分片可跨 CDN，生成时请求 HTTP/HTTPS 来源权限；安装时不默认取得全站访问 |

扩展不申请 `cookies`、`webRequest`、`debugger`、屏幕录制、摄像头或麦克风权限。站点权限可在 Chrome 扩展详情中撤销。撤销后，依赖相应站点权限的功能将停止，已保存的本地历史不会自动删除。

## English summary

Gif Toolkit has no application accounts, analytics, ad tracking or conversion server. Executable code is packaged with the extension; media frames and GIF encoding are processed on your device.

Videos imported from your device are read entirely on your device, with their bytes kept in extension IndexedDB. They trigger no network request and no host permission. Imports persist across sessions until you choose Remove import, and cannot be removed while a job uses them.

The extension reads media elements and relevant titles, URLs, dimensions and timings on the current page after a user action, or on explicitly authorized sites. Webpage video/GIF/WebP input is downloaded from its source URL and may use existing credentials for that origin. Public X media is resolved through `cdn.syndication.twimg.com` and downloaded from `video.twimg.com`, matching the selected player poster. No Cookie API is used. HLS/DASH downloads fetch manifests and the selected video representation. YouTube reuses media-request parameters from the current player session in memory. It does not generate or bypass site authorization. Media decoding and protocol parsing run in Workers; page frame capture has been removed.

Preferences, task metadata, source URLs, selected ranges, result GIFs and imported local video bytes are stored locally in Chrome Storage / IndexedDB. No cross-device synchronization is implemented. Clear cache removes retained GIF files while keeping history; deleting a task or clearing history removes the selected records and their files. The latest 30 finished tasks are retained. Webpage input and processing data are released after each task; imported local videos survive history cleanup and must be removed separately. Uninstalling clears all extension data, including local imports; downloaded files remain under your control. Cleanup does not clear Chrome's global cache or other website data.

Permissions provide context menus, current-page access, script injection, the side panel, local storage, downloads and offscreen processing. Files, provider resolvers and embedded frames request access by origin. HLS/DASH can reference segments on arbitrary CDNs, so generating these sources requests HTTP/HTTPS origin access. This access is optional and is not granted on installation. The extension does not request cookies, network interception, debugger, screen recording, camera or microphone permissions.

Site access can be revoked in Chrome's extension settings. Local history is not automatically deleted when access is revoked. Error reports are not uploaded automatically. Please do not post private media, cookies or access tokens to GitHub issues.
