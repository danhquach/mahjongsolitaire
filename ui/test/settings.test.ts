// Settings screen state (issue #14, spec §7): the defaults the spec mandates,
// per-change persistence, and per-field tolerance of a record we did not write.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Elapsed, formatElapsed } from '../src/elapsed.js';
import { Feedback } from '../src/feedback.js';
import type { Cue, CuePlayer } from '../src/feedback.js';
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  SettingsStore,
  TILE_SIZES,
  TILE_SIZE_FACTOR,
  parseSettings,
} from '../src/settings.js';
import type { Settings } from '../src/settings.js';
import type { KeyValueStorage } from '../src/storage.js';

function fakeStorage(seed: Record<string, string> = {}): KeyValueStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const stored = (storage: { data: Map<string, string> }): Record<string, unknown> =>
  JSON.parse(storage.data.get(SETTINGS_STORAGE_KEY)!);

// --- defaults -----------------------------------------------------------------

test('spec §7 defaults: audio and haptics ON, ads OFF, no timer setting at all', () => {
  const settings = new SettingsStore().value;
  assert.equal(settings.audio, true);
  assert.equal(settings.haptics, true);
  assert.equal('timedMode' in settings, false, 'spec §6: no timer — the toggle was retired 2026-09-01');
  assert.equal(settings.ads, false, 'decision 0004 / issue #3: ads default OFF');
  assert.equal(settings.tileSize, 'xl', 'spec §1.2/§7: oversized tiles by default');
});

test('tile size steps up monotonically and never exceeds the viewport fit', () => {
  const factors = TILE_SIZES.map((size) => TILE_SIZE_FACTOR[size]);
  assert.deepEqual(
    factors,
    [...factors].sort((a, b) => a - b),
    'S < M < L < XL',
  );
  assert.equal(Math.max(...factors), 1, 'XL is the fit itself — nothing is clipped');
  assert.ok(Math.min(...factors) > 0);
});

// --- persistence --------------------------------------------------------------

test('each change persists on its own, with no Save button in between', () => {
  const storage = fakeStorage();
  const store = new SettingsStore(storage);
  assert.equal(store.set('audio', false), true);
  assert.equal(stored(storage)['audio'], false);
  store.set('tileSize', 's');
  assert.equal(stored(storage)['tileSize'], 's');
  // Reopening the app sees exactly what was last written.
  assert.deepEqual(new SettingsStore(storage).value, {
    ...DEFAULT_SETTINGS,
    audio: false,
    tileSize: 's',
  });
});

test('setting a value it already has changes and writes nothing', () => {
  const storage = fakeStorage();
  const store = new SettingsStore(storage);
  assert.equal(store.set('haptics', true), false);
  assert.equal(storage.data.size, 0);
});

test('audio and haptics are independent, not two names for one switch', () => {
  const store = new SettingsStore(fakeStorage());
  store.set('audio', false);
  assert.equal(store.value.haptics, true);
  store.set('haptics', false);
  store.set('audio', true);
  assert.deepEqual(
    { audio: store.value.audio, haptics: store.value.haptics },
    { audio: true, haptics: false },
  );
});

test('write-blocked storage keeps the choice for the session', () => {
  const hostile: KeyValueStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => undefined,
  };
  const store = new SettingsStore(hostile);
  assert.doesNotThrow(() => store.set('highlightFree', true));
  assert.equal(store.value.highlightFree, true);
});

// --- tolerating a record we did not write -------------------------------------

test('a bad field falls back on its own; the rest of the record survives', () => {
  const settings: Settings = parseSettings({
    audio: 'yes', // wrong type
    haptics: false,
    tileSize: 'gigantic', // not a tile size
    highlightFree: true,
    timedMode: true, // a field this build no longer has (removed 2026-09-01): ignored
    ads: false,
  });
  assert.equal(settings.audio, DEFAULT_SETTINGS.audio, 'bad boolean → its default');
  assert.equal(settings.tileSize, DEFAULT_SETTINGS.tileSize, 'unknown size → its default');
  assert.equal(settings.haptics, false, 'valid fields are kept');
  assert.equal(settings.highlightFree, true);
  assert.equal('timedMode' in settings, false, 'a retired field is not carried');
});

test('an absent, malformed, or non-object record starts from the defaults', () => {
  for (const record of [null, undefined, 42, 'settings', []]) {
    assert.deepEqual(parseSettings(record), DEFAULT_SETTINGS, `record: ${String(record)}`);
  }
  assert.deepEqual(new SettingsStore(fakeStorage({ [SETTINGS_STORAGE_KEY]: '{oops' })).value, DEFAULT_SETTINGS);
});

// --- the feedback gate (spec §7: independently toggleable) --------------------

function spyFeedback(settings: Settings) {
  const played: Cue[] = [];
  const vibrated: (number | readonly number[])[] = [];
  const player: CuePlayer = { play: (cue) => void played.push(cue) };
  let current = settings;
  return {
    played,
    vibrated,
    set: (next: Partial<Settings>) => void (current = { ...current, ...next }),
    feedback: new Feedback(
      () => current,
      player,
      (pattern) => void vibrated.push(pattern),
    ),
  };
}

test('both channels fire when both toggles are on', () => {
  const spy = spyFeedback(DEFAULT_SETTINGS);
  spy.feedback.cue('match');
  assert.deepEqual(spy.played, ['match']);
  assert.equal(spy.vibrated.length, 1);
});

test('each toggle silences only its own channel', () => {
  const spy = spyFeedback(DEFAULT_SETTINGS);
  spy.set({ audio: false });
  spy.feedback.cue('select');
  assert.deepEqual(spy.played, [], 'audio off: no sound');
  assert.equal(spy.vibrated.length, 1, 'haptics still on: still buzzes');

  spy.set({ audio: true, haptics: false });
  spy.feedback.cue('mismatch');
  assert.deepEqual(spy.played, ['mismatch'], 'audio back on');
  assert.equal(spy.vibrated.length, 1, 'haptics off: no new buzz');
});

test('toggles are read per cue, so a change lands on the very next tap', () => {
  const spy = spyFeedback({ ...DEFAULT_SETTINGS, audio: false });
  spy.feedback.cue('select');
  spy.set({ audio: true });
  spy.feedback.cue('select');
  assert.deepEqual(spy.played, ['select']);
});

test('a browser with no audio or no vibration API is silent, not broken', () => {
  const feedback = new Feedback(() => DEFAULT_SETTINGS);
  assert.doesNotThrow(() => feedback.cue('match'));
});

// --- elapsed clock ------------------------------------------------------------

test('elapsed counts up from the injected clock and banks on pause', () => {
  let now = 1000;
  const elapsed = new Elapsed(() => now);
  now = 3500;
  assert.equal(elapsed.ms, 2500);
  elapsed.pause();
  now = 99_000;
  assert.equal(elapsed.ms, 2500, 'a hidden page does not accrue time');
  elapsed.resume();
  now = 100_000;
  assert.equal(elapsed.ms, 3500);
});

test('pause and resume are idempotent', () => {
  let now = 0;
  const elapsed = new Elapsed(() => now);
  elapsed.pause();
  elapsed.pause();
  now = 5000;
  assert.equal(elapsed.ms, 0);
  assert.equal(elapsed.running, false);
  elapsed.resume();
  elapsed.resume();
  now = 6000;
  assert.equal(elapsed.ms, 1000);
});

test('reset resumes from a saved total — what a resume needs', () => {
  let now = 500;
  const elapsed = new Elapsed(() => now);
  elapsed.reset(91_400);
  now = 1500;
  assert.equal(elapsed.ms, 92_400);
  elapsed.reset();
  assert.equal(elapsed.ms, 0);
});

test('formatElapsed reads as a stopwatch, never a countdown (kept for the save/star clock)', () => {
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(9_000), '0:09');
  assert.equal(formatElapsed(91_400), '1:31');
  assert.equal(formatElapsed(600_000), '10:00');
  assert.equal(formatElapsed(3_661_000), '1:01:01');
  assert.equal(formatElapsed(-5), '0:00', 'never negative');
});

// --- reduced motion + split cue channels (issue #44) -------------------------

test('reduced motion defaults off and rejects a non-boolean stored value', () => {
  assert.equal(DEFAULT_SETTINGS.reducedMotion, false);
  assert.equal(parseSettings({}).reducedMotion, false);
  assert.equal(parseSettings({ reducedMotion: 'yes' }).reducedMotion, false);
  assert.equal(parseSettings({ reducedMotion: true }).reducedMotion, true);
});

test('a match can sound at the tap and buzz at the collision, 200ms apart', () => {
  const spy = spyFeedback(DEFAULT_SETTINGS);
  spy.feedback.sound('match');
  assert.deepEqual(spy.played, ['match'], 'the tap is answered audibly at once');
  assert.equal(spy.vibrated.length, 0, 'nothing physical until the tiles hit');
  spy.feedback.haptic('match');
  assert.equal(spy.vibrated.length, 1, 'the impact taps back');
  assert.deepEqual(spy.played, ['match'], 'and does not sound a second time');
});

test('each half of a split cue still reads its own toggle', () => {
  const spy = spyFeedback({ ...DEFAULT_SETTINGS, audio: false });
  spy.feedback.sound('match');
  spy.feedback.haptic('match');
  assert.deepEqual(spy.played, [], 'audio off: the match is silent');
  assert.equal(spy.vibrated.length, 1, 'haptics on: the impact still taps');

  spy.set({ audio: true, haptics: false });
  spy.feedback.sound('match');
  spy.feedback.haptic('match');
  assert.deepEqual(spy.played, ['match'], 'audio back on');
  assert.equal(spy.vibrated.length, 1, 'haptics off: no new buzz');
});
