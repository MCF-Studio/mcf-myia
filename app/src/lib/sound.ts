import { settings } from "./settings";

/**
 * Sons générés à la volée (Web Audio) : aucun fichier audio à télécharger, rien qui sorte de la machine.
 * Voix : synthèse vocale du système (voix Windows installées) en attendant Piper en local (SPEC §7).
 */

let ctx: AudioContext | undefined;
const audio = () => (ctx ??= new AudioContext());

export type SoundKind = "reply" | "confirm" | "error" | "done";
export const SOUND_PACKS = {
  ember: "Braise (doux, chaud)",
  crystal: "Cristal (clair)",
  pulse: "Pulse (discret)",
} as const;
export type SoundPack = keyof typeof SOUND_PACKS;

const NOTES: Record<SoundPack, Record<SoundKind, number[]>> = {
  ember: { reply: [523.25, 783.99], confirm: [659.25, 659.25, 880], error: [311.13, 233.08], done: [523.25, 659.25, 783.99] },
  crystal: { reply: [1046.5, 1567.98], confirm: [1318.5, 1760], error: [622.25, 466.16], done: [1046.5, 1318.5, 1567.98] },
  pulse: { reply: [440], confirm: [440, 554.37], error: [220], done: [440, 659.25] },
};

export function playSound(kind: SoundKind, force = false) {
  const s = settings.sound;
  if (!force && !s.notifications) return;
  const vol = (s.master / 100) * (s.notifVolume / 100);
  if (vol <= 0) return;
  const a = audio();
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

export function speak(text: string, force = false) {
  const s = settings.sound;
  if ((!force && !s.voice) || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(speakable(text));
  const v = voices().find((x) => x.voiceURI === s.voiceName) ?? voices().find((x) => x.lang.startsWith("fr"));
  if (v) u.voice = v;
  u.lang = v?.lang ?? "fr-FR";
  u.rate = s.voiceRate;
  u.pitch = s.voicePitch;
  u.volume = (s.master / 100) * (s.voiceVolume / 100);
  speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}
