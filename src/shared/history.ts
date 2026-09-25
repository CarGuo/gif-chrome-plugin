import { ERROR_CODES, httpOrigin, TaskError, validateOutputName, validateSettings, type HistoryProblem, type Job } from './model';
import { isLocalSource } from './local-source';
import { makeFilename } from './filename';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';
const date = (value: unknown): value is number => typeof value === 'number' && value >= 0 && Number.isFinite(new Date(value).getTime());
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// v0.1.11: validate each persisted record independently. Bad records remain in IndexedDB
// and have an explicit diagnostic/deletion view; never invent export settings for them.
export function migrateJob(value: unknown): Job {
  try {
    if (!object(value) || typeof value.id !== 'string' || !value.id || !object(value.source) || !object(value.segment)) throw Error();
    const { source, segment } = value;
    if (typeof source.id !== 'string' || !source.id || typeof source.documentKey !== 'string' || !source.documentKey ||
      !Number.isInteger(source.tabId) || !Number.isInteger(source.frameId) || typeof source.url !== 'string' ||
      !['video', 'gif', 'webp', 'image'].includes(String(source.kind)) || !nonnegative(source.width) || !nonnegative(source.height) ||
      !(source.duration === null || nonnegative(source.duration)) || !date(value.createdAt) || !date(value.updatedAt) ||
      !nonnegative(segment.start) || !nonnegative(segment.end) ||
      !['queued', 'loading', 'downloading', 'estimating', 'capturing', 'encoding', 'optimizing', 'dropping', 'validating', 'completed', 'cancelled', 'failed'].includes(String(value.stage)) ||
      !nonnegative(value.progress) || value.progress > 1 ||
      (value.error !== undefined && !ERROR_CODES.includes(value.error as never))) throw Error();
    const job = value as unknown as Job;
    if (isLocalSource(job.source)) {
      if (job.source.kind !== 'video' || job.source.tabId !== -1) throw Error();
    } else {
      httpOrigin(source.pageUrl as string);
      if (source.mediaPageUrl !== undefined) httpOrigin(source.mediaPageUrl as string);
    }
    validateOutputName(source.title);
    if (value.stage === 'completed' && !object(value.result)) throw Error();
    if (value.result !== undefined) {
      const result = value.result;
      if (!object(result) || !['bytes', 'width', 'height', 'duration', 'frames'].every(key => nonnegative(result[key])) ||
        (result.clearedAt !== undefined && !date(result.clearedAt))) throw Error();
    }
    return { ...job, settings: validateSettings(job.settings), ...(job.result ? { result: { ...job.result, filename: makeFilename(job) } } : {}) };
  } catch { throw new TaskError('invalidHistory'); }
}

export function historyProblem(id: string, value: unknown): HistoryProblem {
  return { id, ...(object(value) && object(value.source) && typeof value.source.title === 'string' ? { title: value.source.title.slice(0, 200) } : {}),
    ...(object(value) && date(value.createdAt) ? { createdAt: value.createdAt } : {}) };
}
