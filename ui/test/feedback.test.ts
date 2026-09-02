// Issue #120: the win cue is one more entry in Feedback's two-channel gate —
// this proves it honours audio and haptics independently, the same contract
// select/match/mismatch already had (no dedicated test existed for that gate
// before now, so this covers all four cues rather than just the new one).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Feedback } from '../src/feedback.js';
import type { CuePlayer, Vibrate } from '../src/feedback.js';
import type { Settings } from '../src/settings.js';

const BASE: Settings = {
  audio: true,
  haptics: true,
  ads: false,
  highlightFree: false,
  tileSize: 'm',
  reducedMotion: false,
};

function spies(): {
  readonly player: CuePlayer;
  readonly vibrate: Vibrate;
  readonly played: string[];
  readonly vibrated: unknown[];
} {
  const played: string[] = [];
  const vibrated: unknown[] = [];
  return {
    player: { play: (cue) => played.push(cue) },
    vibrate: (pattern) => vibrated.push(pattern),
    played,
    vibrated,
  };
}

test('the win cue sounds and vibrates when both channels are on', () => {
  const { player, vibrate, played, vibrated } = spies();
  const feedback = new Feedback(() => BASE, player, vibrate);
  feedback.cue('win');
  assert.deepEqual(played, ['win']);
  assert.equal(vibrated.length, 1);
});

test('the win cue respects the audio toggle independently of haptics', () => {
  const { player, vibrate, played, vibrated } = spies();
  const feedback = new Feedback(() => ({ ...BASE, audio: false }), player, vibrate);
  feedback.cue('win');
  assert.deepEqual(played, [], 'muted, so nothing sounds');
  assert.equal(vibrated.length, 1, 'haptics still fire on their own toggle');
});

test('the win cue respects the haptics toggle independently of audio', () => {
  const { player, vibrate, played, vibrated } = spies();
  const feedback = new Feedback(() => ({ ...BASE, haptics: false }), player, vibrate);
  feedback.cue('win');
  assert.deepEqual(played, ['win'], 'audio still fires on its own toggle');
  assert.equal(vibrated.length, 0, 'no vibration pattern requested');
});

test('the win cue is silent on both channels when both toggles are off', () => {
  const { player, vibrate, played, vibrated } = spies();
  const feedback = new Feedback(() => ({ ...BASE, audio: false, haptics: false }), player, vibrate);
  feedback.cue('win');
  assert.deepEqual(played, []);
  assert.equal(vibrated.length, 0);
});

// Issue #121: the holder-full loss's 'fail' cue, same two-channel gate.

test('the fail cue sounds and vibrates when both channels are on', () => {
  const { player, vibrate, played, vibrated } = spies();
  const feedback = new Feedback(() => BASE, player, vibrate);
  feedback.cue('fail');
  assert.deepEqual(played, ['fail']);
  assert.equal(vibrated.length, 1);
});

test('the fail cue respects the audio toggle independently of haptics', () => {
  const { player, vibrate, played, vibrated } = spies();
  const feedback = new Feedback(() => ({ ...BASE, audio: false }), player, vibrate);
  feedback.cue('fail');
  assert.deepEqual(played, [], 'muted, so nothing sounds');
  assert.equal(vibrated.length, 1, 'haptics still fire on their own toggle');
});

test('the fail cue respects the haptics toggle independently of audio', () => {
  const { player, vibrate, played, vibrated } = spies();
  const feedback = new Feedback(() => ({ ...BASE, haptics: false }), player, vibrate);
  feedback.cue('fail');
  assert.deepEqual(played, ['fail'], 'audio still fires on its own toggle');
  assert.equal(vibrated.length, 0, 'no vibration pattern requested');
});

test('the fail cue is silent on both channels when both toggles are off', () => {
  const { player, vibrate, played, vibrated } = spies();
  const feedback = new Feedback(() => ({ ...BASE, audio: false, haptics: false }), player, vibrate);
  feedback.cue('fail');
  assert.deepEqual(played, []);
  assert.equal(vibrated.length, 0);
});
