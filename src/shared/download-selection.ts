import { POLICY, TaskError, type DownloadSelection } from './model';

// v0.1.11: structural ambiguity rejects a batch; a name is an item-level error.
export function parseDownloadSelection(value: unknown): DownloadSelection[] {
  if (!Array.isArray(value) || !value.length || value.length > POLICY.historyCount) throw new TaskError('invalidSettings');
  const seen = new Set<string>();
  return value.map(item => {
    if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id)) throw new TaskError('invalidSettings');
    seen.add(item.id); return { id: item.id, title: item.title };
  });
}
