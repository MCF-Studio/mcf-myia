import { reactive } from "vue";
import { call } from "./rpc";
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
  {
    id: "abysses",
    name: "Abysses",
    author: "MCF Studio",
    version: "1.0.0",
    mode: "dark",
    radius: "round",
    builtin: true,
    colors: {
      bg: "#060d10",
      "bg-elevated": "#0a1418",
      surface: "#0f1c21",
      "surface-2": "#15262c",
      border: "#1f363d",
      text: "#e3f4f4",
      "text-muted": "#86a6aa",
      accent: "#2dd4bf",
      "accent-2": "#38bdf8",
      "accent-contrast": "#03201c",
      glow: "rgba(45, 212, 191, 0.32)",
      success: "#4ade80",
      warning: "#fbbf24",
      danger: "#fb7185",
    },
  },
  {
    id: "neon-nuit",
    name: "Néon de nuit",
    author: "MCF Studio",
    version: "1.0.0",
    mode: "dark",
    radius: "sharp",
    builtin: true,
    colors: {
      bg: "#0c0814",
      "bg-elevated": "#120c1d",
      surface: "#190f27",
      "surface-2": "#221533",
      border: "#33204a",
      text: "#f3eaff",
      "text-muted": "#a593c0",
      accent: "#ff3ea5",
      "accent-2": "#a855f7",
      "accent-contrast": "#1a0010",
      glow: "rgba(255, 62, 165, 0.36)",
      success: "#34d399",
      warning: "#facc15",
      danger: "#ff5470",
    },
  },
  {
    id: "sauge",
    name: "Sauge (clair)",
    author: "MCF Studio",
    version: "1.0.0",
    mode: "light",
    radius: "round",
    builtin: true,
    colors: {
      bg: "#f1f4ee",
      "bg-elevated": "#f7f9f4",
      surface: "#ffffff",
      "surface-2": "#e9eee4",
      border: "#d3dccb",
      text: "#18211a",
      "text-muted": "#5c6b5f",
      accent: "#2f7a4a",
      "accent-2": "#b07a1f",
      "accent-contrast": "#ffffff",
      glow: "rgba(47, 122, 74, 0.2)",
      success: "#1f8a55",
      warning: "#b07a1f",
      danger: "#c8392f",
    },
  },
  {
    // Bleu nuit profond (fonds) et orange de métal en fusion (accent), avec un bleu vif en second accent.
    id: "fusion-nuit",
    name: "Fusion (orange et bleu nuit)",
    author: "MCF Studio",
    version: "1.0.0",
    mode: "dark",
    radius: "round",
    builtin: true,
    colors: {
      bg: "#060b1a",
      "bg-elevated": "#0a1124",
      surface: "#0e172f",
      "surface-2": "#142040",
      border: "#1f2d52",
      text: "#e8eeff",
      "text-muted": "#8a98bf",
      accent: "#ff6a1a",
      "accent-2": "#4f8cff",
      "accent-contrast": "#1a0a02",
      glow: "rgba(255, 106, 26, 0.35)",
      success: "#3ddc97",
      warning: "#ffc145",
      danger: "#ff4d6a",
    },
  },
  {
    // Clair doux : fond crème, panneaux blanc cassé (jamais de blanc pur), texte brun foncé plutôt que noir.
    id: "lin",
    name: "Lin (crème)",
    author: "MCF Studio",
    version: "1.0.0",
    mode: "light",
    radius: "round",
    builtin: true,
    colors: {
      bg: "#efe7d9",
      "bg-elevated": "#f4ede1",
      surface: "#f9f4ea",
      "surface-2": "#ece3d3",
      border: "#ddd0bc",
      text: "#3b3229",
      "text-muted": "#7a6c5c",
      accent: "#a55a2a",
      "accent-2": "#9a7d3a",
      "accent-contrast": "#fdf8ef",
      glow: "rgba(165, 90, 42, 0.16)",
      success: "#4d8358",
      warning: "#a87b22",
      danger: "#b4483a",
    },
  },
];

const RADIUS = { sharp: ["4px", "6px", "8px"], normal: ["8px", "12px", "18px"], round: ["12px", "18px", "26px"] };

/**
 * `panelOpacity` (0–100) : avec une image de fond, les panneaux (surface, surface-2) deviennent translucides
 * pour laisser voir l'image ; 100 = opaques (comportement sans image).
 */
export function applyTheme(t: Theme, opts: { glow: boolean; panelOpacity?: number }) {
  const root = document.documentElement;
  const alpha = Math.min(100, Math.max(0, opts.panelOpacity ?? 100));
  for (const [k, v] of Object.entries(t.colors)) {
    const translucent = alpha < 100 && (k === "surface" || k === "surface-2");
    root.style.setProperty(`--${k}`, translucent ? `color-mix(in srgb, ${v} ${alpha}%, transparent)` : v);
  }
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

/** Rôle de chaque couleur, écrit dans le modèle téléchargeable (clé `aide`, ignorée à l'installation). */
const TOKEN_HELP: Record<keyof Theme["colors"], string> = {
  bg: "fond de la fenêtre",
  "bg-elevated": "barre latérale, champs de saisie, fond des sélecteurs",
  surface: "cartes et panneaux",
  "surface-2": "panneaux en relief, bulles, bouton sélectionné",
  border: "bordures et séparateurs",
  text: "texte principal",
  "text-muted": "texte secondaire (indices, dates)",
  accent: "couleur principale : boutons, liens, élément actif",
  "accent-2": "seconde couleur des dégradés",
  "accent-contrast": "texte posé sur la couleur principale (bouton plein)",
  glow: "halo lumineux autour des éléments actifs (rgba conseillé, transparence 0.2 à 0.4)",
  success: "réussite",
  warning: "avertissement",
  danger: "erreur, suppression",
};

/**
 * Modèle de thème à télécharger : les couleurs du thème `base`, un id et un nom à changer, et une aide qui décrit
 * chaque couleur. On le modifie dans un éditeur, on l'essaie dans MyIA (aperçu en direct), puis on l'installe.
 */
export function themeTemplate(base: Theme): string {
  return JSON.stringify(
    {
      id: "mon-theme",
      name: "Mon thème",
      author: "",
      version: "1.0.0",
      mode: base.mode,
      radius: base.radius,
      colors: { ...base.colors },
      aide: {
        "à savoir":
          "Change id (minuscules, chiffres, tirets), name et les couleurs (#rrggbb, #rgb ou rgba(r, g, b, a)). mode : dark ou light. radius : sharp, normal ou round. Dans MyIA : Paramètres → Apparence → Essayer, puis garde le fichier ouvert : chaque enregistrement s'affiche aussitôt. Cette section « aide » est ignorée à l'installation.",
        ...TOKEN_HELP,
      },
    },
    null,
    2,
  );
}

/**
 * Thème en cours d'essai (aperçu) : prioritaire sur le thème choisi tant qu'il est là, jamais enregistré dans les
 * réglages. Le fichier est relu dès qu'il change sur le disque (modification dans un éditeur).
 */
export const themePreview = reactive({ theme: null as Theme | null, file: "", error: "", mtimeMs: 0 });

let previewTimer: ReturnType<typeof setInterval> | undefined;

async function readPreview(): Promise<void> {
  const file = themePreview.file;
  try {
    const res = await call<{ theme: Theme; mtimeMs: number }>("themes.readFile", { path: file }, 10_000);
    if (themePreview.file !== file) return;
    themePreview.theme = res.theme;
    themePreview.mtimeMs = res.mtimeMs;
    themePreview.error = "";
  } catch (e) {
    // Fichier en cours d'écriture ou faute de frappe : on garde le dernier aperçu valide et on montre l'erreur.
    if (themePreview.file === file) themePreview.error = String((e as Error).message ?? e);
  }
}

/** Essaie un fichier de thème : aperçu immédiat, puis relu à chaque enregistrement. */
export async function startThemePreview(file: string): Promise<void> {
  stopThemePreview();
  themePreview.file = file;
  await readPreview();
  if (!themePreview.theme) {
    const err = themePreview.error;
    stopThemePreview();
    throw new Error(err || "thème illisible");
  }
  previewTimer = setInterval(async () => {
    try {
      const m = await call<number>("themes.fileMtime", { path: themePreview.file }, 5000);
      if (m !== themePreview.mtimeMs) await readPreview();
    } catch (e) {
      themePreview.error = String((e as Error).message ?? e);
    }
  }, 1500);
}

export function stopThemePreview(): void {
  clearInterval(previewTimer);
  previewTimer = undefined;
  Object.assign(themePreview, { theme: null, file: "", error: "", mtimeMs: 0 });
}
