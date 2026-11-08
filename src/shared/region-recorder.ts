import { fitDimensions, POLICY, TaskError, type ExportFormat, type RecordingState, type RegionRect, type Reply } from './model';

export interface ActiveStreamRecorder {
  stop: () => Promise<Blob>;
  cancel: () => void;
}

export function clampRegion(region: Partial<RegionRect>, viewportWidth = window.innerWidth, viewportHeight = window.innerHeight): RegionRect {
  const vw = Math.max(64, Math.round(viewportWidth));
  const vh = Math.max(64, Math.round(viewportHeight));
  const width = Math.max(24, Math.min(vw, Math.round(region.width ?? Math.min(480, vw - 40))));
  const height = Math.max(24, Math.min(vh, Math.round(region.height ?? Math.min(320, vh - 80))));
  const x = Math.max(0, Math.min(vw - width, Math.round(region.x ?? Math.floor((vw - width) / 2))));
  const y = Math.max(0, Math.min(vh - height, Math.round(region.y ?? Math.floor((vh - height) / 2))));
  return { x, y, width, height, viewportWidth: vw, viewportHeight: vh };
}

export async function createStreamRegionRecorder(stream: MediaStream, initialRegion: RegionRect, onTrackEnded?: () => void): Promise<ActiveStreamRecorder> {
  const video = document.createElement('video');
  video.dataset.gifToolkitIgnore = 'true';
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  const [videoTrack] = stream.getVideoTracks();
  let canvasStream: MediaStream | undefined;
  let recorder: MediaRecorder | undefined;
  let timer: number | undefined;
  let finished = false;
  let stopping = false;
  let cleaned = false;
  const chunks: Blob[] = [];
  let resolveResult!: (blob: Blob) => void;
  let rejectResult!: (error: TaskError) => void;
  const result = new Promise<Blob>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // v0.1.14: the recorder owns every resource from acquisition through finalization.
  // A track ending or setup failing must release frames even when no caller can stop it.
  void result.catch(() => {});
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (timer !== undefined) window.clearInterval(timer);
    videoTrack?.removeEventListener('ended', onEnded);
    canvasStream?.getTracks().forEach(track => track.stop());
    stream.getTracks().forEach(track => track.stop());
    video.srcObject = null;
  };
  const fail = (error: TaskError, notify = false) => {
    if (finished) return;
    finished = true;
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch {}
    cleanup();
    chunks.length = 0;
    rejectResult(error);
    if (notify) onTrackEnded?.();
  };
  const onEnded = () => fail(new TaskError('cancelled'), true);
  try {
    if (!videoTrack || videoTrack.readyState === 'ended') throw new TaskError('sourceNotReady');
    videoTrack.addEventListener('ended', onEnded, { once: true });
    await video.play().catch(() => { throw new TaskError('sourceNotReady'); });
    if (finished) throw new TaskError('cancelled');
    const region = clampRegion(initialRegion, initialRegion.viewportWidth, initialRegion.viewportHeight);
    const canvas = document.createElement('canvas');
    // v0.1.14: cap the long axis once, then align AVC dimensions; independent caps stretch wide/tall regions.
    const fitted = fitDimensions(region.width, region.height, POLICY.maxSide);
    canvas.width = Math.max(2, Math.floor(fitted.width / 2) * 2);
    canvas.height = Math.max(2, Math.floor(fitted.height / 2) * 2);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new TaskError('encodingFailed');
    const drawFrame = () => {
      const vw = video.videoWidth || region.viewportWidth;
      const vh = video.videoHeight || region.viewportHeight;
      const scaleX = vw / Math.max(1, region.viewportWidth);
      const scaleY = vh / Math.max(1, region.viewportHeight);
      const sx = Math.max(0, Math.min(vw - 2, region.x * scaleX));
      const sy = Math.max(0, Math.min(vh - 2, region.y * scaleY));
      const sw = Math.max(2, Math.min(vw - sx, region.width * scaleX));
      const sh = Math.max(2, Math.min(vh - sy, region.height * scaleY));
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    };
    drawFrame();
    canvasStream = canvas.captureStream(30);
    const mimeCandidates = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mimeType = mimeCandidates.find(candidate => MediaRecorder.isTypeSupported(candidate));
    recorder = new MediaRecorder(canvasStream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 4_000_000 });
    const active = recorder;
    active.ondataavailable = event => { if (!finished && event.data.size > 0) chunks.push(event.data); };
    active.onstop = () => {
      if (finished) return;
      finished = true;
      cleanup();
      const blob = new Blob(chunks, { type: active.mimeType || mimeType || 'video/mp4' });
      chunks.length = 0;
      if (blob.size) resolveResult(blob);
      else rejectResult(new TaskError('invalidOutput'));
    };
    active.onerror = () => fail(new TaskError('encodingFailed'), true);
    active.start(100);
    timer = window.setInterval(drawFrame, 33);
    return {
      stop() {
        if (!finished && !stopping) {
          stopping = true;
          try {
            drawFrame();
            if (timer !== undefined) window.clearInterval(timer);
            active.stop();
          } catch { fail(new TaskError('encodingFailed')); }
        }
        return result;
      },
      cancel: () => fail(new TaskError('cancelled')),
    };
  } catch (error) {
    fail(error instanceof TaskError ? error : new TaskError('encodingFailed'));
    throw error;
  }
}

export interface PageRegionController {
  startSelect: (initialRegion?: RegionRect) => RegionRect | null;
  setRecordingUI: (startedAt: number, region?: RegionRect) => void;
  cancel: () => void;
  getRegion: () => RegionRect | null;
}

export function createPageRegionController(): PageRegionController {
  let host: HTMLDivElement | null = null;
  let stage: 'idle' | 'selecting' | 'selected' | 'recording' = 'idle';
  let region: RegionRect | null = null;
  let startedAt = 0;
  let clockTimer: number | undefined;
  let toolbarPos: { left: number; top: number } | null = null;

  const msg = (key: string, substitutions?: string | string[]) => chrome.i18n.getMessage(key, substitutions) || key;
  const formatElapsed = (ms: number) => {
    const tenths = Math.max(0, Math.floor(ms / 100));
    const mins = String(Math.floor(tenths / 600)).padStart(2, '0');
    const secs = String(Math.floor((tenths % 600) / 10)).padStart(2, '0');
    return `${mins}:${secs}.${tenths % 10}`;
  };

  function destroyUI() {
    if (clockTimer !== undefined) { window.clearInterval(clockTimer); clockTimer = undefined; }
    window.removeEventListener('keydown', onKeyDown, true);
    host?.remove();
    host = null;
    toolbarPos = null;
  }

  function cancelAll(notifyBackground = true) {
    stage = 'idle';
    region = null;
    destroyUI();
    if (notifyBackground) {
      void chrome.runtime.sendMessage({ target: 'background', type: 'recording-cancelled' }).catch(() => {});
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape' && stage !== 'idle') {
      event.preventDefault();
      event.stopPropagation();
      cancelAll(true);
    }
  }

  function syncRegionToBackground() {
    if (!region) return;
    void chrome.runtime.sendMessage({
      target: 'background',
      type: 'region-updated',
      region,
      title: document.title || location.hostname || 'Page',
    }).catch(() => {});
  }

  function ensureOverlay() {
    if (host && host.isConnected) return host.shadowRoot!;
    host?.remove();
    host = document.createElement('div');
    host.id = 'gif-toolkit-region-root';
    host.dataset.gifToolkitIgnore = 'true';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;border:0;margin:0;padding:0;';
    const shadow = host.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(host);
    window.addEventListener('keydown', onKeyDown, true);
    return shadow;
  }

  function render() {
    if (stage === 'idle') { destroyUI(); return; }
    const shadow = ensureOverlay();
    const r = region;
    const isRecording = stage === 'recording';
    const isSelecting = stage === 'selecting';
    const defaultTop = r ? (r.y + r.height + 56 <= window.innerHeight ? r.y + r.height + 10 : Math.max(10, r.y - 50)) : 18;
    const defaultLeft = r ? Math.max(10, Math.min(window.innerWidth - 340, r.x)) : Math.max(10, Math.floor((window.innerWidth - 360) / 2));
    const barLeft = toolbarPos ? toolbarPos.left : defaultLeft;
    const barTop = toolbarPos ? toolbarPos.top : defaultTop;

    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif; }
        .surface {
          position: fixed; inset: 0;
          pointer-events: ${isRecording ? 'none' : 'auto'};
          cursor: ${isSelecting ? 'crosshair' : 'default'};
          background: ${isSelecting && !r ? 'rgba(12, 36, 27, 0.28)' : 'transparent'};
          -webkit-user-select: none; user-select: none;
        }
        .prompt-banner {
          position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
          display: flex; align-items: center; gap: 10px;
          background: #153a30; color: #e7f5c5; padding: 9px 14px; border-radius: 999px;
          font-size: 12.5px; font-weight: 600; box-shadow: 0 8px 28px rgba(0,0,0,0.28);
          pointer-events: auto; z-index: 3;
        }
        .prompt-banner button {
          border: 0; background: rgba(255,255,255,0.14); color: #fff;
          width: 22px; height: 22px; border-radius: 50%; cursor: pointer; font-size: 14px; line-height: 1;
        }
        .region-box {
          position: fixed;
          display: ${r ? 'block' : 'none'};
          left: ${r ? (isRecording ? r.x - 3 : r.x) : 0}px;
          top: ${r ? (isRecording ? r.y - 3 : r.y) : 0}px;
          width: ${r ? (isRecording ? r.width + 6 : r.width) : 0}px;
          height: ${r ? (isRecording ? r.height + 6 : r.height) : 0}px;
          border: 2px ${isRecording ? 'dashed #ff5a4f' : 'solid #d5f480'};
          border-radius: ${isRecording ? '4px' : '2px'};
          box-shadow: ${isRecording ? 'none' : '0 0 0 9999px rgba(12, 36, 27, 0.52)'};
          pointer-events: ${stage === 'selected' ? 'auto' : 'none'};
          cursor: ${stage === 'selected' ? 'move' : 'default'};
          z-index: 2;
        }
        .handle {
          position: absolute; width: 10px; height: 10px; background: #d5f480;
          border: 2px solid #153a30; border-radius: 2px;
        }
        .handle.nw { left: -6px; top: -6px; cursor: nwse-resize; }
        .handle.ne { right: -6px; top: -6px; cursor: nesw-resize; }
        .handle.sw { left: -6px; bottom: -6px; cursor: nesw-resize; }
        .handle.se { right: -6px; bottom: -6px; cursor: nwse-resize; }
        .toolbar {
          position: fixed; left: ${barLeft}px; top: ${barTop}px; margin: 0;
          display: flex; align-items: center; gap: 7px;
          background: #153a30; color: #f5f7f4; padding: 6px 9px; border-radius: 10px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.32); pointer-events: auto; z-index: 4;
          font-size: 12px; white-space: nowrap;
        }
        .drag-handle {
          cursor: grab; touch-action: none; -webkit-user-select: none; user-select: none;
          padding: 4px 5px; color: #9ab5a3; font-size: 13px; border-radius: 5px;
        }
        .drag-handle.dragging { cursor: grabbing; }
        .drag-handle:focus-visible { outline: 2px solid #d5f480; outline-offset: 2px; }
        .badge {
          font-variant-numeric: tabular-nums; font-size: 11px; color: #d5f480;
          background: rgba(213, 244, 128, 0.12); padding: 3px 7px; border-radius: 6px; font-weight: 600;
        }
        .rec-dot {
          width: 8px; height: 8px; border-radius: 50%; background: #ff5a4f; display: inline-block; margin-right: 5px;
        }
        .toolbar button {
          border: 0; border-radius: 7px; padding: 6px 10px; font: inherit; font-size: 11.5px;
          font-weight: 650; cursor: pointer; background: rgba(255,255,255,0.12); color: #f5f7f4;
        }
        .toolbar button:hover { filter: brightness(1.08); }
        .toolbar button.primary { background: #d5f480; color: #153a30; }
        .toolbar button.video-btn { background: #e8f3dc; color: #18332c; }
        .toolbar button:focus-visible { outline: 2px solid #d5f480; outline-offset: 2px; }
      </style>
      <div class="surface" id="surface">
        ${isSelecting ? `<div class="prompt-banner"><span>${msg('recordOverlayPrompt')}</span><button type="button" data-action="cancel" aria-label="${msg('cancel')}">×</button></div>` : ''}
        <div class="region-box" id="region-box">
          ${stage === 'selected' ? '<span class="handle nw" data-handle="nw"></span><span class="handle ne" data-handle="ne"></span><span class="handle sw" data-handle="sw"></span><span class="handle se" data-handle="se"></span>' : ''}
        </div>
        ${r && !isSelecting ? `<div class="toolbar" id="toolbar" role="toolbar" aria-label="${msg('recordRegion')}">
          <span class="drag-handle" id="drag-handle" tabindex="0" aria-label="${msg('recordDragToolbar')}">⋮⋮</span>
          <span class="badge" id="status-badge">${isRecording ? `<i class="rec-dot"></i><span id="timer-text">${formatElapsed(Date.now() - startedAt)}</span>` : `${Math.round(r.width)} × ${Math.round(r.height)} px`}</span>
          ${isRecording ? `
            <button type="button" class="video-btn" data-action="save-video">${msg('recordSaveVideo')}</button>
            <button type="button" class="primary" data-action="save-gif">${msg('recordSaveGif')}</button>
            <button type="button" data-action="cancel">${msg('cancel')}</button>
          ` : `
            <button type="button" class="primary" data-action="start-record">${msg('recordStart')}</button>
            <button type="button" data-action="reselect">${msg('recordReselect')}</button>
            <button type="button" data-action="cancel">${msg('cancel')}</button>
          `}
        </div>` : ''}
      </div>
    `;

    const surface = shadow.getElementById('surface')!;
    const regionBox = shadow.getElementById('region-box');
    const toolbar = shadow.getElementById('toolbar');
    const dragHandle = shadow.getElementById('drag-handle');

    if (isSelecting) {
      let startX = 0, startY = 0, dragging = false;
      surface.addEventListener('pointerdown', event => {
        if (event.button !== 0 || (event.target as Element).closest('button')) return;
        dragging = true;
        startX = event.clientX;
        startY = event.clientY;
        surface.setPointerCapture(event.pointerId);
      });
      surface.addEventListener('pointermove', event => {
        if (!dragging || !surface.hasPointerCapture(event.pointerId)) return;
        const x = Math.max(0, Math.min(startX, event.clientX));
        const y = Math.max(0, Math.min(startY, event.clientY));
        const width = Math.min(window.innerWidth - x, Math.abs(event.clientX - startX));
        const height = Math.min(window.innerHeight - y, Math.abs(event.clientY - startY));
        region = { x, y, width: Math.max(4, width), height: Math.max(4, height), viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
        if (regionBox) {
          regionBox.style.display = 'block';
          regionBox.style.left = `${region.x}px`;
          regionBox.style.top = `${region.y}px`;
          regionBox.style.width = `${region.width}px`;
          regionBox.style.height = `${region.height}px`;
        }
      });
      const finishSelect = (event: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        const dx = Math.abs(event.clientX - startX);
        const dy = Math.abs(event.clientY - startY);
        region = dx < 24 || dy < 24
          ? clampRegion({}, window.innerWidth, window.innerHeight)
          : clampRegion({ x: Math.min(startX, event.clientX), y: Math.min(startY, event.clientY), width: dx, height: dy }, window.innerWidth, window.innerHeight);
        stage = 'selected';
        toolbarPos = null;
        render();
        syncRegionToBackground();
      };
      surface.addEventListener('pointerup', finishSelect);
    }

    if (stage === 'selected' && regionBox && r) {
      let mode: 'move' | 'nw' | 'ne' | 'sw' | 'se' | null = null;
      let startX = 0, startY = 0;
      let initial = { ...r };
      regionBox.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.stopPropagation();
        const handle = (event.target as HTMLElement).dataset.handle as 'nw' | 'ne' | 'sw' | 'se' | undefined;
        mode = handle ?? 'move';
        startX = event.clientX;
        startY = event.clientY;
        initial = { ...region! };
        regionBox.setPointerCapture(event.pointerId);
      });
      regionBox.addEventListener('pointermove', event => {
        if (!mode || !regionBox.hasPointerCapture(event.pointerId)) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        let { x, y, width, height } = initial;
        if (mode === 'move') {
          x += dx; y += dy;
        } else {
          if (mode.includes('w')) { x += dx; width -= dx; }
          if (mode.includes('e')) { width += dx; }
          if (mode.includes('n')) { y += dy; height -= dy; }
          if (mode.includes('s')) { height += dy; }
        }
        region = clampRegion({ x, y, width, height }, window.innerWidth, window.innerHeight);
        regionBox.style.left = `${region.x}px`;
        regionBox.style.top = `${region.y}px`;
        regionBox.style.width = `${region.width}px`;
        regionBox.style.height = `${region.height}px`;
        const badge = shadow.getElementById('status-badge');
        if (badge) badge.textContent = `${Math.round(region.width)} × ${Math.round(region.height)} px`;
      });
      regionBox.addEventListener('lostpointercapture', () => {
        if (!mode) return;
        mode = null;
        syncRegionToBackground();
      });
    }

    if (toolbar && dragHandle) {
      let offsetX = 0, offsetY = 0;
      const moveToolbarTo = (left: number, top: number) => {
        const maxLeft = Math.max(0, window.innerWidth - toolbar.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - toolbar.offsetHeight);
        const clampedLeft = Math.max(0, Math.min(left, maxLeft));
        const clampedTop = Math.max(0, Math.min(top, maxTop));
        toolbarPos = { left: clampedLeft, top: clampedTop };
        toolbar.style.left = `${clampedLeft}px`;
        toolbar.style.top = `${clampedTop}px`;
      };
      dragHandle.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        const rect = toolbar.getBoundingClientRect();
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;
        dragHandle.setPointerCapture(event.pointerId);
      });
      dragHandle.addEventListener('pointermove', event => {
        if (!dragHandle.hasPointerCapture(event.pointerId)) return;
        dragHandle.classList.add('dragging');
        moveToolbarTo(event.clientX - offsetX, event.clientY - offsetY);
      });
      dragHandle.addEventListener('lostpointercapture', () => {
        dragHandle.classList.remove('dragging');
      });
      dragHandle.addEventListener('keydown', event => {
        const step = 15;
        const rect = toolbar.getBoundingClientRect();
        if (event.key === 'ArrowLeft') { event.preventDefault(); moveToolbarTo(rect.left - step, rect.top); }
        else if (event.key === 'ArrowRight') { event.preventDefault(); moveToolbarTo(rect.left + step, rect.top); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); moveToolbarTo(rect.left, rect.top - step); }
        else if (event.key === 'ArrowDown') { event.preventDefault(); moveToolbarTo(rect.left, rect.top + step); }
      });
    }

    shadow.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach(btn => {
      btn.addEventListener('click', event => {
        event.stopPropagation();
        const action = btn.dataset.action;
        if (action === 'cancel') cancelAll(true);
        else if (action === 'reselect') {
          // v0.1.14: the background owns transitions; a reselect queued behind
          // startup may be declined, so keep the recording controls in sync with its reply.
          void chrome.runtime.sendMessage({ target: 'background', type: 'recording-reselect' }).then((reply: Reply<RecordingState>) => {
            if (!reply.ok || reply.data.stage !== 'selecting' || stage !== 'selected') return;
            region = null;
            stage = 'selecting';
            toolbarPos = null;
            render();
          }).catch(() => {});
        } else if (action === 'start-record') {
          void chrome.runtime.sendMessage({
            target: 'background',
            type: 'start-recording',
            region,
            title: document.title || location.hostname || 'Page',
          }).catch(() => {});
        } else if (action === 'save-video' || action === 'save-gif') {
          const format: ExportFormat = action === 'save-video' ? 'video' : 'gif';
          void chrome.runtime.sendMessage({
            target: 'background',
            type: 'stop-recording',
            format,
            title: document.title || location.hostname || 'Page',
          }).catch(() => {});
        }
      });
    });
  }

  return {
    startSelect(initialRegion?: RegionRect) {
      if (initialRegion) {
        region = clampRegion(initialRegion, window.innerWidth, window.innerHeight);
        stage = 'selected';
      } else {
        region = null;
        stage = 'selecting';
      }
      toolbarPos = null;
      render();
      if (region) syncRegionToBackground();
      return region;
    },
    setRecordingUI(startTimestamp: number, nextRegion?: RegionRect) {
      if (nextRegion) region = clampRegion(nextRegion, window.innerWidth, window.innerHeight);
      if (!region) region = clampRegion({}, window.innerWidth, window.innerHeight);
      startedAt = startTimestamp;
      stage = 'recording';
      render();
      if (clockTimer !== undefined) window.clearInterval(clockTimer);
      clockTimer = window.setInterval(() => {
        const timerEl = host?.shadowRoot?.getElementById('timer-text');
        if (timerEl) timerEl.textContent = formatElapsed(Date.now() - startedAt);
      }, 100);
    },
    cancel() {
      cancelAll(false);
    },
    getRegion() {
      return region;
    },
  };
}
