import { reactive } from "vue";
import { call } from "./rpc";
import { settings } from "./settings";

/**
 * Dictée : micro → WAV 16 kHz mono → whisper.cpp dans le cœur (local). Rien ne sort de la machine.
 * Un seul enregistrement à la fois dans toute l'app ; arrêt automatique après MAX_SECONDS.
 */

const MAX_SECONDS = 90;

export const dictation = reactive({
  /** Conversation (ou zone de saisie) qui enregistre en ce moment. */
  owner: "" as string,
  state: "idle" as "idle" | "recording" | "transcribing",
  seconds: 0,
  level: 0,
  ready: false,
});

let recorder: MediaRecorder | undefined;
let stream: MediaStream | undefined;
let chunks: Blob[] = [];
let tickTimer: ReturnType<typeof setInterval> | undefined;
/** Niveau maximal capté : sous le seuil, on considère que rien n'a été dit (évite les phrases fantômes de Whisper). */
let peakLevel = 0;
let meter: { ctx: AudioContext; raf: number } | undefined;
let finish: ((text: string) => void) | undefined;
let fail: ((e: Error) => void) | undefined;

export async function refreshDictation() {
  try {
    dictation.ready = (await call<{ ready: boolean }>("whisper.status", {}, 5000)).ready;
  } catch {
    dictation.ready = false;
  }
}

/** Démarre l'enregistrement ; la promesse rend le texte transcrit quand on appelle stopDictation(). */
export async function startDictation(owner: string): Promise<string> {
  if (dictation.state !== "idle") throw new Error("une dictée est déjà en cours");
  stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  chunks = [];
  peakLevel = 0;
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => void onStopped();
  recorder.start(250);
  dictation.owner = owner;
  dictation.state = "recording";
  dictation.seconds = 0;
  tickTimer = setInterval(() => {
    dictation.seconds++;
    if (dictation.seconds >= MAX_SECONDS) stopDictation();
  }, 1000);
  startMeter(stream);
  return new Promise<string>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
}

export function stopDictation() {
  if (dictation.state === "recording") recorder?.stop();
}

export function cancelDictation() {
  finish = undefined;
  fail = undefined;
  if (dictation.state === "recording") recorder?.stop();
}

function cleanup() {
  clearInterval(tickTimer);
  stream?.getTracks().forEach((t) => t.stop());
  if (meter) {
    cancelAnimationFrame(meter.raf);
    void meter.ctx.close();
    meter = undefined;
  }
  stream = undefined;
  recorder = undefined;
  dictation.level = 0;
}

/** Niveau du micro, pour l'animation du bouton. */
function startMeter(s: MediaStream) {
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(s).connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  const loop = () => {
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    dictation.level = Math.min(1, peak / 64);
    peakLevel = Math.max(peakLevel, dictation.level);
    meter!.raf = requestAnimationFrame(loop);
  };
  meter = { ctx, raf: requestAnimationFrame(loop) };
}

async function onStopped() {
  const done = finish;
  const failed = fail;
  finish = undefined;
  fail = undefined;
  cleanup();
  if (!done) {
    dictation.state = "idle";
    return;
  }
  if (peakLevel < 0.06) {
    dictation.state = "idle";
    dictation.owner = "";
    done("");
    return;
  }
  dictation.state = "transcribing";
  try {
    const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
    const wav = await toWav16kMono(blob);
    const { text } = await call<{ text: string }>("whisper.transcribe", {
      audio: base64(wav),
      language: settings.sound.dictationLang,
    });
    done(text);
  } catch (e) {
    failed?.(e as Error);
  } finally {
    dictation.state = "idle";
    dictation.owner = "";
  }
}

/** Décode l'enregistrement (webm/opus) et le rééchantillonne en PCM 16 bits, 16 kHz, mono. */
async function toWav16kMono(blob: Blob): Promise<Uint8Array> {
  const data = await blob.arrayBuffer();
  const decoded = await new AudioContext().decodeAudioData(data);
  const rate = 16000;
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const pcm = (await offline.startRendering()).getChannelData(0);

  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  out.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, 1, true); // mono
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  str(36, "data");
  out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]!));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
