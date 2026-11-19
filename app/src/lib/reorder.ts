import { reactive } from "vue";

/** Type MIME interne : un glisser venu d'ailleurs (fichier, texte d'une autre appli) est ignoré. */
const MIME = "application/x-myia-reorder";

/**
 * Nouvel ordre après avoir lâché `dragged` avant (ou après) `target`. Renvoie la liste inchangée si l'un des deux
 * est inconnu ou si c'est le même élément.
 */
export function moveId(ids: readonly string[], dragged: string, target: string, after: boolean): string[] {
  if (dragged === target || !ids.includes(dragged) || !ids.includes(target)) return [...ids];
  const out = ids.filter((id) => id !== dragged);
  const i = out.indexOf(target);
  out.splice(after ? i + 1 : i, 0, dragged);
  return out;
}

/**
 * Glisser-déposer pour réordonner une liste (ou une grille) d'éléments identifiés par un id.
 * `axis` : « y » pour une liste verticale (lâcher dans la moitié haute = avant), « x » pour une grille ou une rangée.
 * `group` sépare deux listes d'une même page : on ne lâche pas un agent dans la liste des équipes.
 * Usage : `<div v-for="a in list" v-bind="sortable.item(a.id)" :class="sortable.classes(a.id)">`.
 */
export function useSortable(opts: { group: string; axis: () => "x" | "y"; onReorder: (dragged: string, target: string, after: boolean) => void }) {
  const st = reactive({ dragging: "", over: "", after: false });

  const reset = () => Object.assign(st, { dragging: "", over: "", after: false });

  function item(id: string) {
    return {
      draggable: true,
      onDragstart(e: DragEvent) {
        e.dataTransfer?.setData(MIME, `${opts.group}:${id}`);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        // Après coup : Chromium annule le glisser si l'élément tiré change d'aspect pendant « dragstart ».
        setTimeout(() => (st.dragging = id));
      },
      onDragover(e: DragEvent) {
        if (!e.dataTransfer?.types.includes(MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        st.over = id;
        st.after = opts.axis() === "x" ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
      },
      onDragleave(e: DragEvent) {
        const to = e.relatedTarget as Node | null;
        if (st.over === id && !(to && (e.currentTarget as HTMLElement).contains(to))) st.over = "";
      },
      onDrop(e: DragEvent) {
        const data = e.dataTransfer?.getData(MIME) ?? "";
        e.preventDefault();
        const [group, dragged] = [data.slice(0, data.indexOf(":")), data.slice(data.indexOf(":") + 1)];
        const after = st.after;
        reset();
        if (group === opts.group && dragged && dragged !== id) opts.onReorder(dragged, id, after);
      },
      onDragend: reset,
    };
  }

  /** Classes d'affichage : l'élément tiré, et le repère d'insertion avant/après la cible survolée. */
  function classes(id: string) {
    const over = st.over === id && st.dragging && st.dragging !== id;
    return {
      "is-dragging": st.dragging === id,
      "drop-before": over && !st.after,
      "drop-after": over && st.after,
    };
  }

  return { state: st, item, classes };
}
