/**
 * Sound effects, synthesised with the Web Audio API: no audio files to load.
 * Every effect is a few oscillators or a burst of filtered noise.
 */
export type Sound = 'click' | 'order' | 'refuse' | 'build' | 'attack' | 'explosion' | 'hit' | 'nuke' | 'intercept' | 'landing' | 'alarm' | 'offer' | 'victory' | 'defeat';

const STORAGE_KEY = 'osm-front:volume';
/** The same effect is not started again within this many milliseconds: twenty explosions in one tick are one bang. */
const MIN_GAP_MS = 70;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
/** Where the effect being built right now sends its sound: the master, or a quieter tap on it. */
let bus: AudioNode | null = null;
let volume = Number(localStorage.getItem(STORAGE_KEY) ?? 0.6);
if (!(volume >= 0 && volume <= 1)) volume = 0.6;
const lastPlayed = new Map<Sound, number>();
/** What was played most recently, newest last - for the browser console and automated tests. */
export const played: Sound[] = [];

export const getVolume = () => volume;

/** Sets the master volume, 0 (silent) to 1, and remembers it. */
export function setVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
  if (master) master.gain.value = volume;
  try {
    localStorage.setItem(STORAGE_KEY, `${volume}`);
  } catch {
    // Storage disabled: the setting holds for this visit.
  }
}

// Browsers only let a page make sound after the user has touched it.
function unlock(): void {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
}
addEventListener('pointerdown', unlock, true);
addEventListener('keydown', unlock, true);

type Wave = OscillatorType;

/** One note: a frequency (optionally gliding to another), shaped by a quick attack and a decay to silence. */
function tone(at: number, from: number, to: number, seconds: number, wave: Wave, gain: number): void {
  const osc = ctx!.createOscillator();
  const amp = ctx!.createGain();
  osc.type = wave;
  osc.frequency.setValueAtTime(from, at);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, at + seconds);
  amp.gain.setValueAtTime(0.0001, at);
  amp.gain.exponentialRampToValueAtTime(gain, at + 0.01);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
  osc.connect(amp).connect(bus!);
  osc.start(at);
  osc.stop(at + seconds + 0.02);
}

let noiseBuffer: AudioBuffer | null = null;

/** A burst of noise through a low-pass filter that closes as it fades: thuds, blasts, rumble. */
function noise(at: number, seconds: number, from: number, to: number, gain: number): void {
  if (!noiseBuffer) {
    noiseBuffer = ctx!.createBuffer(1, ctx!.sampleRate * 2, ctx!.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const src = ctx!.createBufferSource();
  const filter = ctx!.createBiquadFilter();
  const amp = ctx!.createGain();
  src.buffer = noiseBuffer;
  src.loop = true;
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(from, at);
  filter.frequency.exponentialRampToValueAtTime(to, at + seconds);
  amp.gain.setValueAtTime(gain, at);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
  src.connect(filter).connect(amp).connect(bus!);
  src.start(at);
  src.stop(at + seconds + 0.02);
}

/** How each effect is put together; `t` is the moment it starts. */
const RECIPES: Record<Sound, (t: number) => void> = {
  click: (t) => tone(t, 1100, 900, 0.04, 'square', 0.08),
  order: (t) => {
    tone(t, 660, 660, 0.07, 'triangle', 0.2);
    tone(t + 0.07, 880, 880, 0.1, 'triangle', 0.2);
  },
  refuse: (t) => tone(t, 170, 120, 0.16, 'sawtooth', 0.16),
  build: (t) => {
    noise(t, 0.12, 900, 200, 0.5);
    tone(t, 240, 150, 0.18, 'triangle', 0.3);
    tone(t + 0.12, 520, 520, 0.08, 'triangle', 0.12);
  },
  attack: (t) => {
    // A horn call: two notes a fourth apart.
    for (const [dt, f] of [
      [0, 196],
      [0.16, 262],
    ]) {
      tone(t + dt, f, f, 0.28, 'sawtooth', 0.14);
      tone(t + dt, f * 1.5, f * 1.5, 0.28, 'triangle', 0.08);
    }
  },
  explosion: (t) => {
    noise(t, 0.7, 1800, 80, 0.9);
    tone(t, 110, 40, 0.5, 'sine', 0.5);
  },
  hit: (t) => noise(t, 0.2, 1400, 200, 0.4),
  nuke: (t) => {
    noise(t, 2.6, 3000, 40, 1);
    tone(t, 70, 28, 2.4, 'sine', 0.8);
    tone(t + 0.05, 180, 50, 1.2, 'sawtooth', 0.2);
  },
  intercept: (t) => {
    tone(t, 1700, 500, 0.18, 'square', 0.12);
    noise(t + 0.1, 0.25, 4000, 600, 0.35);
  },
  landing: (t) => {
    noise(t, 0.09, 500, 150, 0.6);
    noise(t + 0.14, 0.09, 500, 150, 0.6);
    noise(t + 0.28, 0.16, 700, 120, 0.7);
  },
  alarm: (t) => {
    for (let i = 0; i < 3; i++) {
      tone(t + i * 0.32, 880, 880, 0.15, 'square', 0.13);
      tone(t + i * 0.32 + 0.16, 660, 660, 0.15, 'square', 0.13);
    }
  },
  offer: (t) => {
    tone(t, 784, 784, 0.18, 'sine', 0.2);
    tone(t + 0.12, 988, 988, 0.3, 'sine', 0.2);
  },
  victory: (t) => [523, 659, 784, 1047].forEach((f, i) => tone(t + i * 0.14, f, f, i === 3 ? 0.7 : 0.2, 'triangle', 0.22)),
  defeat: (t) => [392, 349, 311, 196].forEach((f, i) => tone(t + i * 0.22, f, f, i === 3 ? 0.9 : 0.3, 'sawtooth', 0.14)),
};

/** Plays an effect, `loudness` 0 to 1 of the master volume. Silent until the user has interacted with the page. */
export function play(name: Sound, loudness = 1): void {
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? -Infinity) < MIN_GAP_MS) return;
  lastPlayed.set(name, now);
  played.push(name);
  if (played.length > 50) played.shift();
  if (!ctx || !master || ctx.state !== 'running' || volume === 0) return;
  bus = master;
  if (loudness < 1) {
    const quiet = ctx.createGain();
    quiet.gain.value = loudness;
    quiet.connect(master);
    bus = quiet;
  }
  RECIPES[name](ctx.currentTime + 0.01);
}
