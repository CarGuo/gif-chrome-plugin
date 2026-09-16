import { DEFAULT_SETTINGS, TaskError, validateSettings, type ExportSettings, type SavedExportSettings } from './model';

const PREFERENCES_VERSION = 1;
export const PREFERENCES_KEY = 'exportPreferences';
interface Preferences { version: number; values: ExportSettings }
interface SavedPreferences {
  exportPreferences?: { version: number; values: SavedExportSettings };
  settings?: SavedExportSettings;
}

export function migratePreferences(saved: SavedPreferences): Preferences {
  if (saved.exportPreferences) {
    if (saved.exportPreferences.version !== PREFERENCES_VERSION) throw new TaskError('invalidSettings');
    return { version: PREFERENCES_VERSION, values: validateSettings(saved.exportPreferences.values) };
  }
  const values = saved.settings ? validateSettings(saved.settings) : { ...DEFAULT_SETTINGS };
  // v0.1.3: pre-versioned preferences copied the old 12 fps default into storage. Those records
  // cannot distinguish that default from an explicit 12. Migrate it once, not on every panel open.
  // Versioned records thereafter preserve any explicit value, including 12; job history is separate.
  if (saved.settings?.fps === 12) values.fps = DEFAULT_SETTINGS.fps;
  return { version: PREFERENCES_VERSION, values };
}

let initializing: Promise<void> | undefined;
async function ensurePreferences() {
  // The background worker owns initialization, serializing simultaneous panel requests.
  initializing ??= (async () => {
    const saved = await chrome.storage.local.get([PREFERENCES_KEY, 'settings']);
    const preferences = migratePreferences(saved);
    if (!saved.exportPreferences) await chrome.storage.local.set({ [PREFERENCES_KEY]: preferences });
  })().catch(error => { initializing = undefined; throw error; });
  await initializing;
}
export async function loadPreferences(): Promise<ExportSettings> {
  await ensurePreferences();
  const saved = await chrome.storage.local.get(PREFERENCES_KEY);
  return migratePreferences(saved).values;
}
export async function savePreferences(values: ExportSettings): Promise<void> {
  const valid = validateSettings(values);
  await ensurePreferences();
  await chrome.storage.local.set({ [PREFERENCES_KEY]: { version: PREFERENCES_VERSION, values: valid } });
}
