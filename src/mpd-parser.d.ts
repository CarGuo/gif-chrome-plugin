declare module 'mpd-parser' {
  export function parse(manifest: string, options: { manifestUri: string }): import('./shared/manifest').DashManifest;
}
