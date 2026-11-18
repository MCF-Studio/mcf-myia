import { reactive } from "vue";
import { call, inTauri } from "./rpc";
import { settings } from "./settings";
import { creerLecture, type Lecture } from "./speech";

/**
 * Sons générés à la volée (Web Audio) : aucun fichier audio à télécharger, rien qui sorte de la machine.
 * Voix : voix neuronale locale (Piper, si installée et choisie) ou synthèse vocale du système (voix Windows).
 */

let ctx: AudioContext | undefined;
const audio = () => (ctx ??= new AudioContext());

/** listen / stop : début et fin d'écoute de la touche « parler à MASTER ». */
export type SoundKind = "reply" | "confirm" | "error" | "done" | "listen" | "stop";
export const SOUND_PACKS = {
  ember: "Braise (doux, chaud)",
  crystal: "Cristal (clair)",
  pulse: "Pulse (discret)",
} as const;
export type SoundPack = keyof typeof SOUND_PACKS;

const NOTES: Record<SoundPack, Record<SoundKind, number[]>> = {
  ember: { reply: [523.25, 783.99], confirm: [659.25, 659.25, 880], error: [311.13, 233.08], done: [523.25, 659.25, 783.99], listen: [587.33, 880], stop: [880, 587.33] },
  crystal: { reply: [1046.5, 1567.98], confirm: [1318.5, 1760], error: [622.25, 466.16], done: [1046.5, 1318.5, 1567.98], listen: [1174.66, 1760], stop: [1760, 1174.66] },
  pulse: { reply: [440], confirm: [440, 554.37], error: [220], done: [440, 659.25], listen: [440, 880], stop: [880, 440] },
};

export function playSound(kind: SoundKind, force = false) {
  const s = settings.sound;
  if (!force && !s.notifications) return;
  const vol = (s.master / 100) * (s.notifVolume / 100);
  if (vol <= 0) return;
  const a = audio();
  // Fenêtre cachée : WebView2 peut suspendre le contexte audio.
  if (a.state === "suspended") void a.resume();
  const notes = NOTES[s.notifSound as SoundPack]?.[kind] ?? NOTES.ember[kind];
  const wave: OscillatorType = s.notifSound === "pulse" ? "square" : s.notifSound === "crystal" ? "triangle" : "sine";
  let t = a.currentTime + 0.01;
  for (const f of notes) {
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = wave;
    osc.frequency.value = f;
    const peak = wave === "square" ? vol * 0.06 : vol * 0.22;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    osc.connect(gain).connect(a.destination);
    osc.start(t);
    osc.stop(t + 0.4);
    t += 0.11;
  }
}

/** Séquence de démarrage de l'onglet Jarvis : balayage montant puis accord, générés à la volée. */
export function playBoot() {
  const s = settings.sound;
  const vol = (s.master / 100) * (s.notifVolume / 100);
  if (vol <= 0) return;
  const a = audio();
  if (a.state === "suspended") void a.resume();
  const t0 = a.currentTime + 0.02;
  const sweep = a.createOscillator();
  const g = a.createGain();
  sweep.type = "sawtooth";
  sweep.frequency.setValueAtTime(80, t0);
  sweep.frequency.exponentialRampToValueAtTime(1200, t0 + 1.1);
  const filter = a.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(400, t0);
  filter.frequency.exponentialRampToValueAtTime(5000, t0 + 1.1);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol * 0.07, t0 + 0.3);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.3);
  sweep.connect(filter).connect(g).connect(a.destination);
  sweep.start(t0);
  sweep.stop(t0 + 1.35);
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
    const o = a.createOscillator();
    const og = a.createGain();
    const t = t0 + 1.15 + i * 0.07;
    o.type = "sine";
    o.frequency.value = f;
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(vol * 0.12, t + 0.02);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
    o.connect(og).connect(a.destination);
    o.start(t);
    o.stop(t + 1.25);
  });
}

export function voices(): SpeechSynthesisVoice[] {
  if (!("speechSynthesis" in window)) return [];
  return speechSynthesis.getVoices().sort((a, b) => Number(b.lang.startsWith("fr")) - Number(a.lang.startsWith("fr")));
}

/** Retire le Markdown et les liens pour une lecture à voix haute naturelle. */
function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (bloc de code) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "(lien)")
    .replace(/[*_#>|-]{1,3}/g, " ")
    .slice(0, 3000);
}

/** État de la lecture à voix haute, pour afficher le bouton « Arrêter la lecture » tant que la voix parle. */
export const speech = reactive({ speaking: false, /** Niveau de la voix Piper en cours (0..1), pour animer l'interface. */ level: 0 });

let lecture: Lecture<SpeechSynthesisUtterance> | undefined;
const lectureVocale = () =>
  (lecture ??= creerLecture<SpeechSynthesisUtterance>(speechSynthesis, (enCours) => (speech.speaking = enCours)));

// ─── voix neuronale (Piper, dans le cœur) ────────────────────────────────────

/** Voix Piper installée (rafraîchi par refreshPiper, au démarrage et après une installation). */
export const piper = reactive({ ready: false, voices: {} as Record<string, boolean> });

export async function refreshPiper() {
  if (!inTauri) return;
  try {
    const st = await call<{ ready: boolean; voices: Record<string, boolean> }>("piper.status", {}, 5000);
    piper.ready = st.ready;
    piper.voices = st.voices;
  } catch {
    piper.ready = false;
  }
}

/** Lecture Piper en cours : un numéro par demande (une demande remplacée ne joue jamais), la source audio, l'animation. */
let piperToken = 0;
let piperSource: AudioBufferSourceNode | undefined;
let piperRaf = 0;

function stopPiper() {
  piperToken++;
  cancelAnimationFrame(piperRaf);
  try {
    piperSource?.stop();
  } catch {
    /* déjà arrêtée */
  }
  piperSource = undefined;
  speech.level = 0;
}

const usePiper = () => settings.sound.voiceEngine === "piper" && piper.ready;

async function speakPiper(text: string) {
  stopPiper();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  const my = piperToken;
  const s = settings.sound;
  speech.speaking = true;
  try {
    const { audio: b64 } = await call<{ audio: string }>("piper.speak", { text, voice: s.piperVoice, rate: Math.min(2, Math.max(0.5, s.voiceRate)) }, 60_000);
    if (my !== piperToken) return;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const a = audio();
    if (a.state === "suspended") await a.resume();
    const buf = await a.decodeAudioData(bytes.buffer);
    if (my !== piperToken) return;
    const src = a.createBufferSource();
    src.buffer = buf;
    const gain = a.createGain();
    gain.gain.value = (s.master / 100) * (s.voiceVolume / 100);
    const analyser = a.createAnalyser();
    analyser.fftSize = 512;
    src.connect(gain).connect(analyser).connect(a.destination);
    const data = new Uint8Array(analyser.fftSize);
    const meter = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      speech.level = Math.min(1, peak / 48);
      piperRaf = requestAnimationFrame(meter);
    };
    src.onended = () => {
      if (my !== piperToken) return;
      cancelAnimationFrame(piperRaf);
      piperSource = undefined;
      speech.level = 0;
      speech.speaking = false;
    };
    piperSource = src;
    src.start();
    piperRaf = requestAnimationFrame(meter);
  } catch (e) {
    if (my !== piperToken) return;
    // Piper indisponible : on se rabat sur la voix du système plutôt que de rester muet.
    console.warn("voix Piper :", e);
    speech.speaking = false;
    speakSystem(text);
  }
}

export function speak(text: string, force = false) {
  const s = settings.sound;
  if (!force && !s.voice) return;
  if (usePiper()) return void speakPiper(speakable(text));
  speakSystem(text);
}

function speakSystem(text: string) {
  const s = settings.sound;
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(speakable(text));
  const v = voices().find((x) => x.voiceURI === s.voiceName) ?? voices().find((x) => x.lang.startsWith("fr"));
  if (v) u.voice = v;
  u.lang = v?.lang ?? "fr-FR";
  u.rate = s.voiceRate;
  u.pitch = s.voicePitch;
  u.volume = (s.master / 100) * (s.voiceVolume / 100);
  lectureVocale().lire(u);
}

/** Arrêt complet de la lecture : le son s'arrête tout de suite et plus rien n'attend derrière. */
export function stopSpeaking() {
  stopPiper();
  speech.speaking = false;
  if ("speechSynthesis" in window) lectureVocale().arreter();
}
