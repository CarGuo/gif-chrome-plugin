import { normalizeOutputName, type Job } from './model';

// v0.1.4: portable filenames use RFC 4648 base64url, a persisted generation timestamp
// and the job UUID. Same-millisecond jobs cannot collide; saving/renaming never invents a new time.
// Bound the UTF-8 title prefix before encoding, preserving code points and Windows path headroom.
const TITLE_BYTES = 72;
export function makeFilename(job: Pick<Job, 'id' | 'createdAt' | 'source'>, title = job.source.title): string {
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (const point of normalizeOutputName(title).normalize('NFC')) {
    const next = encoder.encode(point);
    if (bytes.length + next.length > TITLE_BYTES) break;
    bytes.push(...next);
  }
  const name = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${name}_${job.createdAt}_${job.id.replace(/-/g, '')}.gif`;
}
