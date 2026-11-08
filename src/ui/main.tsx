import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { defaultSegment, DEFAULT_SETTINGS, DROP_FRAME_MODES, editSegment, errorCode, hasResult, httpOrigin, isTerminal, outputDuration, POLICY, prepareSegment, rpc, TaskError, validateOutputName, validateSettings, type CacheSummary, type DownloadBatchResult, type DropFrames, type ExportFormat, type ExportSettings, type HistoryProblem, type HistorySnapshot, type Job, type MediaSource, type RecordingState, type Segment } from '../shared/model';
import { makeFilename } from '../shared/filename';
import { initializeClips, withImageMetadata } from '../shared/sources';
import { isLocalSource } from '../shared/local-source';
import { mediaOrigins } from '../shared/acquisition';
import { getResult } from '../shared/storage';
import { dateTime, errorText, number, stageText, t, time, type TextKey } from './i18n';
import { CleanupDialog, type CleanupRequest } from './cleanup-dialog';
import './style.css';

const dropFrameLabels: Record<DropFrames, TextKey> = { none: 'dropFramesOff', duplicates: 'dropFramesDuplicates', every2: 'dropFramesEvery2', every3: 'dropFramesEvery3', every4: 'dropFramesEvery4' };

function App() {
  const [sources, setSources] = useState<MediaSource[]>([]);
  const [localSources, setLocalSources] = useState<MediaSource[]>([]);
  const [missingFrameOrigins, setMissingFrameOrigins] = useState<string[]>([]);
  const [sourceNames, setSourceNames] = useState<Record<string, string>>({});
  const [jobNames, setJobNames] = useState<Record<string, string>>({});
  const [selectedJobs, setSelectedJobs] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Record<string, Segment[]>>({});
  const [settings, setSettings] = useState<ExportSettings>(DEFAULT_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [historyProblems, setHistoryProblems] = useState<HistoryProblem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; job: Job } | null>(null);
  const [view, setView] = useState<'create' | 'history'>('create');
  const [query, setQuery] = useState('');
  const [historyFilter, setHistoryFilter] = useState('all');
  const [cache, setCache] = useState<CacheSummary>();
  const [cleanup, setCleanup] = useState<CleanupRequest | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [recordingState, setRecordingState] = useState<RecordingState>({ stage: 'idle' });
  const [recordingElapsed, setRecordingElapsed] = useState('00:00.0');
  const previewRequest = useRef(0);
  const sourceTab = useRef<number | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);

  function acceptLocalSources(next: MediaSource[], selectNew = false) {
    setLocalSources(prevLocal => {
      const prevIds = new Set(prevLocal.map(s => s.id));
      setSelected(previous => {
        const updated: Record<string, Segment[]> = selectNew ? { ...previous } : Object.fromEntries(next.filter(s => previous[s.id]).map(s => [s.id, initializeClips(previous[s.id], s)]));
        if (selectNew) {
          for (const s of next) {
            if (previous[s.id]) updated[s.id] = initializeClips(previous[s.id], s);
            else if (!prevIds.has(s.id)) updated[s.id] = [defaultSegment(s)];
          }
        }
        return updated;
      });
      return next;
    });
  }
  async function loadLocalSources(selectNew = false) {
    acceptLocalSources(await rpc<MediaSource[]>({ target: 'background', type: 'local-list' }), selectNew);
  }

  function acceptSources(next: MediaSource[]) {
    setSources(next); sourceTab.current = next[0]?.tabId ?? sourceTab.current;
    setSelected(previous => Object.fromEntries(next.filter(s => previous[s.id] || s.selected || next.length === 1).map(s => [s.id,
      initializeClips(previous[s.id], s)])));
  }
  async function refreshJobs() {
    const history = await rpc<HistorySnapshot>({ target: 'background', type: 'history' });
    setJobs(history.jobs); setHistoryProblems(history.problems);
  }
  useEffect(() => {
    void rpc<ExportSettings>({ target: 'background', type: 'load-preferences' }).then(values => {
      setSettings(values); setSettingsReady(true);
    }).catch(error => setNotice(errorText(errorCode(error))));
    void chrome.storage.session.get(['sources', 'activeTabId', 'missingFrameOrigins', 'recordingState']).then(data => {
      sourceTab.current = data.activeTabId;
      setMissingFrameOrigins(data.missingFrameOrigins ?? []);
      if (data.recordingState) setRecordingState(data.recordingState);
      acceptSources(data.sources ?? []);
    });
    void loadLocalSources().catch(error => setNotice(errorText(errorCode(error))));
    void refreshJobs().catch(error => setNotice(errorText(errorCode(error))));
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes.activeTabId) sourceTab.current = changes.activeTabId.newValue;
      if (area === 'session' && changes.missingFrameOrigins) setMissingFrameOrigins(changes.missingFrameOrigins.newValue ?? []);
      if (area === 'session' && changes.sources) acceptSources(changes.sources.newValue ?? []);
      if (area === 'session' && changes.recordingState) setRecordingState(changes.recordingState.newValue ?? { stage: 'idle' });
      if (area === 'session' && changes.scanError?.newValue) setNotice(errorText(changes.scanError.newValue));
    };
    const onMessage = (message: { type: 'job-updated'; job: Job } | { type: 'jobs-removed' | 'cache-cleared'; ids: string[] } | { type: 'local-sources-updated' }) => {
      if (message.type === 'local-sources-updated') {
        void loadLocalSources(true).catch(error => setNotice(errorText(errorCode(error))));
        void refreshJobs().catch(error => setNotice(errorText(errorCode(error))));
        return;
      }
      if (message.type === 'job-updated') setJobs(previous => [message.job, ...previous.filter(j => j.id !== message.job.id)].sort((a, b) => b.createdAt - a.createdAt));
      if (message.type === 'jobs-removed' || message.type === 'cache-cleared') {
        previewRequest.current++;
        if (message.type === 'jobs-removed') {
          setJobs(previous => previous.filter(job => !message.ids.includes(job.id)));
          setHistoryProblems(previous => previous.filter(problem => !message.ids.includes(problem.id)));
        }
        else void refreshJobs().catch(error => setNotice(errorText(errorCode(error))));
        setPreview(previous => previous && message.ids.includes(previous.job.id) ? null : previous);
      }
    };
    const preventWindowFileDrop = (event: DragEvent) => {
      if (event.dataTransfer && (event.dataTransfer.files?.length > 0 || [...(event.dataTransfer.types ?? [])].includes('Files'))) {
        event.preventDefault();
      }
    };
    window.addEventListener('dragover', preventWindowFileDrop);
    window.addEventListener('drop', preventWindowFileDrop);
    chrome.storage.onChanged.addListener(onStorage); chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      window.removeEventListener('dragover', preventWindowFileDrop);
      window.removeEventListener('drop', preventWindowFileDrop);
      chrome.storage.onChanged.removeListener(onStorage);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, []);
  useEffect(() => {
    if (recordingState.stage !== 'recording' || !recordingState.startedAt) {
      setRecordingElapsed('00:00.0');
      return;
    }
    const updateTimer = () => {
      const tenths = Math.max(0, Math.floor((Date.now() - recordingState.startedAt!) / 100));
      const mins = String(Math.floor(tenths / 600)).padStart(2, '0');
      const secs = String(Math.floor((tenths % 600) / 10)).padStart(2, '0');
      setRecordingElapsed(`${mins}:${secs}.${tenths % 10}`);
    };
    updateTimer();
    const id = window.setInterval(updateTimer, 100);
    return () => window.clearInterval(id);
  }, [recordingState.stage, recordingState.startedAt]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  const history = jobs.filter(job => isTerminal(job.stage));
  const historyRevision = history.map(job => `${job.id}:${job.updatedAt}`).join(',') + historyProblems.map(problem => problem.id).join(',');
  useEffect(() => {
    if (view !== 'history') return;
    let mounted = true;
    void rpc<CacheSummary>({ target: 'background', type: 'cache-summary' }).then(value => { if (mounted) setCache(value); })
      .catch(error => { if (mounted) setNotice(errorText(errorCode(error))); });
    return () => { mounted = false; };
  }, [view, historyRevision]);
  async function perform(action: () => Promise<void>, busyId: string | null = null) {
    setNotice(null); if (busyId) setBusy(busyId);
    try { await action(); } catch (error) { setNotice(errorText(errorCode(error))); }
    finally { if (busyId) setBusy(null); }
  }
  async function requestMediaAccess(items: MediaSource[]) {
    const origins = mediaOrigins(items);
    if (origins.length) {
      const granted = await chrome.permissions.request({ origins });
      if (!granted) throw new TaskError('permissionRequired');
    }
  }
  async function importLocalFiles(files: FileList | File[] | null) {
    if (!files || !files.length) return;
    const materialized: File[] = [];
    for (const raw of [...files]) {
      if (!raw.size || raw.size > POLICY.inputBytes) throw new TaskError('inputTooLarge');
      const buffer = await raw.arrayBuffer();
      materialized.push(new File([buffer], raw.name || 'video.mp4', { type: raw.type || 'video/mp4', lastModified: raw.lastModified }));
    }
    const imported = await rpc<MediaSource[]>({ target: 'background', type: 'local-import', files: materialized });
    if (imported.length) {
      setLocalSources(previous => [...imported, ...previous]);
      setSelected(previous => ({ ...previous, ...Object.fromEntries(imported.map(source => [source.id, [defaultSegment(source)]])) }));
    }
    if (fileInput.current) fileInput.current.value = '';
  }
  function hasDraggedFiles(event: React.DragEvent) {
    const dt = event.dataTransfer;
    return !!dt && (dt.files?.length > 0 || [...(dt.types ?? [])].includes('Files'));
  }
  function onFileDragOver(event: React.DragEvent) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    if (!draggingFiles) setDraggingFiles(true);
  }
  function onFileDragLeave(event: React.DragEvent) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDraggingFiles(false);
  }
  function onFileDrop(event: React.DragEvent) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setDraggingFiles(false);
    if (busy) return;
    const dropped = event.dataTransfer.files;
    if (dropped?.length) void perform(() => importLocalFiles(dropped), 'local-import');
  }
  async function startRegionRecord() {
    const state = await rpc<RecordingState>({ target: 'background', type: 'start-region-select', tabId: sourceTab.current });
    setRecordingState(state);
  }
  async function beginSelectedRegionRecord() {
    const state = await rpc<RecordingState>({ target: 'background', type: 'start-recording', tabId: recordingState.tabId ?? sourceTab.current, region: recordingState.region });
    setRecordingState(state);
  }
  async function finishRegionRecord(format: ExportFormat) {
    await rpc({ target: 'background', type: 'stop-recording', format });
    setRecordingState({ stage: 'idle' });
    await loadLocalSources(true);
    await refreshJobs();
  }
  async function cancelRegionRecord() {
    await rpc({ target: 'background', type: 'cancel-recording' });
    setRecordingState({ stage: 'idle' });
  }
  async function removeLocal(source: MediaSource) {
    await rpc({ target: 'background', type: 'local-remove', id: source.id });
    setLocalSources(previous => previous.filter(item => item.id !== source.id));
    setSelected(previous => { const next = { ...previous }; delete next[source.id]; return next; });
  }
  async function clearLocalSources() {
    const remaining = await rpc<MediaSource[]>({ target: 'background', type: 'local-clear' });
    setLocalSources(remaining);
    setSelected(previous => {
      const keep = new Set(remaining.map(source => source.id));
      return Object.fromEntries(Object.entries(previous).filter(([id]) => keep.has(id)));
    });
    setNotice(remaining.length ? t('localClearKeptBusy', String(remaining.length)) : t('localClearedAll'));
  }
  async function inspectImage(source: MediaSource, authorized = false) {
    if (!authorized) await requestMediaAccess([source]);
    const meta = await rpc<{ width: number; height: number; duration: number | null; frames: number; kind: MediaSource['kind'] }>({ target: 'background', type: 'inspect-image', source });
    const updated = withImageMetadata(source, meta);
    setSources(previous => previous.map(s => s.id === source.id ? updated : s));
    setSelected(previous => ({ ...previous, [source.id]: initializeClips(previous[source.id], updated) }));
    return updated;
  }
  async function toggle(source: MediaSource) {
    if (selected[source.id]) { setSelected(previous => { const next = { ...previous }; delete next[source.id]; return next; }); return; }
    if (source.kind !== 'video' && !source.frameCount) { await inspectImage(source); return; }
    setSelected(previous => ({ ...previous, [source.id]: [defaultSegment(source)] }));
  }
  function changeClip(sourceId: string, id: string, patch: Partial<Segment>) {
    const duration = allSources.find(source => source.id === sourceId)?.duration ?? null;
    setSelected(previous => ({ ...previous, [sourceId]: previous[sourceId].map(s => s.id === id ? editSegment(s, patch, duration) : s) }));
  }
  const allSources = [...sources, ...localSources];
  const chosen = allSources.filter(s => selected[s.id]);
  const sourceName = (source: MediaSource) => sourceNames[source.id] ?? source.title;
  const jobName = (job: Job) => jobNames[job.id] ?? job.source.title;
  async function download(job: Job, saveAs: boolean) {
    await rpc({ target: 'background', type: 'download', id: job.id, title: validateOutputName(jobName(job)), saveAs });
  }
  const clipCount = chosen.reduce((count, source) => count + selected[source.id].length, 0);
  async function generate(format: ExportFormat = 'gif') {
    validateSettings(settings);
    for (const source of chosen) validateOutputName(sourceName(source));
    // v0.1.6: request selected download/resolver origins in the gesture, before any network await.
    await requestMediaAccess(chosen);
    const items: { source: MediaSource; segment: Segment; settings: ExportSettings; format?: ExportFormat }[] = [];
    for (let source of chosen) {
      let clips = selected[source.id];
      if (source.kind !== 'video' && source.duration === null && !source.frameCount) {
        source = await inspectImage(source, true); clips = initializeClips(clips, source);
      }
      source = { ...source, title: validateOutputName(sourceName(source)) };
      for (const clip of clips) { items.push({ source, segment: prepareSegment(clip, source, settings.fps, settings.speed, format), settings, ...(format === 'video' ? { format } : {}) }); }
    }
    await rpc({ target: 'background', type: 'save-preferences', settings });
    await rpc({ target: 'background', type: 'enqueue', items }); await refreshJobs();
  }
  async function enableSite() {
    const page = sources[0]?.pageUrl;
    if (!page) throw new TaskError('pageUnavailable');
    const pattern = httpOrigin(page);
    if (!await chrome.permissions.request({ origins: [pattern] })) throw new TaskError('permissionRequired');
    const id = 'site-' + [...pattern].reduce((hash, char) => Math.imul(hash, 31) + char.charCodeAt(0) | 0, 0).toString(16).replace('-', 'n');
    const registrations: chrome.scripting.RegisteredContentScript[] = [
      { id, matches: [pattern], js: ['content.js'], runAt: 'document_start', allFrames: true, persistAcrossSessions: true },
      { id: `media-${id}`, matches: [pattern], js: ['page-observer.js'], world: 'MAIN', runAt: 'document_start', allFrames: true, persistAcrossSessions: true },
    ];
    const existing = await chrome.scripting.getRegisteredContentScripts();
    for (const registration of registrations) {
      if (existing.some(script => script.id === registration.id)) await chrome.scripting.updateContentScripts([registration]);
      else await chrome.scripting.registerContentScripts([registration]);
    }
    setNotice(t('siteEnabled'));
  }
  async function showPreview(job: Job) {
    const request = ++previewRequest.current;
    const blob = await getResult(job.id); if (!blob) throw new TaskError('resultUnavailable');
    if (request !== previewRequest.current) return;
    setPreview({ job, url: URL.createObjectURL(blob) });
  }
  function restoreJob(job: Job) {
    const source = allSources.find(s => s.id === job.source.id && s.documentKey === job.source.documentKey);
    if (!source) { setNotice(errorText('sourceGone')); return; }
    setSettings(job.settings); setSelected(previous => ({ ...previous, [source.id]: initializeClips([{ ...job.segment, id: crypto.randomUUID() }], source) }));
    setSourceNames(previous => ({ ...previous, [source.id]: jobName(job) }));
    setView('create');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  const shownJobs = view === 'create' ? jobs : history.filter(job => (historyFilter === 'all' || job.stage === historyFilter) &&
    `${jobName(job)} ${job.source.mediaPageUrl ?? job.source.pageUrl}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const shownProblems = view === 'history' && ['all', 'failed'].includes(historyFilter) ? historyProblems.filter(problem =>
    `${problem.title ?? ''} ${problem.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) : [];
  const resultCount = shownJobs.length + shownProblems.length;
  const ready = shownJobs.filter(hasResult);
  const readyRevision = ready.map(job => job.id).sort().join(',');
  const selectedReady = ready.filter(job => selectedJobs.has(job.id));
  useEffect(() => {
    // v0.1.10: selection follows task IDs, never row positions. Hidden, deleted or
    // cleared results leave the selection instead of being saved from another view.
    const available = new Set(ready.map(job => job.id));
    setSelectedJobs(previous => {
      const next = new Set([...previous].filter(id => available.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [readyRevision]);
  async function downloadMany(items: Job[]) {
    const selection = items.map(job => ({ id: job.id, title: jobName(job) }));
    const result = await rpc<DownloadBatchResult>({ target: 'background', type: 'download-many', items: selection });
    const started = new Set(result.started.map(item => item.id));
    setSelectedJobs(previous => new Set([...previous].filter(id => !started.has(id))));
    setNotice(result.failed.length
      ? t('batchSavePartial', [number(result.started.length, 0), number(result.failed.length, 0), result.failed.map(item => {
        const job = items.find(job => job.id === item.id)!;
        return t('saveItemFailed', [jobName(job).trim() || job.source.title, errorText(item.error)]);
      }).join('\n')])
      : t('downloadsStarted', number(result.started.length, 0)));
  }
  async function confirmCleanup() {
    const request = cleanup!; setCleanup(null);
    const result = await rpc<CacheSummary>({ target: 'background', type: request.kind === 'cache' ? 'clear-cache' : 'clear-history', ids: request.ids });
    await refreshJobs();
    setCache(await rpc<CacheSummary>({ target: 'background', type: 'cache-summary' }));
    setNotice(t(request.kind === 'cache' ? 'cacheCleared' : 'historyCleared', [number(result.ids.length, 0), number(result.bytes / 1_000_000)]));
  }
  return <main onDragOver={onFileDragOver} onDragLeave={onFileDragLeave} onDrop={onFileDrop}>
    <header className="brand"><div className="brand-icon"><span>G</span><i /></div><div><strong>Gif Toolkit<span className="version">{chrome.runtime.getManifest().version}</span></strong><p>{t('tagline')}</p></div><span className="local-badge"><i />{t('localBadge')}</span></header>
    <nav className="view-nav" aria-label={t('navigation')}><button aria-pressed={view === 'create'} onClick={() => setView('create')}>{t('createView')}</button>
      <button aria-pressed={view === 'history'} onClick={() => setView('history')}>{t('historyTitle')}<span>{history.length + historyProblems.length}</span></button></nav>
    {!!historyProblems.length && view === 'create' && <div className="notice"><span>{t('historyProblemsHint')}</span><button onClick={() => setView('history')}>{t('historyTitle')}</button></div>}
    {notice && <div role="alert" className="notice"><span>{notice}</span><button aria-label={t('closePreview')} onClick={() => setNotice(null)}>×</button></div>}
    <div hidden={view !== 'create'}>
    <section className="intro"><div><h1>{t('sourcesTitle')}</h1><p>{t('sourcesHint')}</p></div><button className="icon-button refresh" disabled={!!busy} onClick={() => void perform(async () => { acceptSources(await rpc<MediaSource[]>({ target: 'background', type: 'scan' })); }, 'scan')} aria-label={t('refresh')} title={t('refresh')}>↻</button></section>
    <input ref={fileInput} type="file" accept="video/*" multiple hidden onChange={event => void perform(() => importLocalFiles(event.target.files), 'local-import')} />
    <button type="button" className={`local-import ${draggingFiles ? 'drag-over' : ''}`} disabled={!!busy} onClick={() => fileInput.current?.click()} onDragOver={onFileDragOver} onDragLeave={onFileDragLeave} onDrop={onFileDrop}>
      <span className="local-import-icon" aria-hidden="true">↑</span>
      <span className="local-import-body">
        <span className="local-import-text">{t('importLocalVideos')}</span>
        <span className="local-import-meta">{t('importLocalVideosHint')}</span>
      </span>
      <span className="local-import-plus" aria-hidden="true">＋</span>
    </button>
    {recordingState.stage === 'idle' ? (
      <button type="button" className="region-record" disabled={!!busy} onClick={() => void perform(startRegionRecord, 'record')}>
        <span className="region-record-icon" aria-hidden="true">⊡</span>
        <span className="local-import-body">
          <span className="local-import-text">{t('recordRegion')}</span>
          <span className="local-import-meta">{t('recordRegionHint')}</span>
        </span>
        <span className="region-record-dot" aria-hidden="true">●</span>
      </button>
    ) : (
      <div className={`region-record-card ${recordingState.stage}`} data-stage={recordingState.stage} role="region" aria-label={t('recordRegion')}>
        <div className="region-record-status">
          {recordingState.stage === 'recording' && <i className="rec-pulse" aria-hidden="true" />}
          <strong>
            {recordingState.stage === 'selecting' && t('recordStatusSelecting')}
            {recordingState.stage === 'selected' && recordingState.region && t('recordStatusSelected', [String(Math.round(recordingState.region.width)), String(Math.round(recordingState.region.height))])}
            {recordingState.stage === 'recording' && recordingState.region && t('recordStatusRecording', [String(Math.round(recordingState.region.width)), String(Math.round(recordingState.region.height)), recordingElapsed])}
            {(recordingState.stage === 'starting' || recordingState.stage === 'stopping') && t('recordStatusStopping')}
          </strong>
        </div>
        <div className="region-record-actions">
          {recordingState.stage === 'selected' && <>
            <button type="button" className="save" disabled={!!busy} onClick={() => void perform(beginSelectedRegionRecord, 'record')}>{t('recordStart')}</button>
            <button type="button" disabled={!!busy} onClick={() => void perform(startRegionRecord, 'record')}>{t('recordReselect')}</button>
          </>}
          {recordingState.stage === 'recording' && <>
            <button type="button" className="save" disabled={!!busy} onClick={() => void perform(() => finishRegionRecord('video'), 'record')}>{t('recordSaveVideo')}</button>
            <button type="button" className="save primary-gif" disabled={!!busy} onClick={() => void perform(() => finishRegionRecord('gif'), 'record')}>{t('recordSaveGif')}</button>
          </>}
          <button type="button" disabled={!!busy} onClick={() => void perform(cancelRegionRecord, 'record')}>{t('cancel')}</button>
        </div>
      </div>
    )}
    {missingFrameOrigins.length > 0 && <div className="notice"><span>{t('embeddedMediaHint', missingFrameOrigins.map(origin => new URL(origin).host).join(', '))}</span><button onClick={() => void perform(async () => {
      if (!await chrome.permissions.request({ origins: missingFrameOrigins })) throw new TaskError('permissionRequired');
      acceptSources(await rpc<MediaSource[]>({ target: 'background', type: 'scan', tabId: sourceTab.current }));
    })}>{t('enableEmbeddedMedia')}</button></div>}
    {!sources.length && !localSources.length ? <div className="empty"><div className="empty-art"><span>▶</span><i>GIF</i></div><h2>{busy === 'scan' ? t('scanning') : t('emptyTitle')}</h2><p>{t('emptyHint')}</p></div> : <>
      <div className="source-list">{allSources.map(source => {
        const local = isLocalSource(source);
        return <div key={source.id} className={`source ${selected[source.id] ? 'selected' : ''}`}>
          <button type="button" className="source-select" disabled={!!busy} aria-pressed={!!selected[source.id]} onClick={() => void perform(() => toggle(source), source.id)}>
            <div className="thumbnail">{source.poster ? <img src={source.poster} alt="" referrerPolicy="no-referrer" /> : <span>▶</span>}<small>{t(local ? 'sourceLocalVideo' : (source.kind === 'video' ? 'sourceVideo' : source.kind === 'gif' ? 'sourceGif' : source.kind === 'image' ? 'sourceImage' : 'sourceWebp'))}</small></div>
            <div className="source-text"><strong>{sourceName(source)}</strong><p>{source.width ? `${source.width} × ${source.height}` : '—'}<span>·</span>{busy === source.id ? t('loadingImage') : time(source.duration)}</p></div><span className="checkbox">{selected[source.id] ? '✓' : ''}</span>
          </button>
          {local && <button type="button" className="source-remove" disabled={!!busy} aria-label={t('removeLocalImport')} title={t('removeLocalImport')} onClick={() => void perform(() => removeLocal(source), source.id)}>×</button>}
        </div>;
      })}</div>
      {!!localSources.length && <button type="button" className="text-button clear-local" disabled={!!busy} onClick={() => void perform(clearLocalSources, 'local-remove')}>{t('clearLocalVideos')}</button>}
      {!!sources.length && <><button className="site-link" onClick={() => void perform(enableSite)}>{t('enableSite')} <span>↗</span></button>
      <p className="fine-print">{t('contextMenuHint')}</p></>}
    </>}
    {chosen.length > 0 && <>
      <section className="card clips"><div className="section-title"><h2>{t('clipsTitle')}</h2><span className="count-badge">{clipCount.toString().padStart(2, '0')}</span></div>
        <div className="speed-control">
          <label className="speed-label" htmlFor="playback-speed">{t('speed')}</label>
          <div className="with-unit speed-value"><input id="playback-speed" type="number" min={POLICY.minSpeed} max={POLICY.maxSpeed} step="any" disabled={!settingsReady}
            value={Number.isFinite(settings.speed) ? settings.speed : ''} onChange={event => setSettings(previous => ({ ...previous, speed: event.target.valueAsNumber }))} /><span>{t('speedUnit')}</span></div>
          <div className="speed-presets" role="group" aria-label={t('speedPresets')}>{[0.5, 1, 1.5, 2, 3].map(speed =>
            <button key={speed} disabled={!settingsReady} aria-pressed={settings.speed === speed} onClick={() => setSettings(previous => ({ ...previous, speed }))}>{number(speed)}{t('speedUnit')}</button>)}</div>
          <p className="speed-hint">{t('speedHint')}</p>
        </div>
        {chosen.map(source => <div className="clip-group" key={source.id}>
          <div className="clip-source"><strong title={sourceName(source)}>{sourceName(source)}</strong><span>{isLocalSource(source) && <button className="text-button" disabled={!!busy} onClick={() => void perform(() => removeLocal(source), source.id)}>{t('removeLocalImport')}</button>}<button className="text-button" disabled={!!busy || source.duration === null} onClick={() => setSelected(previous => ({ ...previous, [source.id]: [...previous[source.id], defaultSegment(source)] }))}>+ {t('addClip')}</button></span></div>
          {source.kind === 'video' && !source.youtubeVideoId && ((source.resources?.length ?? 0) > 1 || source.resourceSelectionRequired) && source.url.startsWith('blob:') && <label>{t('mediaResource')}<select value={source.resource?.url ?? ''} onChange={event => setSources(previous => previous.map(item => item.id === source.id ? { ...item, resource: item.resources?.find(resource => resource.url === event.target.value) } : item))}>
            <option value="">{t('chooseMediaResource')}</option>{source.resources!.map(resource => <option key={resource.url} value={resource.url}>{new URL(resource.url).host}{new URL(resource.url).pathname}</option>)}
          </select><span className="fine-print">{t('mediaResourceHint')}</span></label>}
          <label className="output-name">{t('outputName')}<input type="text" maxLength={200} value={sourceName(source)} onChange={event => setSourceNames(previous => ({ ...previous, [source.id]: event.target.value }))} /></label>
          <p className="name-hint">{t('outputNameHint')}</p>
          {source.kind !== 'video' && !source.frameCount && <button className="text-button" disabled={!!busy} onClick={() => void perform(async () => { await inspectImage(source); }, source.id)}>{busy === source.id ? t('loadingImage') : t('readAnimation')}</button>}
          {source.duration === null ? <p className="fine-print">{t(source.frameCount === 1 ? 'staticImage' : source.kind === 'video' ? 'unknownDuration' : 'animationDurationHint')}</p> : selected[source.id].map((segment, i) => <div className="clip" key={segment.id}>
            <div className="clip-caption"><span className="clip-index">{String(i + 1).padStart(2, '0')}</span><strong>{time(segment.start)} <span>→</span> {time(segment.end)}</strong><small>{t('clipDuration', number(segment.end - segment.start))}</small><button className="remove" aria-label={t('removeClip')} onClick={() => setSelected(previous => ({ ...previous, [source.id]: previous[source.id].filter(s => s.id !== segment.id) }))}>×</button></div>
            <div className="range-track"><div style={{ left: `${100 * segment.start / (source.duration || segment.end)}%`, right: `${100 * (1 - segment.end / (source.duration || segment.end))}%` }} /></div>
            <div className="ranges"><input aria-label={t('start')} type="range" min={0} max={Math.max(0, segment.end - 0.01)} step={0.01} value={segment.start} onChange={event => changeClip(source.id, segment.id, { start: Number(event.target.value) })} /><input aria-label={t('end')} type="range" min={segment.start + 0.01} max={source.duration || Math.max(segment.end, 60)} step={0.01} value={segment.end} onChange={event => changeClip(source.id, segment.id, { end: Number(event.target.value) })} /></div>
            <div className="clip-inputs"><label>{t('start')}<input type="number" min={0} step={0.01} value={Number.isFinite(segment.start) ? segment.start : ''} onChange={event => changeClip(source.id, segment.id, { start: event.target.valueAsNumber })} /></label><label>{t('end')}<input type="number" min={0} step={0.01} value={Number.isFinite(segment.end) ? segment.end : ''} onChange={event => changeClip(source.id, segment.id, { end: event.target.valueAsNumber })} /></label></div>
            <p className="clip-output">{Number.isFinite(settings.speed) && settings.speed > 0 ? t('outputDuration', [number(outputDuration(segment, settings.speed)), number(settings.speed)]) : '—'}</p>
          </div>)}
        </div>)}
      </section>
      <section className="card settings"><div className="section-title"><h2>{t('settingsTitle')}</h2><span className="section-mark">↘</span></div>
        <div className="presets">{[1, 2, 4].map(size => <button className={settings.maxBytes === size * 1_000_000 ? 'active' : ''} key={size} onClick={() => setSettings(previous => ({ ...previous, maxBytes: size * 1_000_000 }))}>{size} MB</button>)}</div>
        <div className="settings-fields">{([
          ['maxBytes', 'sizeLimit', 'mbUnit', 1_000_000, 0.1, 0.001024, 134.217728],
          ['maxSide', 'maxSide', 'pxUnit', 1, 1, 16, POLICY.maxSide],
          ['fps', 'fps', 'fpsUnit', 1, 1, 1, 30]
        ] as const).map(([key, label, unit, divisor, step, min, max]) => <label key={key}>{t(label)}<div className="with-unit"><input type="number" disabled={!settingsReady} value={Number.isFinite(settings[key]) ? settings[key] / divisor : ''} min={min} max={max} step={step} onChange={event => setSettings(previous => ({ ...previous, [key]: event.target.valueAsNumber * divisor }))} /><span>{t(unit)}</span></div></label>)}</div>
        <label className="drop-frames" htmlFor="drop-frames">{t('dropFrames')}
          <select id="drop-frames" disabled={!settingsReady} value={settings.dropFrames} aria-describedby="drop-frames-hint"
            onChange={event => setSettings(previous => ({ ...previous, dropFrames: event.target.value as DropFrames }))}>
            {DROP_FRAME_MODES.map(mode => <option key={mode} value={mode}>{t(dropFrameLabels[mode])}</option>)}
          </select>
        </label>
        <p id="drop-frames-hint" className="fine-print">{t('dropFramesHint')}</p>
        <p className="fine-print">{t('settingsHint')}</p>
      </section>
      {chosen.some(s => s.kind === 'video' && !isLocalSource(s)) && <p className="player-notice"><span>ⓘ</span>{t('playerNotice')}</p>}
      <div className="generate-actions">
        <button className="generate" disabled={!settingsReady || !!busy || !clipCount || chosen.some(s => s.kind === 'video' && s.duration === null)} onClick={() => void perform(() => generate('gif'), 'generate')}><span aria-hidden="true">✦</span>{busy === 'generate' ? t('submitting') : clipCount === 1 ? t('generateOne') : t('generate', String(clipCount))}<span aria-hidden="true">→</span></button>
        <button className="generate-video" disabled={!settingsReady || !!busy || !clipCount || chosen.some(s => s.kind === 'video' && s.duration === null)} onClick={() => void perform(() => generate('video'), 'generate-video')}><span aria-hidden="true">▶</span>{busy === 'generate-video' ? t('submitting') : clipCount === 1 ? t('generateVideoOne') : t('generateVideo', String(clipCount))}<span aria-hidden="true">↓</span></button>
      </div>
    </>}
    </div>
    {view === 'history' && <section className="history-tools">
      <div className="intro"><div><h1>{t('historyTitle')}</h1><p>{t('historyHint', String(POLICY.historyCount))}</p></div></div>
      <div className="storage-card"><div><h2>{t('cacheTitle')}</h2><strong>{cache ? t('cacheUsage', [number(cache.bytes / 1_000_000), number(cache.ids.length, 0)]) : '—'}</strong></div>
        <button className="secondary-button" disabled={!!busy || !cache?.ids.length} onClick={() => void perform(async () => {
          const snapshot = await rpc<CacheSummary>({ target: 'background', type: 'cache-summary' });
          setCache(snapshot); if (snapshot.ids.length) setCleanup({ kind: 'cache', ...snapshot });
        }, 'cache-summary')}>{t('clearCache')}</button><p>{t('cacheHint')}</p></div>
      <div className="history-filters"><label>{t('historySearch')}<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('historySearchHint')} /></label>
        <label>{t('historyStatus')}<select value={historyFilter} onChange={event => setHistoryFilter(event.target.value)}>
          <option value="all">{t('historyAll')}</option>{(['completed', 'failed', 'cancelled'] as const).map(stage => <option key={stage} value={stage}>{stageText(stage)}</option>)}
        </select></label></div>
      <div className="history-actions"><span>{t('historyCount', number(resultCount, 0))}</span><button disabled={!!busy || !(history.length + historyProblems.length)} onClick={() => setCleanup({ kind: 'history', ids: [...history.map(job => job.id), ...historyProblems.map(problem => problem.id)], bytes: cache?.bytes ?? 0 })}>{t('clearHistory')}</button></div>
    </section>}
    <section className="results"><div className="section-title"><h2 id="results-heading">{t(view === 'history' ? 'historyResults' : 'tasksTitle')}<span className="result-count">{resultCount}</span></h2>{ready.length > 1 && <button className="text-button" disabled={!!busy} onClick={() => void perform(() => downloadMany(ready), 'download-many')}>{t('downloadAll')}</button>}</div>{view === 'create' && <p className="fine-print">{t('tasksHint')}</p>}
      {!!ready.length && <div className="result-selection" role="group" aria-label={t('resultSelection')}>
        <button className="text-button" disabled={!!busy} onClick={() => setSelectedJobs(selectedReady.length === ready.length ? new Set() : new Set(ready.map(job => job.id)))}>{t(selectedReady.length === ready.length ? 'clearSelection' : 'selectAllResults')}</button>
        <span aria-live="polite">{t('selectedResults', number(selectedReady.length, 0))}</span>
        <button className="save" disabled={!!busy || !selectedReady.length} onClick={() => void perform(() => downloadMany(selectedReady), 'download-many')}>{t(busy === 'download-many' ? 'savingResults' : 'downloadSelected')}</button>
      </div>}
      <div className="result-list" role="region" aria-labelledby="results-heading" tabIndex={0}>
      {!resultCount && <div className="tasks-empty">{t(view === 'history' ? history.length + historyProblems.length ? 'historyNoMatches' : 'historyEmpty' : 'tasksEmpty')}</div>}
      {shownProblems.map(problem => <article key={problem.id} className="job failed" data-history-problem={problem.id}>
        <strong>{problem.title || t('invalidHistoryTitle')}</strong><p className="job-error">{errorText('invalidHistory')}</p>
        {problem.createdAt !== undefined && <p className="fine-print">{dateTime(problem.createdAt)}</p>}
        <div className="job-actions"><button disabled={!!busy} className="delete" onClick={() => void perform(async () => {
          await rpc({ target: 'background', type: 'delete', id: problem.id }); await refreshJobs();
        }, 'delete')}>{t('delete')}</button></div>
      </article>)}
      {shownJobs.map(job => <article key={job.id} className={`job ${job.stage}`} data-job-id={job.id} data-stage={job.stage} data-format={job.format ?? 'gif'}>
        <div className="job-top">{hasResult(job) ? <input className="job-select" type="checkbox" aria-label={t('selectResult', jobName(job))} checked={selectedJobs.has(job.id)} disabled={!!busy} onChange={event => {
          const checked = event.target.checked;
          setSelectedJobs(previous => { const next = new Set(previous); if (checked) next.add(job.id); else next.delete(job.id); return next; });
        }} /> : <span className="job-symbol">{job.stage === 'completed' ? '✓' : job.stage === 'failed' ? '!' : '◷'}</span>}<div><strong title={jobName(job)}>{jobName(job)}</strong><p>{time(job.segment.start)}–{time(job.segment.end)} · {number(job.settings.speed)}{t('speedUnit')}</p></div><span className="job-status">{job.result?.clearedAt !== undefined ? t('fileCleared') : stageText(job.stage)}</span></div>
        {view === 'history' && <div className="history-origin"><time dateTime={new Date(job.createdAt).toISOString()}>{dateTime(job.createdAt)}</time><a href={job.source.mediaPageUrl ?? job.source.pageUrl} target="_blank" rel="noreferrer">{t('openSource')} ↗</a></div>}
        {!isTerminal(job.stage) && <><progress max={1} value={job.progress} /><div className="progress-detail"><span>{job.attempt ? t('attempt', String(job.attempt)) : stageText(job.stage)}</span><span>{Math.round(job.progress * 100)}%</span></div></>}
        {job.result && <div className="result-meta"><b className={`format-badge ${job.format === 'video' ? 'video' : 'gif'}`}>{t(job.format === 'video' ? 'formatVideo' : 'formatGif')}</b><b>{number(job.result.bytes / 1_000_000)} MB</b><span>{job.result.width} × {job.result.height}</span><span>{t('clipDuration', number(job.result.duration))}</span></div>}
        {hasResult(job) && <><label className="output-name">{t('outputName')}<input type="text" maxLength={200} value={jobName(job)} onChange={event => setJobNames(previous => ({ ...previous, [job.id]: event.target.value }))} /></label><p className="filename-preview">{makeFilename(job, jobName(job))}</p></>}
        {job.result?.clearedAt !== undefined && <p className="fine-print cleared-note">{t('fileClearedHint')}</p>}
        {job.error && job.stage !== 'cancelled' && <p className="job-error">{errorText(job.error)}</p>}
        <div className="job-actions">{hasResult(job) && <><button className="save" disabled={!!busy} onClick={() => void perform(() => download(job, true), 'download')}>↓ {t(job.format === 'video' ? 'downloadVideo' : 'download')}</button><button onClick={() => void perform(() => showPreview(job))}>{t(job.format === 'video' ? 'previewVideo' : 'preview')}</button></>}
          {!isTerminal(job.stage) ? <button onClick={() => void perform(async () => { await rpc({ target: 'background', type: 'cancel', id: job.id }); await refreshJobs(); })}>{t('cancel')}</button> : <><button onClick={() => restoreJob(job)}>{t('editAgain')}</button><button className="delete" aria-label={t('delete')} title={t('delete')} onClick={() => void perform(async () => { await rpc({ target: 'background', type: 'delete', id: job.id }); await refreshJobs(); })}>×</button></>}
        </div>
      </article>)}
      </div>
    </section>
    <footer>{t('footer')}</footer>
    {cleanup && <CleanupDialog request={cleanup} onCancel={() => setCleanup(null)} onConfirm={() => void perform(confirmCleanup, 'cleanup')} />}
    {preview && <div className="modal-backdrop" onClick={() => setPreview(null)}><section className="preview-modal" role="dialog" aria-modal="true" aria-label={t(preview.job.format === 'video' ? 'previewVideo' : 'preview')} onClick={event => event.stopPropagation()}><button className="preview-close" onClick={() => setPreview(null)} aria-label={t('closePreview')}>×</button><div className="checker">{preview.job.format === 'video' ? <video src={preview.url} controls autoPlay loop playsInline width={preview.job.result?.width} height={preview.job.result?.height} /> : <img src={preview.url} alt={jobName(preview.job)} />}</div><p>{preview.job.result?.width} × {preview.job.result?.height} · {number((preview.job.result?.bytes ?? 0) / 1_000_000)} MB</p><button className="save" disabled={!!busy} onClick={() => void perform(() => download(preview.job, true), 'download')}>{t(preview.job.format === 'video' ? 'downloadVideo' : 'download')}</button></section></div>}
  </main>;
}
document.documentElement.lang = chrome.i18n.getUILanguage();
createRoot(document.getElementById('root')!).render(<App />);
