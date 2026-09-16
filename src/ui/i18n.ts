import en from '../locales/en.json';
import type { ErrorCode, Stage } from '../shared/model';
export type TextKey = keyof typeof en;
export const t = (key: TextKey, substitutions?: string | string[]) => chrome.i18n.getMessage(key, substitutions);
export const errorText = (code: ErrorCode) => t(`error${code[0].toUpperCase()}${code.slice(1)}` as TextKey);
export const stageText = (stage: Stage) => t(`stage${stage[0].toUpperCase()}${stage.slice(1)}` as TextKey);
export const number = (value: number, digits = 2) => new Intl.NumberFormat(chrome.i18n.getUILanguage(), { maximumFractionDigits: digits }).format(value);
export function time(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—';
  const centiseconds = Math.round(value * 100);
  return `${Math.floor(centiseconds / 6000).toString().padStart(2, '0')}:${(Math.floor(centiseconds / 100) % 60).toString().padStart(2, '0')}.${(centiseconds % 100).toString().padStart(2, '0')}`;
}
