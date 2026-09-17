import { useEffect, useRef } from 'react';
import { number, t } from './i18n';

export interface CleanupRequest { kind: 'cache' | 'history'; ids: string[]; bytes: number }

// v0.1.9: native modal semantics provide focus containment, Escape and focus restoration.
// The request is a snapshot of reviewed IDs, not an instruction to delete future results.
export function CleanupDialog({ request, onCancel, onConfirm }: {
  request: CleanupRequest; onCancel: () => void; onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className="cleanup-dialog" aria-labelledby="cleanup-title" aria-describedby="cleanup-description" onCancel={onCancel}>
    <h2 id="cleanup-title">{t(request.kind === 'cache' ? 'clearCache' : 'clearHistory')}</h2>
    <p id="cleanup-description">{request.kind === 'cache'
      ? t('clearCacheConfirm', [number(request.ids.length, 0), number(request.bytes / 1_000_000)])
      : t('clearHistoryConfirm', number(request.ids.length, 0))}</p>
    <div className="cleanup-actions"><button autoFocus onClick={onCancel}>{t('cancel')}</button>
      <button className="danger-button" onClick={onConfirm}>{t(request.kind === 'cache' ? 'clearCache' : 'clearHistory')}</button></div>
  </dialog>;
}
