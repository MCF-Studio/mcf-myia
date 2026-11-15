// Tests de l'arrêt de la lecture à voix haute. Lancés par `npm test` (node --test, types retirés par Node).
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { creerLecture, type Enonce, type MoteurVocal } from "./speech.ts";

interface FauxEnonce extends Enonce {
  texte: string;
}
const enonce = (texte: string): FauxEnonce => ({ texte, onend: null, onerror: null });
const signaler = (e: FauxEnonce, signal: "onend" | "onerror") => (e[signal] as (() => void) | null)?.();

/** Faux moteur : garde la file d'attente, comme la synthèse vocale du navigateur. */
function fauxMoteur() {
  const file: FauxEnonce[] = [];
  const moteur: MoteurVocal<FauxEnonce> = {
    speak: (e) => void file.push(e),
    cancel: () => void (file.length = 0),
  };
  return { file, moteur };
}

function banc() {
  const { file, moteur } = fauxMoteur();
  const etats: boolean[] = [];
  const lecture = creerLecture(moteur, (enCours) => etats.push(enCours));
  return { file, etats, lecture };
}

describe("lecture à voix haute", () => {
  it("une lecture lancée est en cours, puis s'éteint à la fin de l'énoncé", () => {
    const { file, etats, lecture } = banc();
    const a = enonce("bonjour");
    lecture.lire(a);
    assert.equal(lecture.enCours, true);
    assert.deepEqual(file, [a]);
    signaler(a, "onend");
    assert.equal(lecture.enCours, false);
    assert.deepEqual(etats, [true, false]);
  });

  it("arrêter coupe la voix et vide la file d'attente", () => {
    const { file, etats, lecture } = banc();
    lecture.lire(enonce("une longue réponse"));
    lecture.arreter();
    assert.equal(lecture.enCours, false);
    assert.deepEqual(file, []);
    assert.deepEqual(etats, [true, false]);
  });

  it("arrêter sans lecture en cours ne signale rien", () => {
    const { etats, lecture } = banc();
    lecture.arreter();
    assert.deepEqual(etats, []);
  });

  it("après un arrêt, une nouvelle lecture fonctionne normalement", () => {
    const { file, lecture } = banc();
    const a = enonce("première");
    lecture.lire(a);
    lecture.arreter();
    // Le navigateur signale la fin de l'énoncé annulé après coup : ça ne doit rien changer.
    signaler(a, "onerror");
    const b = enonce("seconde");
    lecture.lire(b);
    assert.equal(lecture.enCours, true);
    assert.deepEqual(file, [b]);
    signaler(b, "onend");
    assert.equal(lecture.enCours, false);
  });

  it("la fin tardive d'un énoncé remplacé n'éteint pas la lecture suivante", () => {
    const { file, etats, lecture } = banc();
    const a = enonce("première");
    const b = enonce("seconde");
    lecture.lire(a);
    lecture.lire(b);
    signaler(a, "onend");
    assert.equal(lecture.enCours, true);
    assert.deepEqual(file, [b]);
    assert.deepEqual(etats, [true]);
  });

  it("une erreur du moteur éteint la lecture", () => {
    const { lecture } = banc();
    const a = enonce("voix indisponible");
    lecture.lire(a);
    signaler(a, "onerror");
    assert.equal(lecture.enCours, false);
  });
});
