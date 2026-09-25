import { errorCode, hasResult, httpOrigin, isTerminal, POLICY, prepareSegment, TaskError, validateOutputName, validateSettings, type DownloadBatchResult, type Job, type MediaSource, type Reply } from './shared/model';
import { parseDownloadSelection } from './shared/download-selection';
import { distinctSourceTitles, retainImageMetadata, sameSource, withImageMetadata } from './shared/sources';
import { isLocalSource } from './shared/local-source';
import { getJob, renameResult } from './shared/storage';
import { loadPreferences, savePreferences } from './shared/preferences';
import { installPageObserver, readPageMedia, type YoutubeSession } from './shared/page-media';
import { attachResources, youtubeId } from './shared/media-resource';

const isExtension = (sender: chrome.runtime.MessageSender) => sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
let creating: Promise<void> | undefined;
async function ensureProcessor() {
  // v0.1.7: a context becomes visible before its initial module has loaded. Queue the
  // existence check as well as creation, so concurrent history/enqueue requests wait
  // for the same completed page load instead of messaging a half-created processor.
  if (!creating) creating = (async () => {
    if ((await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length) return;
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS], justification: 'Decode animation frames and encode GIFs locally without blocking the page.' });
  })().finally(() => { creating = undefined; });
  await creating;
}
async function processor<T>(type: string, data = {}): Promise<T> {
  await ensureProcessor();
  // createDocument resolves after initial page load; concurrent callers share that boundary.
  const response: Reply<T> = await chrome.runtime.sendMessage({ target: 'offscreen', type, ...data });
  if (!response?.ok) throw new TaskError(response?.error ?? 'interrupted');
  return response.data;
}
async function downloadResult(id: string, title?: string, saveAs = false): Promise<number> {
  let job = await getJob(id);
  if (!job?.result || job.stage !== 'completed') throw new TaskError('invalidOutput');
  if (!hasResult(job)) throw new TaskError('resultUnavailable');
  if (title !== undefined) {
    // Re-read in the write transaction so renaming cannot resurrect a cleared file.
    job = await renameResult(job.id, validateOutputName(title));
    void chrome.runtime.sendMessage({ type: 'job-updated', job }).catch(() => {});
  }
  const url = await processor<string>('result-url', { id: job.id });
  try {
    const downloadId = await chrome.downloads.download({ url, filename: `GifToolkit/${job.result!.filename}`, saveAs, conflictAction: 'uniquify' })
      .catch(() => { console.warn('GIF save rejected', { id, phase: 'download-start', code: 'saveFailed' }); throw new TaskError('saveFailed'); });
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (!item || item.state !== 'in_progress') await processor('release-result-url', { url });
    if (item?.state === 'interrupted') throw new TaskError(item.error === 'USER_CANCELED' ? 'cancelled' : 'saveFailed');
    return downloadId;
  } catch (error) {
    await processor('release-result-url', { url }); throw error;
  }
}
async function scan(tabId: number, focus?: { frameId?: number; srcUrl?: string; mediaType?: string }) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: installPageObserver });
  const injection = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
  const results = await Promise.allSettled(injection.map(async result => {
    const targetFocus = focus && result.frameId === (focus.frameId ?? 0) ? { useContext: true, srcUrl: focus.srcUrl, mediaType: focus.mediaType } : undefined;
    const response: Reply<MediaSource[]> = await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'scan', focus: targetFocus }, { frameId: result.frameId });
    if (!response.ok) throw new TaskError(response.error);
    const [page] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [result.frameId] }, world: 'MAIN', func: readPageMedia });
    return response.data.map(s => ({ ...(s.kind === 'video' && page.result ? attachResources(s, page.result) : s), tabId, frameId: result.frameId }));
  }));
  const previous = await chrome.storage.session.get('sources');
  const sources = distinctSourceTitles(retainImageMetadata(results.flatMap(r => r.status === 'fulfilled' ? r.value : []), previous.sources ?? []),
    (title, index) => chrome.i18n.getMessage('numberedMedia', [String(index).padStart(2, '0'), title]));
  const frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => ({ page: location.href, frames: [...document.querySelectorAll('iframe[src]')].filter(frame => { const rect = frame.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(frame).visibility !== 'hidden'; }).map(frame => (frame as HTMLIFrameElement).src) }) });
  const frameOrigins = [...new Set(frames.flatMap(result => result.result?.frames ?? []).filter(url => /^https?:/.test(url)).map(httpOrigin))];
  const missingFrameOrigins = (await Promise.all(frameOrigins.map(async origin => await chrome.permissions.contains({ origins: [origin] }) ? undefined : origin))).filter(Boolean);
  await chrome.storage.session.set({ activeTabId: tabId, activePageUrl: frames.find(frame => frame.frameId === 0)?.result?.page, missingFrameOrigins, sources, scanError: null });
  return sources;
}
async function rebuildMenu() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'gif-create', title: chrome.i18n.getMessage('menuCreate'), contexts: ['video', 'image'] });
  chrome.contextMenus.create({ id: 'gif-scan', title: chrome.i18n.getMessage('menuScan'), contexts: ['page', 'frame'] });
}
chrome.runtime.onInstalled.addListener(() => {
  void rebuildMenu(); void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  // v0.1.1: migrate already-authorized sites as well as new registrations to early interception.
  void chrome.scripting.getRegisteredContentScripts().then(scripts => {
    const sites = scripts.filter(s => s.id.startsWith('site-') && s.js?.includes('content.js'));
    if (sites.length) {
      void chrome.scripting.updateContentScripts(sites.map(s => ({ id: s.id, runAt: 'document_start' })));
      const missing = sites.filter(site => !scripts.some(script => script.id === `media-${site.id}`));
      if (missing.length) return chrome.scripting.registerContentScripts(missing.map(site => ({ id: `media-${site.id}`, matches: site.matches, allFrames: true, runAt: 'document_start', world: 'MAIN', js: ['page-observer.js'], persistAcrossSessions: true })));
    }
  });
});
chrome.action.onClicked.addListener(tab => {
  if (!tab.id) return;
  // Opening must happen inside the user gesture, before asynchronous scanning.
  void chrome.sidePanel.open({ tabId: tab.id });
  void scan(tab.id).catch(() => chrome.storage.session.set({ sources: [], scanError: 'pageUnavailable' }));
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  void chrome.sidePanel.open({ tabId: tab.id });
  void (async () => {
    const sources = await scan(tab.id!, { frameId: info.frameId, srcUrl: info.srcUrl, mediaType: info.mediaType });
    if (info.srcUrl && !sources.some(s => s.selected)) {
      const matched = sources.filter(s => s.url === info.srcUrl);
      if (matched.length === 1) matched[0].selected = true;
    }
    await chrome.storage.session.set({ activeTabId: tab.id, sources, scanError: null });
  })().catch(() => chrome.storage.session.set({ sources: [], scanError: 'pageUnavailable' }));
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== 'loading') return;
  void chrome.storage.session.get('activeTabId').then(s => {
    if (s.activeTabId === tabId) return chrome.storage.session.set({ sources: [], scanError: 'sourceChanged' });
  });
});
// v0.1.9: download URLs are leases, not permanent in-memory copies of every saved GIF.
// Chrome's download record survives service-worker restarts, so no in-memory ID map is needed.
chrome.downloads.onChanged.addListener(delta => {
  if (!delta.state || delta.state.current === 'in_progress') return;
  void chrome.downloads.search({ id: delta.id }).then(async ([item]) => {
    if (item?.url.startsWith(`blob:${chrome.runtime.getURL('')}`)) await processor('release-result-url', { url: item.url });
  }).catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'background' || sender.id !== chrome.runtime.id) return;
  const handle = async () => {
    if (!isExtension(sender)) throw new TaskError('permissionRequired');
    switch (message.type) {
      case 'load-preferences': return loadPreferences();
      case 'save-preferences': await savePreferences(message.settings); return null;
      case 'scan': {
        let tabId = message.tabId;
        if (!Number.isInteger(tabId)) {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); tabId = tab?.id;
        }
        if (!Number.isInteger(tabId)) throw new TaskError('pageUnavailable');
        return scan(tabId, message.focus);
      }
      case 'list': return processor('list');
      case 'history': return processor('history');
      case 'cache-summary': return processor('cache-summary');
      case 'clear-cache': return processor('clear-cache', { ids: message.ids });
      case 'clear-history': return processor('clear-history', { ids: message.ids });
      case 'enqueue': {
        if (!Array.isArray(message.items) || !message.items.length || message.items.length > POLICY.maxJobs) throw new TaskError('invalidSegment');
        const jobs: Job[] = message.items.map((item: { source: MediaSource; segment: Job['segment']; settings: Job['settings'] }) => {
          const settings = validateSettings(item.settings); const source = item.source;
          if (!source || !source.documentKey || !source.id || !['video', 'gif', 'webp', 'image'].includes(source.kind)) throw new TaskError('sourceGone');
          // Picked files have no tab or web origin; everything else must still identify both.
          if (isLocalSource(source)) {
            if (source.kind !== 'video' || !source.local) throw new TaskError('sourceGone');
          } else {
            if (!Number.isInteger(source.tabId) || !Number.isInteger(source.frameId)) throw new TaskError('sourceGone');
            httpOrigin(source.pageUrl);
          }
          source.title = validateOutputName(source.title);
          const segment = prepareSegment(item.segment, source, settings.fps, settings.speed);
          return { id: crypto.randomUUID(), source, segment, settings,
            stage: 'queued', progress: 0, createdAt: Date.now(), updatedAt: Date.now() };
        });
        return processor('enqueue', { jobs });
      }
      case 'cancel': return processor('cancel', { id: message.id });
      case 'delete': return processor('delete', { id: message.id });
      case 'inspect-image': {
        const meta = await processor<Parameters<typeof withImageMetadata>[1]>('inspect-image', { source: message.source });
        const saved = await chrome.storage.session.get('sources');
        if (saved.sources?.some((source: MediaSource) => sameSource(source, message.source))) {
          await chrome.storage.session.set({ sources: saved.sources.map((source: MediaSource) => sameSource(source, message.source) ? withImageMetadata(source, meta) : source) });
        }
        return meta;
      }
      case 'local-list': return processor('local-list');
      case 'local-import': return processor('local-import', { files: message.files });
      case 'local-remove': return processor('local-remove', { id: message.id });
      case 'player': {
        const job = await getJob(message.jobId);
        if (!job || (isTerminal(job.stage) && message.command?.type !== 'cancel-read')) throw new TaskError('cancelled');
        const source = job.source;
        const reply: Reply = await chrome.tabs.sendMessage(source.tabId, { target: 'content', ...message.command, documentKey: source.documentKey, sourceId: source.id, token: job.id, expectedUrl: source.url, expectedPageUrl: source.pageUrl, expectedPoster: source.poster }, { frameId: source.frameId }).catch(() => { throw new TaskError('sourceGone'); });
        if (!reply?.ok) throw new TaskError(reply?.error ?? 'sourceGone');
        return reply.data;
      }
      case 'resolve-youtube': {
        const job = await getJob(message.jobId);
        if (!job || isTerminal(job.stage)) throw new TaskError('cancelled');
        const source = job.source;
        const [snapshot] = await chrome.scripting.executeScript({ target: { tabId: source.tabId, frameIds: [source.frameId] }, world: 'MAIN', func: readPageMedia });
        const video = snapshot.result?.videos.find(video => video.id === source.id && video.url === source.url);
        const session: YoutubeSession | undefined = video?.youtube;
        if (!session || session.videoId !== (source.youtubeVideoId ?? youtubeId(source.pageUrl))) throw new TaskError('sourceChanged');
        return session;
      }
      case 'media-permission': return chrome.permissions.contains({ origins: [httpOrigin(message.url)] });
      case 'download': return downloadResult(message.id, message.title, !!message.saveAs);
      case 'download-many': {
        // v0.1.10: one immutable selection belongs to the background, so closing or
        // filtering the panel cannot change which files are handed to Chrome.
        const items = parseDownloadSelection(message.items);
        const result: DownloadBatchResult = { started: [], failed: [] };
        for (const item of items) {
          try { result.started.push({ id: item.id, downloadId: await downloadResult(item.id, validateOutputName(item.title)) }); }
          catch (error) { result.failed.push({ id: item.id, error: errorCode(error) }); }
        }
        return result;
      }
      default: throw new TaskError('pageUnavailable');
    }
  };
  void handle().then(data => sendResponse({ ok: true, data } satisfies Reply), error => sendResponse({ ok: false, error: errorCode(error) } satisfies Reply));
  return true;
});
