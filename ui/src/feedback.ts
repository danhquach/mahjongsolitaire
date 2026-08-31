// Gentle audio + haptics (issue #14, spec §7): "Audio and haptics
// independently toggleable; both default ON but gentle."
//
// Sound is synthesised with WebAudio rather than shipped as assets — three
// short soft tones need no atlas, no loader, and no sound designer, and they
// keep the §9 bundle budget untouched. Haptics are `navigator.vibrate`, which
// Android Chrome honours and iOS Safari does not implement at all; a missing
// API is simply no haptics, never an error.
//
// The gate is the interesting part and the tested part: `Feedback` reads the
// two toggles on every cue, so flipping one in the settings screen takes effect
// on the next tap with nothing to re-wire. The tone synthesis below it is thin
// browser glue, exercised by the playtest build rather than by unit tests.

import type { Settings } from './settings.js';

/** The moments the board gives feedback for. */
export type Cue = 'select' | 'match' | 'mismatch';

export interface CuePlayer {
  play(cue: Cue): void;
}

export type Vibrate = (pattern: number | readonly number[]) => void;

/**
 * Gentle by construction: sines only, ≤ 180ms, peak gain 0.06, and a short
 * attack/release envelope so nothing clicks. Match rises, mismatch falls.
 */
const TONES: Record<Cue, { readonly from: number; readonly to: number; readonly ms: number }> = {
  select: { from: 660, to: 660, ms: 70 },
  match: { from: 587, to: 880, ms: 180 },
  mismatch: { from: 320, to: 240, ms: 130 },
};

const PEAK_GAIN = 0.06;

/** Vibration lengths in ms — a tap-sized nudge, not a buzz (spec §7 "gentle"). */
const HAPTICS: Record<Cue, number | readonly number[]> = {
  select: 8,
  match: 14,
  mismatch: [10, 40, 10],
};

/**
 * WebAudio cue player. The AudioContext is created lazily on the first cue:
 * browsers refuse to start one before a user gesture, and a tap is always the
 * first cue. A context that will not start (or an unsupported browser) leaves
 * the game silent rather than broken.
 */
export function webAudioPlayer(): CuePlayer {
  const Ctor: typeof AudioContext | undefined =
    typeof AudioContext !== 'undefined' ? AudioContext : undefined;
  let ctx: AudioContext | null = null;

  return {
    play(cue: Cue): void {
      if (!Ctor) return;
      try {
        ctx ??= new Ctor();
        // Autoplay policy can leave a context suspended until a gesture.
        if (ctx.state === 'suspended') void ctx.resume();
        const { from, to, ms } = TONES[cue];
        const now = ctx.currentTime;
        const end = now + ms / 1000;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(from, now);
        if (to !== from) osc.frequency.linearRampToValueAtTime(to, end);
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(PEAK_GAIN, now + 0.012);
        gain.gain.linearRampToValueAtTime(0, end);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(end);
      } catch {
        // No audio this session; play carries on in silence.
      }
    },
  };
}

/** `navigator.vibrate` where it exists, undefined where it does not (iOS). */
export function navigatorVibrate(): Vibrate | undefined {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  if (!nav || typeof nav.vibrate !== 'function') return undefined;
  return (pattern) => {
    try {
      nav.vibrate(pattern as number | number[]);
    } catch {
      // Some browsers throw when the page is not visible; ignore.
    }
  };
}

/**
 * One cue, two independent channels. Each is emitted only while its own toggle
 * is on, so audio-off/haptics-on (and the reverse) both work — spec §7 wants
 * them independent, not two names for one switch.
 */
export class Feedback {
  constructor(
    private readonly settings: () => Settings,
    private readonly player: CuePlayer | undefined = undefined,
    private readonly vibrate: Vibrate | undefined = undefined,
  ) {}

  cue(cue: Cue): void {
    const { audio, haptics } = this.settings();
    if (audio) this.player?.play(cue);
    if (haptics) this.vibrate?.(HAPTICS[cue]);
  }
}
