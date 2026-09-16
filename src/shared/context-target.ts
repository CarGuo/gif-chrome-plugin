/** Resolve the media under a context gesture without assigning article text to a nearby video. */
export function contextTarget(event: MouseEvent): HTMLVideoElement | HTMLImageElement | undefined {
  const path = event.composedPath();
  const direct = path.find(node => node instanceof HTMLVideoElement || node instanceof HTMLImageElement);
  if (direct) return direct as HTMLVideoElement | HTMLImageElement;
  const target = path[0];
  if (!(target instanceof Element)) return;
  // Links, controls and site menus keep their own interaction, even when positioned over a video.
  if (target.closest('a,button,input,textarea,select,[contenteditable="true"],[role="menu"],[role="menuitem"]')) return;
  for (const node of path) {
    if (!(node instanceof Element) || node === document.body || node === document.documentElement) break;
    const videos = [...node.querySelectorAll('video')].filter(video => {
      const rect = video.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && event.clientX >= rect.left && event.clientX < rect.right
        && event.clientY >= rect.top && event.clientY < rect.bottom && getComputedStyle(video).visibility !== 'hidden';
    });
    if (videos.length) return videos.length === 1 ? videos[0] : undefined;
  }
}
