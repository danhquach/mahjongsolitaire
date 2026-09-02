// First-run tutorial step machine (issue #59): advance, skip, and the
// persistence hand-off to the `showTutorial` setting.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SETTINGS_STORAGE_KEY, SettingsStore, parseSettings } from '../src/settings.js';
import type { KeyValueStorage } from '../src/storage.js';
import { TUTORIAL_STEPS, Tutorial } from '../src/tutorial.js';
import type { TutorialEnd } from '../src/tutorial.js';

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

function recorder(): { ends: TutorialEnd[]; onEnd: (how: TutorialEnd) => void } {
  const ends: TutorialEnd[] = [];
  return { ends, onEnd: (how) => ends.push(how) };
}

// --- the steps ---------------------------------------------------------------

test('six PM-approved steps in order; only the match step highlights a pair', () => {
  assert.equal(TUTORIAL_STEPS.length, 6);
  assert.deepEqual(
    TUTORIAL_STEPS.map((s) => s.showPair === true),
    [false, false, true, false, false, false],
    'step 3 is the worked example',
  );
  assert.match(TUTORIAL_STEPS[0]!.body, /pairs/i, 'step 1: the goal');
  assert.match(TUTORIAL_STEPS[1]!.body, /free/i, 'step 2: free tiles');
  assert.match(TUTORIAL_STEPS[3]!.body, /Hint.*Undo.*Shuffle/, 'step 4: the three boosters');
  assert.match(TUTORIAL_STEPS[3]!.body, /charge/, 'step 4: each costs a charge');
  assert.match(TUTORIAL_STEPS[4]!.body, /holder/i, 'step 5: the holder');
  assert.match(TUTORIAL_STEPS[5]!.body, /score/i, 'step 6: one line on the score');
  assert.doesNotMatch(TUTORIAL_STEPS[5]!.body, /star/i, 'issue #119 removed stars');
  for (const step of TUTORIAL_STEPS) {
    assert.ok(step.title.length > 0 && step.body.length > 0);
  }
});

// --- advance -----------------------------------------------------------------

test('inactive until started; Next walks every step and finishes as done', () => {
  const { ends, onEnd } = recorder();
  const t = new Tutorial(onEnd);
  assert.equal(t.active, false);
  assert.equal(t.step, null);
  assert.equal(t.stepIndex, -1);

  t.start();
  assert.equal(t.active, true);
  assert.equal(t.stepIndex, 0);
  assert.equal(t.step, TUTORIAL_STEPS[0]);
  assert.equal(t.isLast, false);

  for (let i = 1; i < TUTORIAL_STEPS.length; i++) {
    t.next();
    assert.equal(t.stepIndex, i);
    assert.equal(t.step, TUTORIAL_STEPS[i]);
  }
  assert.equal(t.isLast, true, 'the last step reads Done');
  assert.deepEqual(ends, [], 'nothing ended yet');

  t.next(); // Done
  assert.equal(t.active, false);
  assert.equal(t.step, null);
  assert.deepEqual(ends, ['done']);
});

test('Next and Skip after the end are no-ops: onEnd fires once per run', () => {
  const { ends, onEnd } = recorder();
  const t = new Tutorial(onEnd);
  t.start();
  for (let i = 0; i < TUTORIAL_STEPS.length; i++) t.next();
  t.next();
  t.skip();
  assert.deepEqual(ends, ['done']);
  assert.equal(t.active, false);
});

// --- skip --------------------------------------------------------------------

test('Skip ends from any step, including the first and the last', () => {
  for (const at of [0, 2, TUTORIAL_STEPS.length - 1]) {
    const { ends, onEnd } = recorder();
    const t = new Tutorial(onEnd);
    t.start();
    for (let i = 0; i < at; i++) t.next();
    assert.equal(t.stepIndex, at);
    t.skip();
    assert.equal(t.active, false);
    assert.deepEqual(ends, ['skipped'], `skip from step ${at + 1}`);
  }
});

test('Next and Skip do nothing before start', () => {
  const { ends, onEnd } = recorder();
  const t = new Tutorial(onEnd);
  t.next();
  t.skip();
  assert.equal(t.active, false);
  assert.deepEqual(ends, []);
});

test('start() again restarts from step 1 (Settings → replay)', () => {
  const { ends, onEnd } = recorder();
  const t = new Tutorial(onEnd);
  t.start();
  t.next();
  t.next();
  t.skip();
  t.start();
  assert.equal(t.stepIndex, 0);
  assert.deepEqual(ends, ['skipped']);
});

// --- persistence -------------------------------------------------------------

test('showTutorial: ON on a fresh install, tolerant of an old record without it', () => {
  assert.equal(new SettingsStore().value.showTutorial, true);
  assert.equal(parseSettings({ audio: false }).showTutorial, true, 'a pre-#59 record arms it');
  assert.equal(parseSettings({ showTutorial: false }).showTutorial, false);
  assert.equal(parseSettings({ showTutorial: 'no' }).showTutorial, true, 'a non-boolean falls back');
});

test('completing or skipping writes showTutorial OFF through the settings store at once', () => {
  for (const how of ['done', 'skipped'] as const) {
    const storage = fakeStorage();
    const settings = new SettingsStore(storage);
    const t = new Tutorial(() => settings.set('showTutorial', false));
    t.start();
    if (how === 'done') for (let i = 0; i <= TUTORIAL_STEPS.length; i++) t.next();
    else t.skip();
    assert.equal(settings.value.showTutorial, false, how);
    const stored = JSON.parse(storage.data.get(SETTINGS_STORAGE_KEY)!) as Record<string, unknown>;
    assert.equal(stored['showTutorial'], false, `${how}: persisted, not just in memory`);
    // A reload reads it back OFF: no auto-start on the next level.
    assert.equal(new SettingsStore(storage).value.showTutorial, false);
  }
});
