import { hasResult, isTerminal, POLICY, TaskError, type CacheSummary, type HistorySnapshot, type Job, type MediaSource } from './model';
import { makeFilename } from './filename';
import { historyProblem, migrateJob } from './history';
let database: Promise<IDBDatabase> | undefined;
function db() {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('gif-toolkit', 2);
    request.onupgradeneeded = () => {
      // v1: jobs and finished GIFs. v0.1.12 adds picked source files, kept apart
      // from results so their lifetime follows the jobs that still reference them.
      if (!request.result.objectStoreNames.contains('jobs')) request.result.createObjectStore('jobs', { keyPath: 'id' });
      if (!request.result.objectStoreNames.contains('results')) request.result.createObjectStore('results');
      if (!request.result.objectStoreNames.contains('localFiles')) request.result.createObjectStore('localFiles');
      if (!request.result.objectStoreNames.contains('localSources')) request.result.createObjectStore('localSources', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function run<T>(store: string, mode: IDBTransactionMode, operation: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(store, mode);
    const request = operation(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error ?? request.error);
    transaction.onerror = () => reject(transaction.error ?? request.error);
  });
}
export const saveJob = (job: Job) => run('jobs', 'readwrite', s => s.put(job));
export async function saveJobs(jobs: Job[]): Promise<void> {
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('jobs', 'readwrite');
    for (const job of jobs) transaction.objectStore('jobs').put(job);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}
export const getJob = async (id: string): Promise<Job | undefined> => {
  const job = await run<Job | undefined>('jobs', 'readonly', s => s.get(id));
  return job ? migrateJob(job) : undefined;
};
export async function getHistory(): Promise<HistorySnapshot> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('jobs', 'readonly');
    const snapshot: HistorySnapshot = { jobs: [], problems: [] };
    const request = transaction.objectStore('jobs').openCursor();
    request.onsuccess = () => {
      const cursor = request.result; if (!cursor) return;
      try { snapshot.jobs.push(migrateJob(cursor.value)); }
      catch { snapshot.problems.push(historyProblem(String(cursor.primaryKey), cursor.value)); }
      cursor.continue();
    };
    transaction.oncomplete = () => resolve(snapshot);
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? request.error);
  });
}
// Processing only consumes validated jobs. Panels use getHistory and display problems separately.
export const getJobs = async (): Promise<Job[]> => (await getHistory()).jobs;
function canClean(value: unknown) {
  try { return isTerminal(migrateJob(value).stage); }
  catch { return true; } // Invalid records cannot be resumed; their raw data stays until explicit deletion.
}
export const getResult = (id: string): Promise<Blob | undefined> => run('results', 'readonly', s => s.get(id));
export const saveResult = (id: string, blob: Blob) => run('results', 'readwrite', s => s.put(blob, id));
export const deleteResult = (id: string) => run('results', 'readwrite', s => s.delete(id));
export const getLocalFile = (id: string): Promise<Blob | undefined> => run('localFiles', 'readonly', s => s.get(id));
export const saveLocalFile = (id: string, blob: Blob) => run('localFiles', 'readwrite', s => s.put(blob, id));
// A picked file is a reusable input library entry, not job output. Its bytes stay until
// the user removes the imported entry, so the same file can be turned into many GIFs.
export const removeLocalFile = (id: string) => run('localFiles', 'readwrite', s => s.delete(id));
// Picked-source metadata lives independently of the current tab and survives restarts.
export const getLocalSources = (): Promise<MediaSource[]> => run<MediaSource[]>('localSources', 'readonly', s => s.getAll());
export const saveLocalSource = (source: MediaSource) => run('localSources', 'readwrite', s => s.put(source));
export async function removeLocalSource(id: string): Promise<void> {
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(['localSources', 'localFiles'], 'readwrite');
    transaction.objectStore('localSources').delete(id);
    transaction.objectStore('localFiles').delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error);
  });
}
// v0.1.9: history and retained files have separate lifetimes. Read and update both
// stores in one transaction; a cleanup must never delete a running job's output.
export async function getCacheSummary(): Promise<CacheSummary> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(['jobs', 'results'], 'readonly');
    const summary: CacheSummary = { ids: [], bytes: 0 };
    const request = transaction.objectStore('results').openCursor();
    request.onsuccess = () => {
      const cursor = request.result; if (!cursor) return;
      const lookup = transaction.objectStore('jobs').get(cursor.primaryKey);
      lookup.onsuccess = () => {
        const job = lookup.result as Job | undefined;
        if (canClean(job) && typeof cursor.primaryKey === 'string' && cursor.value instanceof Blob) {
          summary.ids.push(cursor.primaryKey); summary.bytes += cursor.value.size;
        }
        cursor.continue();
      };
    };
    transaction.oncomplete = () => resolve(summary);
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}
export async function clearStoredItems(ids: string[], mode: 'cache' | 'history', activeIds: string[] = []): Promise<CacheSummary> {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string') || !['cache', 'history'].includes(mode)) throw new TaskError('invalidSettings');
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(['jobs', 'results'], 'readwrite');
    const jobs = transaction.objectStore('jobs'), results = transaction.objectStore('results');
    const cleared: CacheSummary = { ids: [], bytes: 0 };
    const now = Date.now();
    // The caller supplies the reviewed IDs, so a new result created while a confirmation
    // is open cannot be swept into that earlier cleanup request.
    for (const id of new Set(ids)) {
      if (activeIds.includes(id)) continue;
      const lookup = jobs.get(id);
      lookup.onsuccess = () => {
        const job = lookup.result as Job | undefined;
        if (!canClean(job)) return;
        const file = results.get(id);
        file.onsuccess = () => {
          // A second panel may already have cleared the same reviewed snapshot.
          if (!(file.result instanceof Blob) && (mode === 'cache' || !job)) return;
          if (file.result instanceof Blob) cleared.bytes += file.result.size;
          results.delete(id);
          if (mode === 'history') jobs.delete(id);
          else if (job?.result) jobs.put({ ...job, updatedAt: now, result: { ...job.result, clearedAt: now } });
          cleared.ids.push(id);
        };
      };
    }
    transaction.oncomplete = () => resolve(cleared);
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}
export async function removeJob(id: string) {
  return clearStoredItems([id], 'history');
}
export async function renameResult(id: string, title: string): Promise<Job> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('jobs', 'readwrite');
    const jobs = transaction.objectStore('jobs'), request = jobs.get(id);
    let renamed: Job | undefined;
    request.onsuccess = () => {
      const job = request.result as Job | undefined;
      if (!job || !hasResult(job)) { transaction.abort(); return; }
      renamed = { ...job, source: { ...job.source, title }, updatedAt: Date.now(), result: { ...job.result!, filename: makeFilename(job, title) } };
      jobs.put(renamed);
    };
    transaction.oncomplete = () => resolve(migrateJob(renamed!));
    transaction.onabort = () => reject(transaction.error ?? new TaskError('resultUnavailable'));
    transaction.onerror = () => reject(transaction.error);
  });
}
export async function pruneHistory() {
  const done = (await getJobs()).filter(j => ['completed', 'failed', 'cancelled'].includes(j.stage)).sort((a, b) => b.createdAt - a.createdAt);
  for (const job of done.slice(POLICY.historyCount)) await removeJob(job.id);
  return done.slice(POLICY.historyCount).map(job => job.id);
}
