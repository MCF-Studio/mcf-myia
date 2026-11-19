/** Case de la vue grille des conversations : un ou plusieurs onglets, dont `active` est affiché. */
export interface GridCell {
  tabs: string[];
  active: string;
}

/** Où lâcher un onglet : dans une case (en onglet), avant ou après une case (nouvelle case), ou à la fin de la grille. */
export type DropTarget = { cell: number; mode: "tab" | "before" | "after" } | { mode: "end" };

/**
 * Cases à afficher : celles enregistrées, réduites aux onglets encore ouverts (sans doublon), puis une case par
 * onglet ouvert qui n'est encore rangé nulle part (nouvelle conversation, nouvelle console).
 */
export function normalizeCells(saved: readonly GridCell[], open: readonly string[]): GridCell[] {
  const isOpen = new Set(open);
  const seen = new Set<string>();
  const out: GridCell[] = [];
  for (const c of saved) {
    const tabs = (Array.isArray(c?.tabs) ? c.tabs : []).filter((id) => typeof id === "string" && isOpen.has(id) && !seen.has(id));
    for (const id of tabs) seen.add(id);
    if (tabs.length) out.push({ tabs, active: tabs.includes(c.active) ? c.active : tabs[0]! });
  }
  for (const id of open) if (!seen.has(id)) out.push({ tabs: [id], active: id });
  return out;
}

/** Déplace l'onglet `id` vers `target`. Renvoie de nouvelles cases (les cases vidées disparaissent). */
export function moveTab(cells: readonly GridCell[], id: string, target: DropTarget): GridCell[] {
  const list = cells.map((c) => ({ tabs: [...c.tabs], active: c.active }));
  const dest = target.mode === "end" ? undefined : list[target.cell];
  if (target.mode !== "end" && !dest) return list;
  const from = list.find((c) => c.tabs.includes(id));
  if (!from) return list;
  // Lâché dans sa propre case, seul : rien à faire.
  if (dest === from && target.mode === "tab") {
    from.active = id;
    return list;
  }
  const i = from.tabs.indexOf(id);
  from.tabs.splice(i, 1);
  if (from.active === id) from.active = from.tabs[Math.max(0, i - 1)] ?? "";
  const single = { tabs: [id], active: id };
  if (target.mode === "end") list.push(single);
  else if (target.mode === "tab") {
    dest!.tabs.push(id);
    dest!.active = id;
  } else {
    const at = list.indexOf(dest!);
    list.splice(target.mode === "before" ? at : at + 1, 0, single);
  }
  return list.filter((c) => c.tabs.length);
}

/** Ordre à plat des onglets (pour la vue onglets) : celui de la grille. */
export function flatten(cells: readonly GridCell[]): string[] {
  return cells.flatMap((c) => c.tabs);
}
