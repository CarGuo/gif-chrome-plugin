import { TaskError } from './shared/model';

export class WorkerClient {
  private closed = false;
  private callbacks = new Map<string, { resolve: (data: any) => void; reject: (error: unknown) => void }>();
  constructor(private worker: Worker, handle?: (type: string, data: any) => Promise<unknown>) {
    worker.onmessage = event => {
      if (event.data?.rpc === true) {
        const { id, type, data } = event.data;
        void (handle ? handle(type, data) : Promise.reject(new TaskError('permissionRequired')))
          .then(data => !this.closed && worker.postMessage({ parentReply: true, id, ok: true, data }),
            error => !this.closed && worker.postMessage({ parentReply: true, id, ok: false, error: error instanceof TaskError ? error.code : 'downloadFailed' }));
        return;
      }
      const response = event.data, callback = this.callbacks.get(response.id);
      if (!callback) return;
      this.callbacks.delete(response.id);
      response.ok ? callback.resolve(response.data) : callback.reject(new TaskError(response.error));
    };
    worker.onerror = () => this.close(new TaskError('encodingFailed'));
  }
  request<T>(type: string, data = {}): Promise<T> {
    if (this.closed) return Promise.reject(new TaskError('cancelled'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => { this.callbacks.set(id, { resolve, reject }); this.worker.postMessage({ id, type, ...data }); });
  }
  close(error = new TaskError('cancelled')) {
    this.closed = true; this.worker.terminate();
    for (const callback of this.callbacks.values()) callback.reject(error);
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
