import { errorCode, httpOrigin, isTerminal, POLICY, TaskError, validateOutputName, validateSegment, validateSettings, type Job, type MediaSource, type Reply } from './shared/model';
import { makeFilename } from './shared/filename';
import { retainImageMetadata, sameSource, withImageMetadata } from './shared/sources';
import { getJob, getJobs, saveJob } from './shared/storage';
import { loadPreferences, savePreferences } from './shared/preferences';

const isExtension = (sender: chrome.runtime.MessageSender) => sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
let creating: Promise<void> | undefined;
async function ensureProcessor() {
  if ((await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length) return;
  if (!creating) creating = chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS], justification: 'Decode animation frames and encode GIFs locally without blocking the page.' }).finally(() => { creating = undefined; });
  await creating;
}
async function processor<T>(type: string, data = {}): Promise<T> {
  await ensureProcessor();
  // The initial handshake is sent after offscreen DOM has loaded; its module listener announces readiness.
  const response: Reply<T> = await chrome.runtime.sendMessage({ target: 'offscreen', type, ...data });
  if (!response?.ok) throw new TaskError(response?.error ?? 'interrupted');
  return response.data;
}
async function scan(tabId: number, focus?: { frameId?: number; srcUrl?: string; mediaType?: string }) {
  const injection = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
  const results = await Promise.allSettled(injection.map(async result => {
    const targetFocus = focus && result.frameId === (focus.frameId ?? 0) ? { useContext: true, srcUrl: focus.srcUrl, mediaType: focus.mediaType } : undefined;
    const response: Reply<MediaSource[]> = await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'scan', focus: targetFocus }, { frameId: result.frameId });
    if (!response.ok) throw new TaskError(response.error);
    return response.data.map(s => ({ ...s, tabId, frameId: result.frameId }));
  }));
  const previous = await chrome.storage.session.get('sources');
  const sources = retainImageMetadata(results.flatMap(r => r.status === 'fulfilled' ? r.value : []), previous.sources ?? []);
  await chrome.storage.session.set({ activeTabId: tabId, sources, scanError: null });
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
    if (sites.length) return chrome.scripting.updateContentScripts(sites.map(s => ({ id: s.id, runAt: 'document_start' })));
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
      case 'enqueue': {
        if (!Array.isArray(message.items) || !message.items.length || message.items.length > POLICY.maxJobs) throw new TaskError('invalidSegment');
        const jobs: Job[] = message.items.map((item: { source: MediaSource; segment: Job['segment']; settings: Job['settings'] }) => {
          const settings = validateSettings(item.settings); const source = item.source;
          if (!source || !Number.isInteger(source.tabId) || !Number.isInteger(source.frameId) || !source.documentKey || !source.id || !['video', 'gif', 'webp', 'image'].includes(source.kind)) throw new TaskError('sourceGone');
          httpOrigin(source.pageUrl);
          source.title = validateOutputName(source.title);
          validateSegment(item.segment, source.duration, settings.fps, settings.speed);
          return { id: crypto.randomUUID(), source, segment: { ...item.segment }, settings,
            stage: 'queued', progress: 0, createdAt: Date.now(), updatedAt: Date.now() };
        });
        return processor('enqueue', { jobs });
      }
      case 'cancel': return processor('cancel', { id: message.id });
      case 'delete': {
        const job = await getJob(message.id); if (job && !isTerminal(job.stage)) throw new TaskError('playerBusy');
        return processor('delete', { id: message.id });
      }
      case 'inspect-image': {
        const meta = await processor<Parameters<typeof withImageMetadata>[1]>('inspect-image', { source: message.source });
        const saved = await chrome.storage.session.get('sources');
        if (saved.sources?.some((source: MediaSource) => sameSource(source, message.source))) {
          await chrome.storage.session.set({ sources: saved.sources.map((source: MediaSource) => sameSource(source, message.source) ? withImageMetadata(source, meta) : source) });
        }
        return meta;
      }
      case 'player': {
        const job = await getJob(message.jobId);
        if (!job || (isTerminal(job.stage) && message.command?.type !== 'restore')) throw new TaskError('cancelled');
        const source = job.source;
        const reply: Reply = await chrome.tabs.sendMessage(source.tabId, { target: 'content', ...message.command, documentKey: source.documentKey, sourceId: source.id, token: job.id, expectedUrl: source.url, expectedPageUrl: source.pageUrl, expectedPoster: source.poster }, { frameId: source.frameId }).catch(() => { throw new TaskError('sourceGone'); });
        if (!reply?.ok) throw new TaskError(reply?.error ?? 'sourceGone');
        return reply.data;
      }
      case 'image-permission': return chrome.permissions.contains({ origins: [httpOrigin(message.url)] });
      case 'download': {
        const job = await getJob(message.id);
        if (!job?.result || job.stage !== 'completed') throw new TaskError('invalidOutput');
        // v0.1.3: rename the persisted result metadata, not the encoded bytes. History and download agree.
        if (message.title !== undefined) {
          job.source = { ...job.source, title: validateOutputName(message.title) };
          job.result.filename = makeFilename(job);
          job.updatedAt = Date.now();
          await saveJob(job);
          void chrome.runtime.sendMessage({ type: 'job-updated', job }).catch(() => {});
        }
        const url = await processor<string>('result-url', { id: job.id });
        return chrome.downloads.download({ url, filename: `GifToolkit/${job.result.filename}`, saveAs: !!message.saveAs });
      }
      default: throw new TaskError('pageUnavailable');
    }
  };
  void handle().then(data => sendResponse({ ok: true, data } satisfies Reply), error => sendResponse({ ok: false, error: errorCode(error) } satisfies Reply));
  return true;
});
