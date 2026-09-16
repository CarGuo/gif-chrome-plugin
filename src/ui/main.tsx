import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { defaultSegment, DEFAULT_SETTINGS, DROP_FRAME_MODES, errorCode, httpOrigin, isTerminal, outputDuration, POLICY, rpc, TaskError, validateOutputName, validateSegment, validateSettings, type DropFrames, type ExportSettings, type Job, type MediaSource, type Segment } from '../shared/model';
import { makeFilename } from '../shared/filename';
import { imageOrigins, initializeClips, withImageMetadata } from '../shared/sources';
import { getResult } from '../shared/storage';
import { errorText, number, stageText, t, time, type TextKey } from './i18n';
import './style.css';

const dropFrameLabels: Record<DropFrames, TextKey> = { none: 'dropFramesOff', duplicates: 'dropFramesDuplicates', every2: 'dropFramesEvery2', every3: 'dropFramesEvery3', every4: 'dropFramesEvery4' };

function App() {
  const [sources, setSources] = useState<MediaSource[]>([]);
  const [sourceNames, setSourceNames] = useState<Record<string, string>>({});
  const [jobNames, setJobNames] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, Segment[]>>({});
  const [settings, setSettings] = useState<ExportSettings>(DEFAULT_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; job: Job } | null>(null);
  const sourceTab = useRef<number | undefined>(undefined);

  function acceptSources(next: MediaSource[]) {
    setSources(next); sourceTab.current = next[0]?.tabId ?? sourceTab.current;
    setSelected(previous => Object.fromEntries(next.filter(s => previous[s.id] || s.selected || next.length === 1).map(s => [s.id,
      initializeClips(previous[s.id], s)])));
  }
  async function refreshJobs() { setJobs(await rpc<Job[]>({ target: 'background', type: 'list' })); }
  useEffect(() => {
    void rpc<ExportSettings>({ target: 'background', type: 'load-preferences' }).then(values => {
      setSettings(values); setSettingsReady(true);
    }).catch(error => setNotice(errorText(errorCode(error))));
    void chrome.storage.session.get(['sources', 'activeTabId']).then(data => { sourceTab.current = data.activeTabId; acceptSources(data.sources ?? []); });
    void refreshJobs().catch(error => setNotice(errorText(errorCode(error))));
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes.sources) acceptSources(changes.sources.newValue ?? []);
      if (area === 'session' && changes.scanError?.newValue) setNotice(errorText(changes.scanError.newValue));
    };
    const onMessage = (message: { type: 'job-updated'; job: Job } | { type: 'jobs-removed'; ids: string[] }) => {
      if (message.type === 'job-updated') setJobs(previous => [message.job, ...previous.filter(j => j.id !== message.job.id)].sort((a, b) => b.createdAt - a.createdAt));
      if (message.type === 'jobs-removed') {
        setJobs(previous => previous.filter(job => !message.ids.includes(job.id)));
        setPreview(previous => previous && message.ids.includes(previous.job.id) ? null : previous);
      }
    };
    chrome.storage.onChanged.addListener(onStorage); chrome.runtime.onMessage.addListener(onMessage);
    return () => { chrome.storage.onChanged.removeListener(onStorage); chrome.runtime.onMessage.removeListener(onMessage); };
  }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  async function perform(action: () => Promise<void>, busyId: string | null = null) {
    setNotice(null); if (busyId) setBusy(busyId);
    try { await action(); } catch (error) { setNotice(errorText(errorCode(error))); }
    finally { if (busyId) setBusy(null); }
  }
  async function requestImageAccess(items: MediaSource[]) {
    const origins = imageOrigins(items);
    if (origins.length) {
      const granted = await chrome.permissions.request({ origins });
      if (!granted) throw new TaskError('permissionRequired');
    }
  }
  async function inspectImage(source: MediaSource, authorized = false) {
    if (!authorized) await requestImageAccess([source]);
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
    setSelected(previous => ({ ...previous, [sourceId]: previous[sourceId].map(s => s.id === id ? { ...s, ...patch } : s) }));
  }
  const chosen = sources.filter(s => selected[s.id]);
  const sourceName = (source: MediaSource) => sourceNames[source.id] ?? source.title;
  const jobName = (job: Job) => jobNames[job.id] ?? job.source.title;
  async function download(job: Job, saveAs: boolean) {
    await rpc({ target: 'background', type: 'download', id: job.id, title: validateOutputName(jobName(job)), saveAs });
  }
  const clipCount = chosen.reduce((count, source) => count + selected[source.id].length, 0);
  async function generate() {
    validateSettings(settings);
    for (const source of chosen) validateOutputName(sourceName(source));
    // v0.1.4: request every selected image origin within the click gesture, before any decode awaits.
    await requestImageAccess(chosen);
    const items: { source: MediaSource; segment: Segment; settings: ExportSettings }[] = [];
    for (let source of chosen) {
      let clips = selected[source.id];
      if (source.kind !== 'video' && source.duration === null && !source.frameCount) {
        source = await inspectImage(source, true); clips = initializeClips(clips, source);
      }
      source = { ...source, title: validateOutputName(sourceName(source)) };
      for (const segment of clips) { validateSegment(segment, source.duration, settings.fps, settings.speed); items.push({ source, segment, settings }); }
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
    const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    // v0.1.1: registration must precede player contextmenu listeners on future page loads.
    const registration: chrome.scripting.RegisteredContentScript = { id, matches: [pattern], js: ['content.js'], runAt: 'document_start', allFrames: true, persistAcrossSessions: true };
    if (!scripts.length) await chrome.scripting.registerContentScripts([registration]);
    else await chrome.scripting.updateContentScripts([registration]);
    setNotice(t('siteEnabled'));
  }
  async function showPreview(job: Job) {
    const blob = await getResult(job.id); if (!blob) throw new TaskError('invalidOutput');
    setPreview({ job, url: URL.createObjectURL(blob) });
  }
  function restoreJob(job: Job) {
    const source = sources.find(s => s.id === job.source.id && s.documentKey === job.source.documentKey);
    if (!source) { setNotice(errorText('sourceGone')); return; }
    setSettings(job.settings); setSelected(previous => ({ ...previous, [source.id]: [{ ...job.segment, id: crypto.randomUUID() }] }));
    setSourceNames(previous => ({ ...previous, [source.id]: jobName(job) }));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  const ready = jobs.filter(j => j.stage === 'completed');
  return <main>
    <header className="brand"><div className="brand-icon"><span>G</span><i /></div><div><strong>Gif Toolkit<span className="version">{chrome.runtime.getManifest().version}</span></strong><p>{t('tagline')}</p></div><span className="local-badge"><i />{t('localBadge')}</span></header>
    <section className="intro"><div><h1>{t('sourcesTitle')}</h1><p>{t('sourcesHint')}</p></div><button className="icon-button refresh" disabled={!!busy} onClick={() => void perform(async () => { acceptSources(await rpc<MediaSource[]>({ target: 'background', type: 'scan' })); }, 'scan')} aria-label={t('refresh')} title={t('refresh')}>↻</button></section>
    {notice && <div role="alert" className="notice"><span>{notice}</span><button aria-label={t('closePreview')} onClick={() => setNotice(null)}>×</button></div>}
    {!sources.length ? <div className="empty"><div className="empty-art"><span>▶</span><i>GIF</i></div><h2>{busy === 'scan' ? t('scanning') : t('emptyTitle')}</h2><p>{t('emptyHint')}</p></div> : <>
      <div className="source-list">{sources.map(source => <button key={source.id} className={`source ${selected[source.id] ? 'selected' : ''}`} onClick={() => void perform(() => toggle(source), source.id)} disabled={!!busy} aria-pressed={!!selected[source.id]}>
        <div className="thumbnail">{source.poster ? <img src={source.poster} alt="" referrerPolicy="no-referrer" /> : <span>▶</span>}<small>{t((source.kind === 'video' ? 'sourceVideo' : source.kind === 'gif' ? 'sourceGif' : source.kind === 'image' ? 'sourceImage' : 'sourceWebp'))}</small></div>
        <div className="source-text"><strong>{sourceName(source)}</strong><p>{source.width ? `${source.width} × ${source.height}` : '—'}<span>·</span>{busy === source.id ? t('loadingImage') : time(source.duration)}</p></div><span className="checkbox">{selected[source.id] ? '✓' : ''}</span>
      </button>)}</div>
      <button className="site-link" onClick={() => void perform(enableSite)}>{t('enableSite')} <span>↗</span></button>
      <p className="fine-print">{t('contextMenuHint')}</p>
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
          <div className="clip-source"><strong title={sourceName(source)}>{sourceName(source)}</strong><button className="text-button" disabled={!!busy || source.duration === null} onClick={() => setSelected(previous => ({ ...previous, [source.id]: [...previous[source.id], defaultSegment(source)] }))}>+ {t('addClip')}</button></div>
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
      {chosen.some(s => s.kind === 'video') && <p className="player-notice"><span>ⓘ</span>{t('playerNotice')}</p>}
      <button className="generate" disabled={!settingsReady || !!busy || !clipCount || chosen.some(s => s.kind === 'video' && s.duration === null)} onClick={() => void perform(generate, 'generate')}><span aria-hidden="true">✦</span>{busy === 'generate' ? t('submitting') : clipCount === 1 ? t('generateOne') : t('generate', String(clipCount))}<span aria-hidden="true">→</span></button>
    </>}
    <section className="results"><div className="section-title"><h2>{t('tasksTitle')}<span className="result-count">{jobs.length}</span></h2>{ready.length > 1 && <button className="text-button" onClick={() => void perform(async () => { for (const job of ready) await download(job, false); })}>{t('downloadAll')}</button>}</div><p className="fine-print">{t('tasksHint')}</p>
      {!jobs.length && <div className="tasks-empty">{t('tasksEmpty')}</div>}
      {jobs.map(job => <article key={job.id} className={`job ${job.stage}`} data-job-id={job.id} data-stage={job.stage}>
        <div className="job-top"><span className="job-symbol">{job.stage === 'completed' ? '✓' : job.stage === 'failed' ? '!' : '◷'}</span><div><strong>{jobName(job)}</strong><p>{time(job.segment.start)}–{time(job.segment.end)} · {number(job.settings.speed)}{t('speedUnit')}</p></div><span className="job-status">{stageText(job.stage)}</span></div>
        {!isTerminal(job.stage) && <><progress max={1} value={job.progress} /><div className="progress-detail"><span>{job.attempt ? t('attempt', String(job.attempt)) : stageText(job.stage)}</span><span>{Math.round(job.progress * 100)}%</span></div></>}
        {job.result && <div className="result-meta"><b>{number(job.result.bytes / 1_000_000)} MB</b><span>{job.result.width} × {job.result.height}</span><span>{t('clipDuration', number(job.result.duration))}</span></div>}
        {job.stage === 'completed' && <><label className="output-name">{t('outputName')}<input type="text" maxLength={200} value={jobName(job)} onChange={event => setJobNames(previous => ({ ...previous, [job.id]: event.target.value }))} /></label><p className="filename-preview">{makeFilename(job, jobName(job))}</p></>}
        {job.error && job.stage !== 'cancelled' && <p className="job-error">{errorText(job.error)}</p>}
        <div className="job-actions">{job.stage === 'completed' && <><button className="save" onClick={() => void perform(() => download(job, true))}>↓ {t('download')}</button><button onClick={() => void perform(() => showPreview(job))}>{t('preview')}</button></>}
          {!isTerminal(job.stage) ? <button onClick={() => void perform(async () => { await rpc({ target: 'background', type: 'cancel', id: job.id }); await refreshJobs(); })}>{t('cancel')}</button> : <><button onClick={() => restoreJob(job)}>{t('editAgain')}</button><button className="delete" aria-label={t('delete')} title={t('delete')} onClick={() => void perform(async () => { await rpc({ target: 'background', type: 'delete', id: job.id }); await refreshJobs(); })}>×</button></>}
        </div>
      </article>)}
    </section>
    <footer>{t('footer')}</footer>
    {preview && <div className="modal-backdrop" onClick={() => setPreview(null)}><section className="preview-modal" role="dialog" aria-modal="true" aria-label={t('preview')} onClick={event => event.stopPropagation()}><button className="preview-close" onClick={() => setPreview(null)} aria-label={t('closePreview')}>×</button><div className="checker"><img src={preview.url} alt={jobName(preview.job)} /></div><p>{preview.job.result?.width} × {preview.job.result?.height} · {number((preview.job.result?.bytes ?? 0) / 1_000_000)} MB</p><button className="save" onClick={() => void perform(() => download(preview.job, true))}>{t('download')}</button></section></div>}
  </main>;
}
document.documentElement.lang = chrome.i18n.getUILanguage();
createRoot(document.getElementById('root')!).render(<App />);
