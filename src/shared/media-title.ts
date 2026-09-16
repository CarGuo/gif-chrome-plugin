const compact = (value: string | null | undefined) => value?.replace(/\s+/g, ' ').trim() ?? '';
const xHosts = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);

export function mediaTitle(media: HTMLVideoElement | HTMLImageElement, index: number): string {
  const document = media.ownerDocument;
  const page = new URL(document.URL);
  const article = media.closest('article');
  // v0.1.3: a player's accessibility label describes the control, not the content.
  // Read the specific post containing this media; never use another post's text or a language blacklist.
  if (xHosts.has(page.hostname) && article) {
    const caption = compact(article.querySelector('[data-testid="tweetText"]')?.textContent);
    if (caption) return `X · ${caption}`.slice(0, 200);
    const permalink = article.querySelector('time')?.closest('a')?.href;
    const match = permalink && new URL(permalink).pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    if (match) return `X · @${match[1]} · ${match[2]}`;
  }
  const title = [
    media.title,
    media instanceof HTMLImageElement ? media.alt : '',
    media.closest('figure')?.querySelector('figcaption')?.textContent,
    article?.querySelector('[itemprop="headline"], [itemprop="name"], h1, h2, h3')?.textContent,
    document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content,
    document.title,
  ].map(compact).find(Boolean);
  return (title || chrome.i18n.getMessage('untitledSource', [page.hostname, String(index + 1)])).slice(0, 200);
}
