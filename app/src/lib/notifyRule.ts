/**
 * Décide si une notification Windows doit partir pour un message d'agent.
 * Fonction pure, sans dépendance à Vue ni à Tauri : testée par `npm test` (notifyRule.test.ts).
 */

/** État réel de la fenêtre, relevé au moment où le message arrive. */
export interface WindowState {
  /** La fenêtre a le focus clavier (Tauri `isFocused()`, à défaut `document.hasFocus()`). */
  focused: boolean;
  /** La fenêtre est réduite dans la barre des tâches. */
  minimized: boolean;
  /** La fenêtre est affichée (ni cachée dans la zone de notification, ni page masquée). */
  visible: boolean;
}

/** Ce que l'utilisateur a sous les yeux dans l'app. */
export interface ScreenState {
  /** Page ouverte (« conversations », « agents », …). */
  view: string;
  /** Disposition de la page Conversations. */
  layout: "tabs" | "grid";
  /** Onglet actif (mode onglets). */
  activeTab: string;
  /** Conversations ouvertes (toutes affichées en mode grille). */
  openTabs: readonly string[];
}

export interface NotifySettings {
  /** Notifications du bureau activées. */
  desktop: boolean;
  /** « Seulement si la fenêtre n'est pas au premier plan ». */
  onlyWhenUnfocused: boolean;
}

/** La fenêtre est réellement au premier plan : visible, non réduite et avec le focus. */
export function isForeground(w: WindowState): boolean {
  return w.focused && w.visible && !w.minimized;
}

/** La conversation est affichée à l'écran (page Conversations, onglet actif ou case de la grille). */
export function isConversationShown(conversationId: string, s: ScreenState): boolean {
  if (s.view !== "conversations") return false;
  if (s.layout === "grid") return s.openTabs.includes(conversationId);
  return s.activeTab === conversationId;
}

/**
 * Faut-il envoyer la notification ?
 * - jamais si les notifications du bureau sont coupées ;
 * - jamais si la fenêtre est au premier plan ET que la conversation du message est affichée :
 *   l'utilisateur la voit déjà ;
 * - sinon comme avant : le réglage « seulement si la fenêtre n'est pas au premier plan » s'applique.
 */
export function shouldNotify(conversationId: string, w: WindowState, s: ScreenState, n: NotifySettings): boolean {
  if (!n.desktop) return false;
  const foreground = isForeground(w);
  if (foreground && isConversationShown(conversationId, s)) return false;
  if (n.onlyWhenUnfocused && foreground) return false;
  return true;
}
