/**
 * Liens « de confiance » d'UNE conversation : donnés par l'utilisateur dans ses messages ou renvoyés par web_search.
 * browser_open les ouvre sans confirmation ; tout autre lien (ex. trouvé DANS une page lue) demande confirmation,
 * pour qu'une page piégée ne puisse pas faire ouvrir n'importe quoi dans le navigateur de l'utilisateur.
 * Chaque agent (donc chaque conversation, chaque sous-agent) a son propre ensemble : rien ne fuit d'une
 * conversation à l'autre.
 */

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

export class UrlTrust {
  private readonly set = new Set<string>();

  add(u: string) {
    const c = canonicalUrl(u);
    if (c) this.set.add(c);
  }

  addFrom(text: string) {
    for (const m of text.match(URL_RE) ?? []) this.add(m.replace(/[.,;:!?]+$/, ""));
  }

  has(u: string): boolean {
    const c = canonicalUrl(u);
    return !!c && this.set.has(c);
  }

  clear() {
    this.set.clear();
  }
}
