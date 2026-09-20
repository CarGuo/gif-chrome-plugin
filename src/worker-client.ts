import { POLICY, TaskError } from './shared/model';

export class WorkerClient {
  private closed: TaskError | undefined;
  private callbacks = new Map<string, { resolve: (data: any) => void; reject: (error: unknown) => void; timer?: ReturnType<typeof setTimeout>; timeoutMs: number }>();
  constructor(private worker: Worker, handle?: (type: string, data: any) => Promise<unknown>) {
    worker.onmessage = event => {
      if (this.closed) return;
      if (event.data?.activity === true) { this.activity(event.data.id); return; }
      if (event.data?.rpc === true) {
        const { id, type, data } = event.data;
        void Promise.resolve().then(() => handle ? handle(type, data) : Promise.reject(new TaskError('permissionRequired')))
          .then(data => !this.closed && worker.postMessage({ parentReply: true, id, ok: true, data }),
            error => !this.closed && worker.postMessage({ parentReply: true, id, ok: false, error: error instanceof TaskError ? error.code : 'downloadFailed' }))
          .catch(() => this.close(new TaskError('encodingFailed')));
        return;
      }
      const response = event.data, callback = this.callbacks.get(response?.id);
      if (!callback) return;
      clearTimeout(callback.timer);
      this.callbacks.delete(response.id);
      response.ok ? callback.resolve(response.data) : callback.reject(new TaskError(response.error));
    };
    worker.onerror = () => this.close(new TaskError('encodingFailed'));
    worker.onmessageerror = () => this.close(new TaskError('encodingFailed'));
  }
  private activity(id: string) {
    const callback = this.callbacks.get(id); if (!callback) return;
    clearTimeout(callback.timer);
    callback.timer = setTimeout(() => this.close(new TaskError('workerTimeout')), callback.timeoutMs);
  }
  // v0.1.11: bound inactivity, and terminate the owner on timeout. Merely racing a
  // promise would leave its decoder/network operations alive and the queue occupied.
  request<T>(type: string, data = {}, timeoutMs = type === 'open' ? POLICY.decodeOpenTimeoutMs : POLICY.seekTimeoutMs as number): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject, timeoutMs }); this.activity(id);
      try { this.worker.postMessage({ id, type, ...data }); }
      catch { this.close(new TaskError('encodingFailed')); }
    });
  }
  close(error = new TaskError('cancelled')) {
    if (this.closed) return;
    this.closed = error; this.worker.terminate();
    this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
    for (const callback of this.callbacks.values()) { clearTimeout(callback.timer); callback.reject(error); }
    this.callbacks.clear();
  }
}

// Gifsicle's upstream module embeds its worker source. The build emits it as a local file;
// no blob scripts, eval, remotely hosted code, or uninterruptible UI work is needed.
export function optimizeGif(bytes: Uint8Array, lossy: number, signal: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(chrome.runtime.getURL('gifsicle-worker.js'));
    const finish = (error?: Error, result?: Uint8Array) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate();
      error ? reject(error) : resolve(result!);
    };
    const abort = () => finish(new TaskError('cancelled'));
    const timer = setTimeout(() => finish(new TaskError('encodingFailed')), 90_000);
    worker.onerror = () => finish(new TaskError('encodingFailed'));
    worker.onmessage = event => {
      const result = event.data?.[0]?.file;
      if (!(result instanceof Uint8Array) || !result.length) finish(new TaskError('encodingFailed'));
      else finish(undefined, result);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    worker.postMessage({ data: [{ name: 'input.gif', file: bytes }],
      command: [`-O1 --optimize=keep-empty --lossy=${lossy} input.gif -o /out/output.gif`], folder: [] });
  });
}
