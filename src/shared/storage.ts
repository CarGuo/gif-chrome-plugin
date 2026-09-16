import { POLICY, validateSettings, type Job } from './model';
import { makeFilename } from './filename';
let database: Promise<IDBDatabase> | undefined;
function db() {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('gif-toolkit', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('jobs', { keyPath: 'id' });
      request.result.createObjectStore('results');
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
// v0.1.2: read the old settings schema as 1x so history/re-edit remains usable after an extension update.
const migrateJob = (job: Job): Job => ({ ...job, settings: validateSettings(job.settings),
  // v0.1.4: apply the same filename contract to historical results without re-encoding GIF bytes.
  ...(job.result ? { result: { ...job.result, filename: makeFilename(job) } } : {}) });
export const getJob = async (id: string): Promise<Job | undefined> => {
  const job = await run<Job | undefined>('jobs', 'readonly', s => s.get(id));
  return job ? migrateJob(job) : undefined;
};
export const getJobs = async (): Promise<Job[]> => (await run<Job[]>('jobs', 'readonly', s => s.getAll())).map(migrateJob);
export const getResult = (id: string): Promise<Blob | undefined> => run('results', 'readonly', s => s.get(id));
export const saveResult = (id: string, blob: Blob) => run('results', 'readwrite', s => s.put(blob, id));
export const deleteResult = (id: string) => run('results', 'readwrite', s => s.delete(id));
export async function removeJob(id: string) {
  await run('results', 'readwrite', s => s.delete(id));
  await run('jobs', 'readwrite', s => s.delete(id));
}
export async function pruneHistory() {
  const done = (await getJobs()).filter(j => ['completed', 'failed', 'cancelled'].includes(j.stage)).sort((a, b) => b.createdAt - a.createdAt);
  for (const job of done.slice(POLICY.historyCount)) await removeJob(job.id);
  return done.slice(POLICY.historyCount).map(job => job.id);
}
