import MarkdownIt from "markdown-it";

/**
 * Rendu des réponses. html: false → tout HTML présent dans la réponse est échappé (une page web lue par l'agent
 * ne peut pas injecter de balise). Les liens sont ouverts par le navigateur système (opener), jamais dans l'app.
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: true });

const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  const href = String(tokens[idx]!.attrGet("href") ?? "");
  if (!/^https?:\/\//i.test(href)) tokens[idx]!.attrSet("href", "#");
  tokens[idx]!.attrSet("data-external", "1");
  tokens[idx]!.attrSet("rel", "noreferrer");
  return defaultLink(tokens, idx, opts, env, self);
};

export function renderMarkdown(text: string): string {
  return md.render(text);
}
