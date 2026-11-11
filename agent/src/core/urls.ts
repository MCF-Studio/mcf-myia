/**
 * Liens « de confiance » de la session : donnés par l'utilisateur dans ses messages ou renvoyés par web_search.
 * browser_open les ouvre sans confirmation ; tout autre lien (ex. trouvé DANS une page lue) demande confirmation,
 * pour qu'une page piégée ne puisse pas faire ouvrir n'importe quoi dans le navigateur de l'utilisateur.
 */
const trusted = new Set<string>();

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;

export function canonicalUrl(u: string): string | undefined {
  try {
    const url = new URL(u);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

export function trustUrl(u: string) {
  const c = canonicalUrl(u);
  if (c) trusted.add(c);
}

export function trustUrlsIn(text: string) {
  for (const m of text.match(URL_RE) ?? []) trustUrl(m.replace(/[.,;:!?]+$/, ""));
}

export function isTrustedUrl(u: string): boolean {
  const c = canonicalUrl(u);
  return !!c && trusted.has(c);
}

export function clearTrustedUrls() {
  trusted.clear();
}
