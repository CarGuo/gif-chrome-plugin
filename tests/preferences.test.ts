import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, validateOutputName, validateSettings } from '../src/shared/model';
import { migratePreferences } from '../src/shared/preferences';

describe('v0.1.3 preference migration', () => {
  it('initializes new installs at 10 fps', () => {
    expect(migratePreferences({}).values).toEqual(DEFAULT_SETTINGS);
  });
  it('migrates the unversioned 12 fps default once, preserving other settings', () => {
    const settings = { maxBytes: 2_000_000, maxSide: 640, fps: 12, speed: 1.5 };
    const migrated = migratePreferences({ settings });
    expect(migrated.values).toEqual({ ...settings, fps: 10, dropFrames: 'none' });
    expect(migratePreferences({ settings, exportPreferences: { ...migrated, values: settings } }).values).toEqual({ ...settings, dropFrames: 'none' });
    expect(settings.fps).toBe(12);
  });
  it('preserves non-default rates and leaves historical job settings unchanged', () => {
    expect(migratePreferences({ settings: { ...DEFAULT_SETTINGS, fps: 15 } }).values.fps).toBe(15);
    expect(validateSettings({ maxBytes: 4_000_000, maxSide: 800, fps: 12 })).toMatchObject({ fps: 12, speed: 1 });
  });
  it('rejects unsupported versions instead of silently replacing the user values', () => {
    expect(() => migratePreferences({ exportPreferences: { version: 2, values: DEFAULT_SETTINGS } })).toThrow('invalidSettings');
  });
  it('rejects blank names and keeps meaningful multilingual text', () => {
    expect(validateOutputName('  猫咪\n playing  ')).toBe('猫咪 playing');
    for (const name of ['', '  ', undefined, 'a'.repeat(201)]) expect(() => validateOutputName(name)).toThrow('invalidName');
  });
});
