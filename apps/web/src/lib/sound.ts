/**
 * Original sound design (§62): a small synthesised audio engine built on the
 * Web Audio API — no external assets, restrained default volume, and separate
 * master / music / effects buses.
 *
 * The engine is deliberately layered:
 *   master → compressor → destination
 *   ├── effects bus → convolution reverb send
 *   └── music bus  → convolution reverb send + tempo-synced echo
 *
 * Music is a generated, evolving chord bed with pads, bass, plucked arps and
 * airy texture. It changes scene with the game (menu / table / climax) and
 * fades rather than cutting. Effects are layered transients, bodies and tails,
 * so card selects feel wooden, placements feel physical and sequences ring.
 */

export interface SoundSettings {
  master: number; // 0..1
  effects: number; // 0..1
  music: number; // 0..1
  haptics: boolean;
}

export type MusicScene = "menu" | "game" | "climax";
export type HapticKind =
  | "selection"
  | "light"
  | "medium"
  | "warning"
  | "success"
  | "victory";

const DEFAULTS: SoundSettings = {
  master: 0.6,
  effects: 0.8,
  music: 0.42,
  haptics: true,
};

interface AudioGraph {
  ctx: AudioContext;
  master: GainNode;
  effects: GainNode;
  music: GainNode;
}

let settings: SoundSettings = { ...DEFAULTS };
let context: AudioContext | null = null;
let graph: AudioGraph | null = null;
let noiseBuffer: AudioBuffer | null = null;
let musicEngine: MusicEngine | null = null;
let musicScene: MusicScene = "menu";

function ctx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!context) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
  }
  if (context.state === "suspended" && document.visibilityState !== "hidden") {
    void context.resume();
  }
  return context;
}

/** Build the persistent bus graph once. */
function ensureGraph(): AudioGraph | null {
  const audio = ctx();
  if (!audio) return null;
  if (graph) return graph;

  const master = audio.createGain();
  master.gain.value = settings.master;

  const compressor = audio.createDynamicsCompressor();
  compressor.threshold.value = -20;
  compressor.knee.value = 24;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.25;

  master.connect(compressor).connect(audio.destination);

  const effects = audio.createGain();
  effects.gain.value = settings.effects;
  effects.connect(master);

  const music = audio.createGain();
  music.gain.value = settings.music;
  music.connect(master);

  // Convolution reverb gives every cue a believable room tail. A gentle
  // low-pass on the return keeps the tail warm instead of glassy.
  const reverb = audio.createConvolver();
  reverb.buffer = createReverbImpulse(audio, 2.8, 2.2);
  const reverbTone = audio.createBiquadFilter();
  reverbTone.type = "lowpass";
  reverbTone.frequency.value = 5400;
  reverbTone.Q.value = 0.35;
  const reverbWet = audio.createGain();
  reverbWet.gain.value = 0.28;
  reverb.connect(reverbTone).connect(reverbWet).connect(master);

  const reverbSend = audio.createGain();
  reverbSend.gain.value = 1;
  reverbSend.connect(reverb);

  const effectsSend = audio.createGain();
  effectsSend.gain.value = 0.3;
  effects.connect(effectsSend).connect(reverbSend);

  const musicSend = audio.createGain();
  musicSend.gain.value = 0.3;
  music.connect(musicSend).connect(reverbSend);

  graph = { ctx: audio, master, effects, music };
  return graph;
}

function createReverbImpulse(
  audio: AudioContext,
  seconds: number,
  decay: number,
): AudioBuffer {
  const rate = audio.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const impulse = audio.createBuffer(2, length, rate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      const envelope = Math.pow(1 - index / length, decay);
      data[index] = (Math.random() * 2 - 1) * envelope;
    }
  }
  return impulse;
}

function getNoiseBuffer(audio: AudioContext): AudioBuffer {
  if (noiseBuffer) return noiseBuffer;
  const length = Math.floor(audio.sampleRate * 2);
  const buffer = audio.createBuffer(1, length, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < length; index += 1) {
    data[index] = Math.random() * 2 - 1;
  }
  noiseBuffer = buffer;
  return buffer;
}

function audible(): boolean {
  return (
    settings.master > 0 &&
    settings.effects > 0 &&
    (typeof document === "undefined" || document.visibilityState === "visible")
  );
}

function audibleMusic(): boolean {
  return (
    settings.master > 0 &&
    settings.music > 0 &&
    (typeof document === "undefined" || document.visibilityState === "visible")
  );
}

export function configureSound(next: Partial<SoundSettings>): void {
  settings = { ...settings, ...next };
  if (!graph || !context) return;
  const now = context.currentTime;
  graph.master.gain.setTargetAtTime(settings.master, now, 0.05);
  graph.effects.gain.setTargetAtTime(settings.effects, now, 0.05);
  graph.music.gain.setTargetAtTime(settings.music, now, 0.08);
}

export function getSoundSettings(): SoundSettings {
  return settings;
}

/* ==========================================================================
   SFX primitives
   ========================================================================== */

interface ToneOptions {
  frequency: number;
  type?: OscillatorType;
  start?: number;
  duration?: number;
  gain?: number;
  slideTo?: number;
  attack?: number;
  detune?: number;
  pan?: number;
  filter?: {
    type: BiquadFilterType;
    frequency: number;
    q?: number;
    sweepTo?: number;
  };
}

interface NoiseOptions {
  start?: number;
  duration?: number;
  gain?: number;
  filterType?: BiquadFilterType;
  frequency?: number;
  q?: number;
  sweepTo?: number;
  pan?: number;
}

function connectOutput(
  audio: AudioContext,
  node: AudioNode,
  pan: number,
  destination: AudioNode,
): void {
  if (Math.abs(pan) < 0.01) {
    node.connect(destination);
    return;
  }
  const panner = audio.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  node.connect(panner).connect(destination);
}

function tone(options: ToneOptions): void {
  const audio = ensureGraph();
  if (!audio || !audible()) return;

  const {
    frequency,
    type = "sine",
    duration = 0.2,
    gain = 0.1,
    slideTo,
    attack = 0.005,
    detune = 0,
    pan = 0,
    filter,
  } = options;
  const start = options.start ?? audio.ctx.currentTime;
  const peak = Math.max(0.0001, gain);

  const oscillator = audio.ctx.createOscillator();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(Math.max(20, frequency), start);
  if (slideTo !== undefined) {
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(20, slideTo),
      start + duration,
    );
  }
  oscillator.detune.value = detune;

  const envelope = audio.ctx.createGain();
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(
    peak,
    start + Math.max(0.001, attack),
  );
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  let tail: AudioNode = oscillator;
  if (filter) {
    const biquad = audio.ctx.createBiquadFilter();
    biquad.type = filter.type;
    biquad.frequency.setValueAtTime(
      Math.max(20, filter.frequency),
      start,
    );
    if (filter.sweepTo !== undefined) {
      biquad.frequency.exponentialRampToValueAtTime(
        Math.max(20, filter.sweepTo),
        start + duration,
      );
    }
    biquad.Q.value = filter.q ?? 0.7;
    oscillator.connect(biquad);
    tail = biquad;
  }

  tail.connect(envelope);
  connectOutput(audio.ctx, envelope, pan, audio.effects);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.05);
}

function noise(options: NoiseOptions = {}): void {
  const audio = ensureGraph();
  if (!audio || !audible()) return;

  const {
    duration = 0.2,
    gain = 0.05,
    filterType = "bandpass",
    frequency = 1200,
    q = 0.8,
    sweepTo,
    pan = 0,
  } = options;
  const start = options.start ?? audio.ctx.currentTime;
  const peak = Math.max(0.0001, gain);

  const source = audio.ctx.createBufferSource();
  source.buffer = getNoiseBuffer(audio.ctx);
  source.loop = true;

  const filter = audio.ctx.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.setValueAtTime(Math.max(20, frequency), start);
  if (sweepTo !== undefined) {
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(20, sweepTo),
      start + duration,
    );
  }
  filter.Q.value = q;

  const envelope = audio.ctx.createGain();
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(peak, start + 0.008);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  source.connect(filter).connect(envelope);
  connectOutput(audio.ctx, envelope, pan, audio.effects);
  source.start(start);
  source.stop(start + duration + 0.05);
}

function randomPan(amount = 0.18): number {
  return (Math.random() * 2 - 1) * amount;
}

/* ==========================================================================
   Composed effects
   ========================================================================== */

export const sounds = {
  /** Soft wooden tick + glassy ping when a card is picked up. */
  select(): void {
    const audio = ensureGraph();
    if (!audio || !audible()) return;
    const start = audio.ctx.currentTime;
    const pitch = 1 + (Math.random() - 0.5) * 0.07;
    // Paper friction as the card leaves the deck.
    noise({
      start,
      duration: 0.07,
      gain: 0.038,
      filterType: "highpass",
      frequency: 2400,
      q: 0.5,
      sweepTo: 3600,
    });
    // The wooden card edge clicking free.
    tone({
      frequency: 760 * pitch,
      type: "triangle",
      start,
      duration: 0.12,
      gain: 0.075,
      slideTo: 1160 * pitch,
      attack: 0.003,
      pan: randomPan(0.08),
    });
    tone({
      frequency: 1520 * pitch,
      type: "sine",
      start: start + 0.005,
      duration: 0.09,
      gain: 0.026,
      slideTo: 1740 * pitch,
      attack: 0.002,
      pan: randomPan(0.12),
    });
    // A short body under the tick so it is heard, not just clicked.
    tone({
      frequency: 320,
      type: "sine",
      start: start + 0.004,
      duration: 0.06,
      gain: 0.05,
      attack: 0.002,
    });
  },

  /** Physical marker drop: low body, mid knock and a bright transient. */
  place(): void {
    const audio = ensureGraph();
    if (!audio || !audible()) return;
    const start = audio.ctx.currentTime;
    const pitch = 1 + (Math.random() - 0.5) * 0.05;
    // Sub thump: the weight of the marker landing.
    tone({
      frequency: 168 * pitch,
      type: "sine",
      start,
      duration: 0.3,
      gain: 0.5,
      slideTo: 68,
      attack: 0.004,
    });
    // Body: the impact knock.
    tone({
      frequency: 82,
      type: "sine",
      start: start + 0.005,
      duration: 0.36,
      gain: 0.3,
      slideTo: 52,
      attack: 0.006,
    });
    // Keen edge: the transient click of the marker rim.
    noise({
      start,
      duration: 0.14,
      gain: 0.1,
      filterType: "bandpass",
      frequency: 520,
      q: 1.1,
      sweepTo: 180,
    });
    tone({
      frequency: 1240 * pitch,
      type: "triangle",
      start,
      duration: 0.05,
      gain: 0.055,
      slideTo: 900,
      attack: 0.001,
      pan: randomPan(0.1),
    });
    // Table resonance: the board ringing back under the impact.
    tone({
      frequency: 190,
      type: "triangle",
      start: start + 0.01,
      duration: 0.42,
      gain: 0.055,
      attack: 0.006,
      filter: { type: "lowpass", frequency: 900, q: 0.6 },
    });
    tone({
      frequency: 410,
      type: "sine",
      start: start + 0.012,
      duration: 0.3,
      gain: 0.028,
      attack: 0.004,
      pan: randomPan(0.3),
    });
  },

  /** One-eyed Jack: a descending, filtered "peel" as a marker is lifted. */
  remove(): void {
    const audio = ensureGraph();
    if (!audio || !audible()) return;
    const start = audio.ctx.currentTime;
    tone({
      frequency: 430,
      type: "sawtooth",
      start,
      duration: 0.3,
      gain: 0.12,
      slideTo: 118,
      attack: 0.006,
      filter: {
        type: "lowpass",
        frequency: 1700,
        q: 0.8,
        sweepTo: 460,
      },
    });
    // The marker lifting free off the board.
    noise({
      start,
      duration: 0.28,
      gain: 0.07,
      filterType: "bandpass",
      frequency: 1100,
      q: 0.7,
      sweepTo: 260,
    });
    // A soft low body so the peel has weight, not just a hiss.
    tone({
      frequency: 210,
      type: "sine",
      start: start + 0.01,
      duration: 0.24,
      gain: 0.06,
      slideTo: 140,
      attack: 0.005,
    });
  },

  /** Paper swish when a replacement card is drawn. */
  draw(): void {
    const audio = ensureGraph();
    if (!audio || !audible()) return;
    const start = audio.ctx.currentTime;
    noise({
      start,
      duration: 0.19,
      gain: 0.042,
      filterType: "bandpass",
      frequency: 1500,
      q: 0.75,
      sweepTo: 3300,
      pan: randomPan(0.14),
    });
    tone({
      frequency: 640,
      type: "triangle",
      start: start + 0.02,
      duration: 0.06,
      gain: 0.022,
      slideTo: 880,
      attack: 0.003,
    });
  },

  /** A five-line completion: rising bells over a warm low swell. */
  sequence(): void {
    const audio = ensureGraph();
    if (!audio || !audible()) return;
    const start = audio.ctx.currentTime;
    const notes = [659.25, 783.99, 1046.5, 1318.51];
    notes.forEach((frequency, index) => {
      const at = start + index * 0.09;
      // Bell body.
      tone({
        frequency,
        type: "sine",
        start: at,
        duration: 1.15,
        gain: 0.115,
        attack: 0.006,
        pan: (index - 1.5) * 0.16,
      });
      // Bell overtone.
      tone({
        frequency: frequency * 2,
        type: "triangle",
        start: at,
        duration: 0.6,
        gain: 0.032,
        attack: 0.003,
        pan: (index - 1.5) * 0.22,
      });
      // Glassy strike transient so each note reads as struck, not faded in.
      tone({
        frequency: frequency * 3,
        type: "sine",
        start: at,
        duration: 0.12,
        gain: 0.026,
        attack: 0.001,
        pan: (index - 1.5) * 0.2,
      });
    });
    // Warm low swell underneath — the "line locks in" body.
    tone({
      frequency: 164.81,
      type: "sine",
      start,
      duration: 1.7,
      gain: 0.1,
      attack: 0.02,
    });
    tone({
      frequency: 246.94,
      type: "triangle",
      start,
      duration: 1.2,
      gain: 0.035,
      attack: 0.03,
      pan: -0.2,
    });
    // Air shimmer sweeping up with the rising notes.
    noise({
      start,
      duration: 1,
      gain: 0.045,
      filterType: "highpass",
      frequency: 3200,
      q: 0.4,
      sweepTo: 6200,
    });
  },

  /** Two-note hand-off chime. */
  turn(): void {
    const audio = ensureGraph();
    if (!audio || !audible()) return;
    const start = audio.ctx.currentTime;
    [523.25, 659.25].forEach((frequency, index) => {
      tone({
        frequency,
        type: "triangle",
        start: start + index * 0.12,
        duration: 0.42,
        gain: 0.072,
        attack: 0.01,
        pan: index === 0 ? -0.12 : 0.12,
      });
      tone({
        frequency: frequency * 2,
        type: "sine",
        start: start + index * 0.12 + 0.005,
        duration: 0.22,
        gain: 0.022,
        attack: 0.002,
        pan: index === 0 ? -0.12 : 0.12,
      });
    });
  },

  /** Fresh deal: a soft riffle of cards and a warm rising swell. */
  deal(): void {
    const audio = ensureGraph();
    if (!audio || !audible()) return;
    const start = audio.ctx.currentTime;
    for (let index = 0; index < 7; index += 1) {
      noise({
        start: start + index * 0.045,
        duration: 0.07,
        gain: 0.02 + index * 0.001,
        filterType: "bandpass",
        frequency: 1500 + index * 210,
        q: 1.1,
        pan: (index / 6 - 0.5) * 0.5,
      });
    }
    [220, 329.63, 440, 659.25].forEach((frequency, index) => {
      tone({
        frequency,
        type: "triangle",
        start: start + 0.1 + index * 0.07,
        duration: 0.9,
        gain: 0.03,
        attack: 0.02,
        pan: (index - 1.5) * 0.16,
      });
    });
    noise({
      start: start + 0.08,
      duration: 0.7,
      gain: 0.018,
      filterType: "highpass",
      frequency: 3600,
      q: 0.4,
    });
  },

  /** Full fanfare: bell melody, brass-like pad and shimmering tail. */
  victory(): void {
    const audio = ensureGraph();
    if (!audio || !audible()) return;
    const start = audio.ctx.currentTime;
    const melody = [523.25, 659.25, 783.99, 1046.5, 1318.51];
    melody.forEach((frequency, index) => {
      const at = start + index * (index < 2 ? 0.12 : 0.1);
      tone({
        frequency,
        type: "triangle",
        start: at,
        duration: 1.4,
        gain: 0.11,
        attack: 0.008,
        pan: (index - 2) * 0.1,
      });
      tone({
        frequency: frequency * 2,
        type: "sine",
        start: at,
        duration: 0.75,
        gain: 0.034,
        attack: 0.004,
      });
      // Strike transient on each fanfare note.
      tone({
        frequency: frequency * 3,
        type: "sine",
        start: at,
        duration: 0.14,
        gain: 0.022,
        attack: 0.001,
        pan: (index - 2) * 0.08,
      });
    });
    // Brass-like swell, opening over its 2.6s so the chord blooms.
    [130.81, 196, 261.63, 329.63].forEach((frequency) => {
      tone({
        frequency,
        type: "sawtooth",
        start,
        duration: 2.8,
        gain: 0.042,
        attack: 0.15,
        filter: {
          type: "lowpass",
          frequency: 800,
          q: 0.6,
          sweepTo: 2600,
        },
      });
    });
    // Sub drop under the swell for weight.
    tone({
      frequency: 65.41,
      type: "sine",
      start: start + 0.05,
      duration: 1.8,
      gain: 0.13,
      attack: 0.03,
    });
    // Rising air sweep as the melody climbs.
    noise({
      start,
      duration: 1.8,
      gain: 0.04,
      filterType: "highpass",
      frequency: 2000,
      q: 0.4,
      sweepTo: 7000,
    });
  },

  /** Quiet, non-punishing invalid-action cue. */
  error(): void {
    const audio = ensureGraph();
    if (!audio || !audible()) return;
    const start = audio.ctx.currentTime;
    tone({
      frequency: 150,
      type: "square",
      start,
      duration: 0.2,
      gain: 0.055,
      slideTo: 100,
      attack: 0.004,
      filter: { type: "lowpass", frequency: 720, q: 0.8 },
    });
    tone({
      frequency: 104,
      type: "sawtooth",
      start: start + 0.02,
      duration: 0.22,
      gain: 0.04,
      slideTo: 82,
      attack: 0.004,
      filter: { type: "lowpass", frequency: 500, q: 0.7 },
    });
  },

  /** Dead-card exchange: a quick riffle of paper. */
  exchange(): void {
    const audio = ensureGraph();
    if (!audio || !audible()) return;
    const start = audio.ctx.currentTime;
    for (let index = 0; index < 3; index += 1) {
      noise({
        start: start + index * 0.06,
        duration: 0.1,
        gain: 0.048,
        filterType: "bandpass",
        frequency: 1800 + index * 500,
        q: 0.9,
        pan: (index - 1) * 0.22,
      });
    }
    tone({
      frequency: 520,
      type: "triangle",
      start: start + 0.18,
      duration: 0.1,
      gain: 0.025,
      slideTo: 760,
      attack: 0.003,
    });
  },

  /** Two-eyed Jack: a small magical shimmer. */
  jack(): void {
    const audio = ensureGraph();
    if (!audio || !audible()) return;
    const start = audio.ctx.currentTime;
    [880, 1174.66, 1567.98, 2093].forEach((frequency, index) => {
      // Bell body.
      tone({
        frequency,
        type: "sine",
        start: start + index * 0.045,
        duration: 0.6,
        gain: 0.06,
        attack: 0.003,
        pan: (index - 1.5) * 0.18,
      });
      // Overtone for the magical shimmer.
      tone({
        frequency: frequency * 1.5,
        type: "sine",
        start: start + index * 0.045 + 0.01,
        duration: 0.4,
        gain: 0.02,
        attack: 0.002,
        pan: (index - 1.5) * 0.2,
      });
    });
    noise({
      start,
      duration: 0.6,
      gain: 0.05,
      filterType: "highpass",
      frequency: 4200,
      q: 0.5,
      sweepTo: 6800,
    });
  },

  /** Turn-timer warning. */
  lowTime(): void {
    const audio = ensureGraph();
    if (!audio || !audible()) return;
    const start = audio.ctx.currentTime;
    tone({
      frequency: 880,
      type: "sine",
      start,
      duration: 0.09,
      gain: 0.04,
      attack: 0.002,
    });
    tone({
      frequency: 660,
      type: "sine",
      start: start + 0.16,
      duration: 0.11,
      gain: 0.032,
      attack: 0.002,
    });
  },

  /** Light UI confirmation. */
  ui(): void {
    const audio = ensureGraph();
    if (!audio || !audible()) return;
    tone({
      frequency: 980,
      type: "sine",
      start: audio.ctx.currentTime,
      duration: 0.05,
      gain: 0.02,
      slideTo: 1240,
      attack: 0.002,
    });
  },
};

/* ==========================================================================
   Adaptive music — ambient / cinematic score
   ==========================================================================

   A single long-form arc in A minor, ~2m40s per pass, written as eight
   two-bar chords. Every scene (lobby / table / final stretch) uses the same
   progression so a scene change never sounds like a key change — it only
   reveals more of the arrangement: more voices, faster pulse, brighter
   filters, more percussion.

   Six musical layers, each with its own bus so the mix can be rebalanced
   per scene with a crossfade:

     pad      — slow detuned pad cluster, the harmonic bed
     arp      — plucked arpeggio through a tempo-synced dotted-eighth echo
     bass     — sub sine + soft body, felt more than heard
     perc     — soft kick and brushed shaker, real rhythm without drums
     bell     — chord-tone bell motif, the melodic hook
     texture  — air / noise wash that slowly opens and closes

   Two additional musical devices make the loop feel alive rather than
   looped: a slow randomised "shimmer answer" every other chord, and a
   sub-octave drop under the fermata that ends each 8-chord pass.
   ========================================================================== */

interface Chord {
  /** Bass root, Hz. */
  readonly bass: number;
  /** Pad voicing, Hz — four to five notes spread across two octaves. */
  readonly pad: readonly number[];
  /** Chord tones visited by the arpeggio and bell motif, Hz. */
  readonly arp: readonly number[];
}

interface MotifNote {
  /** Beat offset inside the two-bar chord, 0..8. */
  readonly at: number;
  /** Index into the chord's arp tone list. */
  readonly tone: number;
}

interface SceneConfig {
  readonly tempo: number;
  readonly chords: readonly Chord[];
  /** 16-step on/off gate for the arpeggio. */
  readonly arpPattern: readonly number[];
  /** Order in which chord tones are visited. */
  readonly arpSequence: readonly number[];
  readonly arpOctave: number;
  readonly motif: readonly MotifNote[];
  /** Beat offsets for the soft kick. */
  readonly kick: readonly number[];
  /** Beat offsets for the brushed shaker. */
  readonly shaker: readonly number[];
  readonly padLevel: number;
  readonly arpLevel: number;
  readonly bassLevel: number;
  readonly percLevel: number;
  readonly bellLevel: number;
  readonly textureLevel: number;
  readonly delayLevel: number;
  /** Filter-brightness multiplier — the climax scene is audibly brighter. */
  readonly brightness: number;
  /** How much of the airy high shimmer is audible. */
  readonly shimmerLevel: number;
}

// Am — F — C — G — Dm — Am — F — E: a long, open loop of A minor that ends
// on the V so the next pass feels pulled back home rather than cut off.
const SCORE: readonly Chord[] = [
  {
    bass: 110,
    pad: [220, 261.63, 329.63, 493.88, 658.41],
    arp: [220, 261.63, 329.63, 493.88, 659.25, 880],
  },
  {
    bass: 87.31,
    pad: [174.61, 220, 261.63, 349.23, 523.25],
    arp: [174.61, 220, 261.63, 349.23, 440, 698.46],
  },
  {
    bass: 130.81,
    pad: [261.63, 329.63, 392, 523.25, 659.25],
    arp: [261.63, 329.63, 392, 493.88, 523.25, 783.99],
  },
  {
    bass: 98,
    pad: [196, 246.94, 293.66, 392, 587.33],
    arp: [196, 246.94, 293.66, 392, 493.88, 739.99],
  },
  {
    bass: 73.42,
    pad: [146.83, 174.61, 220, 293.66, 440],
    arp: [146.83, 174.61, 220, 261.63, 293.66, 587.33],
  },
  {
    bass: 110,
    pad: [220, 261.63, 329.63, 493.88, 658.41],
    arp: [220, 261.63, 329.63, 392, 440, 523.25, 659.25],
  },
  {
    bass: 87.31,
    pad: [174.61, 220, 261.63, 329.63, 523.25],
    arp: [174.61, 220, 261.63, 349.23, 440, 698.46],
  },
  {
    bass: 82.41,
    pad: [164.81, 207.65, 246.94, 329.63, 493.88],
    arp: [164.81, 207.65, 246.94, 329.63, 415.3, 493.88],
  },
];

const SCENE_CONFIG: Record<MusicScene, SceneConfig> = {
  // The lobby: slowest, no percussion, widest reverb, the full harmonic bed
  // barely moving. Spacious and curious.
  menu: {
    tempo: 62,
    chords: SCORE,
    arpPattern: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0],
    arpSequence: [0, 2, 4, 1, 3, 5, 2],
    arpOctave: 2,
    motif: [
      { at: 1, tone: 4 },
      { at: 3, tone: 2 },
      { at: 5.5, tone: 3 },
      { at: 7, tone: 5 },
    ],
    kick: [],
    shaker: [],
    padLevel: 1,
    arpLevel: 0.42,
    bassLevel: 0.5,
    percLevel: 0,
    bellLevel: 0.75,
    textureLevel: 0.8,
    delayLevel: 0.2,
    brightness: 0.82,
    shimmerLevel: 0.45,
  },
  // The table: a steady pulse arrives, the arp works harder, the bass gets a
  // body. Focused, forward-leaning, still calm.
  game: {
    tempo: 74,
    chords: SCORE,
    arpPattern: [1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1],
    arpSequence: [0, 1, 2, 3, 4, 5, 4, 3, 2, 1],
    arpOctave: 2,
    motif: [
      { at: 0.5, tone: 3 },
      { at: 2, tone: 2 },
      { at: 3.5, tone: 1 },
      { at: 5, tone: 4 },
      { at: 6.5, tone: 0 },
    ],
    kick: [0, 2.5, 4, 6.5],
    shaker: [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5],
    padLevel: 0.92,
    arpLevel: 0.95,
    bassLevel: 0.85,
    percLevel: 0.5,
    bellLevel: 0.62,
    textureLevel: 0.9,
    delayLevel: 0.24,
    brightness: 1,
    shimmerLevel: 0.6,
  },
  // One sequence from winning: fastest, densest kick, brighter filters, the
  // motif opens up into a real lead line.
  climax: {
    tempo: 92,
    chords: SCORE,
    arpPattern: [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1],
    arpSequence: [0, 1, 2, 3, 4, 5, 4, 3, 2, 1],
    arpOctave: 2,
    motif: [
      { at: 0.5, tone: 4 },
      { at: 1.5, tone: 3 },
      { at: 2.5, tone: 2 },
      { at: 3.5, tone: 5 },
      { at: 4.5, tone: 3 },
      { at: 6, tone: 4 },
    ],
    kick: [0, 2, 4, 6],
    shaker: [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5],
    padLevel: 1,
    arpLevel: 1.15,
    bassLevel: 1,
    percLevel: 0.9,
    bellLevel: 0.9,
    textureLevel: 1,
    delayLevel: 0.26,
    brightness: 1.28,
    shimmerLevel: 0.85,
  },
};

/** Gameplay events the score answers, so the music feels like it follows the
 *  table instead of looping beside it. */
export type MusicReaction = "select" | "place" | "sequence" | "turn";

/**
 * Schedules and performs the score. Nothing is pre-rendered: every voice is
 * synthesised a moment before it is heard (120ms lookahead, 1.6s horizon), so
 * scene changes can be crossfaded mid-performance.
 */
class MusicEngine {
  private readonly output: GainNode;
  private readonly shaper: WaveShaperNode;
  private readonly delay: DelayNode;
  private readonly delaySend: GainNode;
  private readonly buses: Record<
    "pad" | "arp" | "bass" | "perc" | "bell" | "texture",
    GainNode
  >;
  private timer: number | null = null;
  private nextAt: number;
  private step = 0;
  private scene: MusicScene;
  private stopped = false;
  /** Chord tones of the chord currently sounding, for reactive stingers. */
  private live: readonly number[] = [];

  constructor(
    private readonly audio: AudioContext,
    destination: AudioNode,
    scene: MusicScene,
  ) {
    this.scene = scene;
    this.output = audio.createGain();
    this.output.gain.value = 0;

    // Gentle saturation warms the pad cluster and glues the layers without
    // ever sounding distorted.
    this.shaper = audio.createWaveShaper();
    this.shaper.curve = makeSoftCurve(1.6);
    const shaperTone = audio.createBiquadFilter();
    shaperTone.type = "lowpass";
    shaperTone.frequency.value = 9000;
    this.output.connect(this.shaper).connect(shaperTone).connect(destination);

    // Tempo-synced dotted-eighth echo, retuned on every scene change so the
    // plucks and the bells always sit in the groove.
    this.delay = audio.createDelay(2);
    const feedback = audio.createGain();
    feedback.gain.value = 0.29;
    const damp = audio.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = 2400;
    this.delay.connect(damp).connect(feedback).connect(this.delay);
    this.delay.connect(this.output);

    this.delaySend = audio.createGain();
    this.delaySend.gain.value = 0.2;
    this.delaySend.connect(this.delay);

    this.buses = {
      pad: audio.createGain(),
      arp: audio.createGain(),
      bass: audio.createGain(),
      perc: audio.createGain(),
      bell: audio.createGain(),
      texture: audio.createGain(),
    };
    for (const bus of Object.values(this.buses)) bus.connect(this.output);

    this.applyMix(true);
    this.nextAt = audio.currentTime + 0.25;
  }

  start(): void {
    const now = this.audio.currentTime;
    this.output.gain.setValueAtTime(0, now);
    this.output.gain.linearRampToValueAtTime(1, now + 4);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.onVisibilityChange();
  }

  setScene(scene: MusicScene): void {
    if (scene === this.scene) return;
    this.scene = scene;
    // The current chord is already scheduled; start the new arrangement at
    // the next chord boundary so the crossfade lands on a musical seam.
    this.step = 0;
    this.applyMix(false);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    const now = this.audio.currentTime;
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.setTargetAtTime(0, now, 0.25);
    window.setTimeout(() => this.output.disconnect(), 2000);
  }

  /**
   * A backgrounded tab must not keep synthesising. The audio clock freezes
   * while suspended, so the already-scheduled lookahead resumes exactly
   * where it left off when the tab returns.
   */
  private readonly onVisibilityChange = (): void => {
    if (this.stopped) return;
    if (document.visibilityState === "hidden") {
      if (this.timer !== null) {
        window.clearInterval(this.timer);
        this.timer = null;
      }
      void this.audio.suspend().catch(() => {});
      return;
    }
    void this.audio.resume().catch(() => {});
    if (this.timer === null) {
      this.timer = window.setInterval(this.tick, 120);
      this.tick();
    }
  };

  /**
   * Answer a gameplay event. These are deliberately small — a musical nod,
   * never a stinger that fights the move it is describing.
   */
  react(event: MusicReaction): void {
    if (this.stopped || !this.live.length) return;
    const at = this.audio.currentTime + 0.01;
    const tones = this.live;

    if (event === "select") {
      // A single high breath against the current chord, placed random-panned
      // off to one side so it never sits on top of the action.
      const note = tones[Math.floor(Math.random() * tones.length)] ?? tones[0]!;
      this.bell(note * 4, at, 0.5, 0.3, (Math.random() * 2 - 1) * 0.8);
      return;
    }

    if (event === "place") {
      // A short ascending ripple inside the chord — confirmation that reads
      // as music, not as a UI blip.
      this.bell(tones[2] ?? tones[0]!, at, 0.75, 0.25, -0.25);
      this.bell(tones[3] ?? tones[0]!, at + 0.06, 0.6, 0.22, 0.28);
      return;
    }

    if (event === "turn") {
      // Two soft notes marking the hand-off.
      this.bell(tones[1] ?? tones[0]!, at, 0.55, 0.2, -0.1);
      this.bell(tones[4] ?? tones[0]!, at + 0.14, 0.45, 0.18, 0.12);
      return;
    }

    // sequence: the biggest answer — a rising five-note ripple with a long
    // tail through the echo, so a completed line lands with weight.
    tones.slice(0, 5).forEach((note, index) => {
      this.bell(note * 2, at + index * 0.075, 1.15, 0.6, (index - 2) * 0.14);
    });
  }

  private readonly tick = (): void => {
    if (this.stopped) return;
    const horizon = this.audio.currentTime + 1.6;
    let guard = 0;
    while (this.nextAt < horizon && guard < 12) {
      const config = SCENE_CONFIG[this.scene];
      const chord = config.chords[this.step % config.chords.length]!;
      this.scheduleChord(config, chord, this.step, this.nextAt);
      this.nextAt += this.chordDuration(config);
      this.step += 1;
      guard += 1;
    }
  };

  private chordDuration(config: SceneConfig): number {
    return (60 / config.tempo) * 8;
  }

  /** Crossfade the six layer buses and retune the echo for the new tempo. */
  private applyMix(immediate: boolean): void {
    const config = SCENE_CONFIG[this.scene];
    const now = this.audio.currentTime;
    const time = immediate ? 0.01 : 0.8;
    const set = (node: GainNode, value: number) => {
      if (immediate) node.gain.setValueAtTime(value, now);
      else node.gain.setTargetAtTime(value, now, time);
    };
    set(this.buses.pad, config.padLevel);
    set(this.buses.arp, config.arpLevel);
    set(this.buses.bass, config.bassLevel);
    set(this.buses.perc, config.percLevel);
    set(this.buses.bell, config.bellLevel);
    set(this.buses.texture, config.textureLevel);
    set(this.delaySend, config.delayLevel);
    this.delay.delayTime.setTargetAtTime(
      (60 / config.tempo) * 0.75,
      now,
      immediate ? 0.01 : 0.8,
    );
  }

  private scheduleChord(
    config: SceneConfig,
    chord: Chord,
    step: number,
    at: number,
  ): void {
    const beat = 60 / config.tempo;
    const duration = beat * 8;
    // Remember the sounding tones so reactive stingers play in key.
    this.live = chord.arp;

    chord.pad.forEach((note, index) => {
      this.pad(note, at, duration, index, config);
    });
    this.bass(chord.bass, at, duration);
    this.shimmer(at, duration, config);
    this.texture(at, duration, config);

    for (let index = 0; index < config.arpPattern.length; index += 1) {
      if (!config.arpPattern[index]) continue;
      const toneIndex =
        config.arpSequence[index % config.arpSequence.length] ?? 0;
      const note = chord.arp[toneIndex % chord.arp.length] ?? chord.bass;
      const offset = (index / config.arpPattern.length) * duration;
      this.pluck(
        note * config.arpOctave,
        at + offset + (Math.random() - 0.5) * 0.012,
        config,
      );
    }

    for (const motif of config.motif) {
      const note = chord.arp[motif.tone % chord.arp.length] ?? chord.bass;
      this.bell(note * 2, at + motif.at * beat);
    }

    for (const offset of config.kick) this.kick(at + offset * beat);
    for (const offset of config.shaker) this.shaker(at + offset * beat);

    // A quiet high answer every other chord keeps the loop from feeling
    // identical on every pass.
    if (step % 2 === 1) {
      const echo = chord.arp[(step + 2) % chord.arp.length] ?? chord.bass;
      this.bell(echo * 4, at + duration * 0.75, 0.55);
    }

    // The step that closes an 8-chord pass is the V chord: a sub-octave drop
    // far below the ear gives the loop its sense of arc and return.
    if (step % config.chords.length === config.chords.length - 1) {
      this.drop(chord.bass * 0.5, at + duration * 0.5, duration * 0.5);
    }
  }

  /** The pad: four detuned voices and a sine octave through a slow filter. */
  private pad(
    frequency: number,
    at: number,
    duration: number,
    index: number,
    config: SceneConfig,
  ): void {
    const audio = this.audio;
    const filter = audio.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.6;
    const base = 260 + index * 80;
    filter.frequency.setValueAtTime(base * config.brightness, at);
    filter.frequency.linearRampToValueAtTime(
      (base + 520) * config.brightness,
      at + duration * 0.38,
    );
    filter.frequency.linearRampToValueAtTime(
      (base + 240) * config.brightness,
      at + duration,
    );

    const envelope = audio.createGain();
    const peak = 0.03 * (index === 0 ? 1.2 : 1);
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.linearRampToValueAtTime(
      peak,
      at + Math.min(2.8, duration * 0.34),
    );
    envelope.gain.setValueAtTime(peak, at + duration * 0.72);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration + 0.35);

    const fundamental = audio.createOscillator();
    fundamental.type = "triangle";
    fundamental.frequency.value = frequency;
    fundamental.detune.value = -7 + index * 2;

    const saw = audio.createOscillator();
    saw.type = "sawtooth";
    saw.frequency.value = frequency;
    saw.detune.value = 7 - index * 2;
    const sawGain = audio.createGain();
    sawGain.gain.value = 0.14;

    const octave = audio.createOscillator();
    octave.type = "sine";
    octave.frequency.value = frequency * 2;
    octave.detune.value = 3;
    const octaveGain = audio.createGain();
    octaveGain.gain.value = 0.2;

    fundamental.connect(filter);
    saw.connect(sawGain).connect(filter);
    octave.connect(octaveGain).connect(filter);

    const panner = audio.createStereoPanner();
    panner.pan.value = (index - 1.5) * 0.26;
    filter.connect(envelope).connect(panner).connect(this.buses.pad);

    for (const oscillator of [fundamental, saw, octave]) {
      oscillator.start(at);
      oscillator.stop(at + duration + 0.5);
    }
  }

  /** Sub sine plus a soft triangle body — felt more than heard. */
  private bass(frequency: number, at: number, duration: number): void {
    const audio = this.audio;
    const envelope = audio.createGain();
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.linearRampToValueAtTime(0.11, at + 0.16);
    envelope.gain.setTargetAtTime(0.055, at + 0.2, 0.5);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration * 0.95);

    const filter = audio.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(240, at);
    filter.frequency.exponentialRampToValueAtTime(130, at + duration * 0.8);
    filter.Q.value = 0.7;

    const sub = audio.createOscillator();
    sub.type = "sine";
    sub.frequency.value = frequency;

    const body = audio.createOscillator();
    body.type = "triangle";
    body.frequency.value = frequency * 2;
    const bodyGain = audio.createGain();
    bodyGain.gain.value = 0.16;

    sub.connect(filter);
    body.connect(bodyGain).connect(filter);
    filter.connect(envelope).connect(this.buses.bass);

    sub.start(at);
    body.start(at);
    sub.stop(at + duration);
    body.stop(at + duration);
  }

  /** Plucked arpeggio voice, half of it feeding the tempo-synced echo. */
  private pluck(frequency: number, at: number, config: SceneConfig): void {
    const audio = this.audio;
    const oscillator = audio.createOscillator();
    oscillator.type = "triangle";
    oscillator.frequency.value = frequency;

    const overtone = audio.createOscillator();
    overtone.type = "sine";
    overtone.frequency.value = frequency * 2;
    const overtoneGain = audio.createGain();
    overtoneGain.gain.value = 0.18;

    const filter = audio.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(3200 * config.brightness, at);
    filter.frequency.exponentialRampToValueAtTime(900, at + 0.45);
    filter.Q.value = 0.9;

    const envelope = audio.createGain();
    const peak = 0.06 * (0.75 + Math.random() * 0.25);
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(peak, at + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.7);

    const panner = audio.createStereoPanner();
    panner.pan.value = (Math.random() * 2 - 1) * 0.42;

    oscillator.connect(filter);
    overtone.connect(overtoneGain).connect(filter);
    filter.connect(envelope).connect(panner);
    panner.connect(this.buses.arp);
    panner.connect(this.delaySend);

    oscillator.start(at);
    overtone.start(at);
    oscillator.stop(at + 0.75);
    overtone.stop(at + 0.75);
  }

  /** Chord-tone bell: the melodic hook of the score. */
  private bell(
    frequency: number,
    at: number,
    gainScale = 1,
    durationScale = 1,
    pan?: number,
  ): void {
    const audio = this.audio;
    const envelope = audio.createGain();
    const peak = 0.045 * gainScale;
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.linearRampToValueAtTime(peak, at + 0.02);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + 2.2 * durationScale);

    const fundamental = audio.createOscillator();
    fundamental.type = "sine";
    fundamental.frequency.value = frequency;

    const shimmer = audio.createOscillator();
    shimmer.type = "sine";
    shimmer.frequency.value = frequency * 2.01;
    const shimmerGain = audio.createGain();
    shimmerGain.gain.value = 0.22;

    let tail: AudioNode = envelope;
    if (pan !== undefined) {
      const panner = audio.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      envelope.connect(panner);
      tail = panner;
    }
    fundamental.connect(envelope);
    shimmer.connect(shimmerGain).connect(envelope);
    tail.connect(this.buses.bell);
    tail.connect(this.delaySend);

    fundamental.start(at);
    shimmer.start(at);
    fundamental.stop(at + 2.3 * durationScale);
    shimmer.stop(at + 2.3 * durationScale);
  }

  /** High airy shimmer: two sines far above the chord, slowly fading. */
  private shimmer(at: number, duration: number, config: SceneConfig): void {
    const audio = this.audio;
    for (const ratio of [4, 6]) {
      const oscillator = audio.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = 1046.5 * ratio;
      oscillator.detune.value = (Math.random() * 2 - 1) * 8;

      const envelope = audio.createGain();
      const peak =
        0.004 * config.shimmerLevel * (0.6 + Math.random() * 0.6);
      envelope.gain.setValueAtTime(0.0001, at);
      envelope.gain.linearRampToValueAtTime(peak, at + duration * 0.5);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);

      const panner = audio.createStereoPanner();
      panner.pan.value = (Math.random() * 2 - 1) * 0.7;

      oscillator.connect(envelope).connect(panner);
      panner.connect(this.buses.texture);
      oscillator.start(at);
      oscillator.stop(at + duration + 0.1);
    }
  }

  /** Air wash: band-passed noise that slowly opens across the chord. */
  private texture(at: number, duration: number, config: SceneConfig): void {
    const audio = this.audio;
    const source = audio.createBufferSource();
    source.buffer = getNoiseBuffer(audio);
    source.loop = true;

    const filter = audio.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(520, at);
    filter.frequency.linearRampToValueAtTime(
      1500 * config.brightness,
      at + duration * 0.55,
    );
    filter.Q.value = 0.4;

    const envelope = audio.createGain();
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.linearRampToValueAtTime(0.009, at + duration * 0.4);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    source.connect(filter).connect(envelope).connect(this.buses.texture);
    source.start(at);
    source.stop(at + duration + 0.05);
  }

  /** Sub-octave drop that closes an 8-chord pass — the sense of arc. */
  private drop(frequency: number, at: number, duration: number): void {
    const audio = this.audio;
    const oscillator = audio.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, at);

    const envelope = audio.createGain();
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.linearRampToValueAtTime(0.12, at + 0.25);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    const filter = audio.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 140;
    filter.Q.value = 1.4;

    oscillator.connect(filter).connect(envelope).connect(this.buses.bass);
    oscillator.start(at);
    oscillator.stop(at + duration + 0.1);
  }

  /** Soft kick: a low sine that drops in pitch. */
  private kick(at: number): void {
    const audio = this.audio;
    const oscillator = audio.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(115, at);
    oscillator.frequency.exponentialRampToValueAtTime(44, at + 0.16);

    const envelope = audio.createGain();
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(0.09, at + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);

    oscillator.connect(envelope).connect(this.buses.perc);
    oscillator.start(at);
    oscillator.stop(at + 0.25);
  }

  /** Brushed shaker: high-passed noise, randomly panned. */
  private shaker(at: number): void {
    const audio = this.audio;
    const source = audio.createBufferSource();
    source.buffer = getNoiseBuffer(audio);
    source.loop = true;

    const filter = audio.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 5200;
    filter.Q.value = 0.6;

    const envelope = audio.createGain();
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(0.014, at + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.055);

    const panner = audio.createStereoPanner();
    panner.pan.value = (Math.random() * 2 - 1) * 0.4;

    source
      .connect(filter)
      .connect(envelope)
      .connect(panner)
      .connect(this.buses.perc);
    source.start(at);
    source.stop(at + 0.07);
  }
}

/** Soft, warm saturation curve for the music bus. */
function makeSoftCurve(amount: number): Float32Array<ArrayBuffer> {
  const samples = 1024;
  // Allocate through an explicit ArrayBuffer so the curve is typed
  // Float32Array<ArrayBuffer> (what WaveShaperNode.curve wants).
  const curve = new Float32Array(new ArrayBuffer(samples * 4));
  for (let index = 0; index < samples; index += 1) {
    const x = (index / (samples - 1)) * 2 - 1;
    curve[index] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}

export function setMusicScene(scene: MusicScene): void {
  musicScene = scene;
  musicEngine?.setScene(scene);
}

/** Answer a gameplay event with a musical sting (§62). */
export function reactMusic(event: MusicReaction): void {
  musicEngine?.react(event);
}

export function startMusic(): void {
  if (!audibleMusic()) return;
  const audio = ensureGraph();
  if (!audio) return;
  if (musicEngine) return;
  musicEngine = new MusicEngine(audio.ctx, audio.music, musicScene);
  musicEngine.start();
}

export function stopMusic(): void {
  if (musicEngine) {
    musicEngine.stop();
    musicEngine = null;
  }
}

/* ==========================================================================
   Haptics (§63)
   ========================================================================== */

const HAPTIC_PATTERNS: Record<HapticKind, number | number[]> = {
  selection: 7,
  light: 10,
  medium: [14, 26, 18],
  warning: [22, 34, 22, 34, 26],
  success: [12, 26, 14, 26, 30],
  victory: [18, 34, 18, 34, 24, 34, 40],
};

/** Light haptic feedback where supported and enabled (§63). */
export function haptic(kind: HapticKind): void {
  if (!settings.haptics || typeof navigator === "undefined") return;
  if (!("vibrate" in navigator)) return;
  try {
    navigator.vibrate(HAPTIC_PATTERNS[kind]);
  } catch {
    // Ignore platforms that reject vibration.
  }
}
