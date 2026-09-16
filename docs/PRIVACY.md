# 隐私与权限 / Privacy and permissions

适用版本 / Version: **0.1.5** · 更新日期 / Updated: **2026-09-16**

## 数据处理

Gif Toolkit 不设账号、统计上报、广告追踪或转码服务器。编码器随扩展本地打包，网页画面和生成的 GIF 在浏览器所在设备处理。

- **页面读取**：读取用户当前操作或明确授权网站中的媒体元素、标题、来源链接、尺寸及时间信息。视频通过页面播放器已解码的画面取帧。
- **网络请求**：读取 GIF / WebP 时，扩展直接请求素材的原始 URL，可能携带该来源已有的登录凭据。视频定位也可能使网站播放器继续缓冲。相关请求仍受原站的网络与隐私政策影响。
- **本地历史**：设置、任务状态、媒体标题、页面 / 素材 URL、选区以及成品 GIF 存在扩展的 Chrome Storage / IndexedDB 中。没有跨设备同步功能。
- **删除**：删除任务会删除对应元数据和 GIF；自动保留最近 30 个结束任务。卸载扩展会清除其本地数据。下载目录中的文件需自行删除。
- **错误反馈**：扩展不会自动发送错误报告。用户通过 GitHub 提交的内容受 GitHub 的政策约束，请不要包含私人媒体、Cookie 或 token。

## 权限用途

| 权限 | 用途 |
| --- | --- |
| `contextMenus` | 为媒体和页面提供生成 / 选择入口 |
| `activeTab` | 用户点击扩展或菜单后访问当前页面 |
| `scripting` | 注入媒体扫描、右键和播放器取帧代码 |
| `sidePanel` | 显示选择、设置和任务界面 |
| `storage` | 保存偏好、来源状态和任务元数据 |
| `downloads` | 将已生成 GIF 保存到磁盘 |
| `offscreen` | 关闭侧栏后仍可调度工作线程、管理媒体 Blob |
| 可选 `http://*/*` / `https://*/*` | 按需授权具体网站的提前右键处理，或 GIF / WebP 原始资源访问；不是安装时默认取得全站访问 |

扩展不申请 `cookies`、`webRequest`、`debugger`、屏幕录制、摄像头或麦克风权限。站点权限可在 Chrome 扩展详情中撤销。撤销后，依赖相应站点权限的功能将停止，已保存的本地历史不会自动删除。

## English summary

Gif Toolkit has no application accounts, analytics, ad tracking or conversion server. Executable code is packaged with the extension; media frames and GIF encoding are processed on your device.

The extension reads media elements and relevant titles, URLs, dimensions and timings on the current page after a user action, or on explicitly authorized sites. GIF/WebP input files are requested directly from their source URLs and may use existing credentials for those origins. Seeking video can cause the original player to buffer more media.

Preferences, task metadata, source URLs, selected ranges and result GIFs are stored locally in Chrome Storage / IndexedDB. No cross-device synchronization is implemented. Deleting a task removes its stored result and metadata. The latest 30 finished tasks are retained. Uninstalling clears extension data; downloaded files remain under your control.

Permissions provide context menus, current-page access, script injection, the side panel, local storage, downloads and offscreen processing. Optional host permissions are granted for particular websites or image origins when needed, not blanket access on installation. The extension does not request cookies, network interception, debugger, screen recording, camera or microphone permissions.

Site access can be revoked in Chrome's extension settings. Local history is not automatically deleted when access is revoked. Error reports are not uploaded automatically. Please do not post private media, cookies or access tokens to GitHub issues.
