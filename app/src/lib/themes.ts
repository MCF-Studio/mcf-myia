import type { Theme } from "./types";

/** Thèmes intégrés. « volcano » est le thème par défaut : sombre, lumières orange fusion → jaune foncé. */
export const BUILTIN_THEMES: Theme[] = [
  {
    id: "volcano",
    name: "Volcano",
    author: "MCF Studio",
    version: "1.0.0",
    mode: "dark",
    radius: "normal",
    builtin: true,
    colors: {
      bg: "#0d0b0a",
      "bg-elevated": "#131010",
      surface: "#1a1513",
      "surface-2": "#231c18",
      border: "#2f2621",
      text: "#f4ede8",
      "text-muted": "#a4958b",
      accent: "#ff7a1a",
      "accent-2": "#e0a412",
      "accent-contrast": "#1a0c03",
      glow: "rgba(255, 122, 26, 0.38)",
      success: "#45c98a",
      warning: "#e0a412",
      danger: "#ff5247",
    },
  },
  {
    id: "midnight",
    name: "Minuit braise",
    author: "MCF Studio",
    version: "1.0.0",
    mode: "dark",
    radius: "round",
    builtin: true,
    colors: {
      bg: "#0a0c11",
      "bg-elevated": "#0f121a",
      surface: "#151924",
      "surface-2": "#1c2130",
      border: "#272d3f",
      text: "#e9edf5",
      "text-muted": "#8e97ad",
      accent: "#ff8a3d",
      "accent-2": "#f5b942",
      "accent-contrast": "#1a0c03",
      glow: "rgba(255, 138, 61, 0.32)",
      success: "#4cc38a",
      warning: "#f5b942",
      danger: "#ff5c5c",
    },
  },
  {
    id: "ember-light",
    name: "Cendre (clair)",
    author: "MCF Studio",
    version: "1.0.0",
    mode: "light",
    radius: "normal",
    builtin: true,
    colors: {
      bg: "#f6f2ee",
      "bg-elevated": "#fbf8f5",
      surface: "#ffffff",
      "surface-2": "#f1ebe5",
      border: "#e2d8cf",
      text: "#1f1915",
      "text-muted": "#6f625a",
      accent: "#e8600c",
      "accent-2": "#b8860b",
      "accent-contrast": "#ffffff",
      glow: "rgba(232, 96, 12, 0.22)",
      success: "#1f9d63",
      warning: "#b8860b",
      danger: "#d93a30",
    },
  },
];

const RADIUS = { sharp: ["4px", "6px", "8px"], normal: ["8px", "12px", "18px"], round: ["12px", "18px", "26px"] };

export function applyTheme(t: Theme, opts: { glow: boolean }) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.colors)) root.style.setProperty(`--${k}`, v);
  const [sm, md, lg] = RADIUS[t.radius];
  root.style.setProperty("--radius-sm", sm!);
  root.style.setProperty("--radius", md!);
  root.style.setProperty("--radius-lg", lg!);
  root.dataset.mode = t.mode;
  root.dataset.glow = opts.glow ? "on" : "off";
  root.style.colorScheme = t.mode;
}

/** Exporte un thème au format partageable (même schéma que la validation côté sidecar). */
export function exportTheme(t: Theme): string {
  const { builtin: _b, ...rest } = t;
  return JSON.stringify(rest, null, 2);
}
