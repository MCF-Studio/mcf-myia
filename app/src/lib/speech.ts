/**
 * Suivi de la lecture à voix haute : sait à tout moment si la voix parle, et l'arrête pour de bon.
 * Sans dépendance (ni Vue, ni réglages, ni navigateur) pour rester testable : voir speech.test.ts.
 */

/** Ce qu'on attend d'un énoncé : les signaux de fin de la synthèse vocale du navigateur. */
export interface Enonce {
  onend: ((...args: never[]) => unknown) | null;
  onerror: ((...args: never[]) => unknown) | null;
}

/** Ce qu'on attend du moteur : `speechSynthesis` dans l'app, un faux dans les tests. */
export interface MoteurVocal<E extends Enonce> {
  speak(enonce: E): void;
  /** Coupe le son tout de suite et vide la file d'attente du moteur. */
  cancel(): void;
}

export interface Lecture<E extends Enonce> {
  /** Remplace la lecture en cours par cet énoncé. */
  lire(enonce: E): void;
  /** Arrêt complet : plus de son, plus rien en attente. */
  arreter(): void;
  /** Vrai dès qu'une lecture est demandée, jusqu'à sa fin ou son arrêt. */
  readonly enCours: boolean;
}

export function creerLecture<E extends Enonce>(moteur: MoteurVocal<E>, surChangement: (enCours: boolean) => void): Lecture<E> {
  // L'énoncé en cours est gardé ici : sans référence, le navigateur peut le libérer et ne jamais signaler sa fin.
  let courant: E | undefined;

  function fixer(enonce: E | undefined) {
    const avant = courant !== undefined;
    courant = enonce;
    const apres = courant !== undefined;
    if (avant !== apres) surChangement(apres);
  }

  /** Fin d'un énoncé : ne compte que si c'est encore lui qu'on lit (un énoncé annulé signale sa fin en retard). */
  function terminer(enonce: E) {
    if (courant === enonce) fixer(undefined);
  }

  return {
    lire(enonce) {
      moteur.cancel();
      enonce.onend = () => terminer(enonce);
      enonce.onerror = () => terminer(enonce);
      fixer(enonce);
      moteur.speak(enonce);
    },
    arreter() {
      fixer(undefined);
      moteur.cancel();
    },
    get enCours() {
      return courant !== undefined;
    },
  };
}
