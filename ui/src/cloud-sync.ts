// The Cloud sync section of the Profile panel (issue #138), moved out of
// main.ts by issue #244: its elements, its credentials, its status line and
// its listeners live here. It is not a panel of its own — it sits inside the
// profile card — so it registers nothing with the stack; the profile panel
// asks it to mask the code on every open and to render on every fill.
//
// The rest of the game reaches sync only through the object this returns:
// the leaderboard and the account dialog read `credentials`, the win flow,
// the avatar pick and the shop call `push()`, the profile panel commits a
// name through `publishName()`. Nothing else here is reachable from outside,
// and what this section itself has to tell the rest of the game — that the
// record moved, that a restore renamed the player, that sync turned on or
// off — goes out through the callbacks main.ts hands in.
//
// The pure parts — the wire calls, the never-regress merge, the code and tag
// formats — stay in sync.ts, where their tests are.

import type { Announcer } from './a11y.js';
import { el } from './dom.js';
import type { ProfileStore, RecordStore } from './profile.js';
import type { KeyValueStorage } from './storage.js';
import {
  fetchProfile,
  forgetCredentials,
  formatCode,
  formatPlayerTag,
  normalizeCode,
  mergeRecords,
  pushName,
  pushRecord,
  readCredentials,
  registerProfile,
  writeCredentials,
} from './sync.js';
import type { RemoteProfile, SyncCredentials, SyncFailure } from './sync.js';

/** What the sync section is allowed to reach outside itself. */
export interface CloudSyncDeps {
  readonly storage: KeyValueStorage | undefined;
  readonly announcer: Pick<Announcer, 'say'>;
  readonly profile: ProfileStore;
  readonly record: RecordStore;
  /** The server's record has just been merged into the local one — after a
   *  push's reply, or a restore. Every screen that shows the record, or a
   *  look another device may have bought or picked, re-reads it here. */
  readonly onRecordAdopted: () => void;
  /** A restore has replaced the local name (only a restore does; a background
   *  sync never overwrites a rename made on this device). The profile panel's
   *  own name field shows the new one. */
  readonly onNameRestored: (name: string) => void;
  /** Sync turned on or off. The leaderboard opt-in is gated on it, and the
   *  panel is open at the time. */
  readonly onCredentialsChanged: () => void;
}

/** What main.ts, and the sections it wires, may ask of sync. */
export interface CloudSync {
  /** Null until the player turns sync on (or restores a profile with a code).
   *  Everything is inert while it is null — that is the default, and the game
   *  never waits on any of it. */
  readonly credentials: SyncCredentials | null;
  /** What a failure means to the player, in sync's own words. */
  failureText(reason: SyncFailure): string;
  /** Show the on/off half of the section and reflect the busy state. */
  render(): void;
  /** Mask the recovery code again — every open of the profile starts that
   *  way; it is the whole credential, and a profile screen is the kind of
   *  screen people screenshot. */
  maskCode(): void;
  /** Push the record up, if sync is on — after a win, an avatar pick, a
   *  purchase. Fire-and-forget by design: nothing waits on the network, and a
   *  failure is simply the next sync's problem. */
  push(): void;
  /** Publish a name the player just committed. Only ever called from the
   *  profile panel, so a screening refusal has somewhere to be shown. */
  publishName(name: string): Promise<void>;
}

/** Look up the section's elements, wire its controls, and hand back what the
 *  rest of the game may ask of it. */
export function mountCloudSync(deps: CloudSyncDeps): CloudSync {
  const { storage, announcer, profile, record, onRecordAdopted, onNameRestored, onCredentialsChanged } =
    deps;

  const syncOffBlock = el<HTMLDivElement>('sync-off');
  const syncOnBlock = el<HTMLDivElement>('sync-on');
  const syncRestoreForm = el<HTMLDivElement>('sync-restore-form');
  const syncCodeInput = el<HTMLInputElement>('sync-code-input');
  const syncEnableButton = el<HTMLButtonElement>('sync-enable');
  const syncRestoreButton = el<HTMLButtonElement>('sync-restore');
  const syncRestoreConfirm = el<HTMLButtonElement>('sync-restore-confirm');
  const syncRestoreCancel = el<HTMLButtonElement>('sync-restore-cancel');
  const syncRevealButton = el<HTMLButtonElement>('sync-reveal');
  const syncCopyButton = el<HTMLButtonElement>('sync-copy');
  const syncDisableButton = el<HTMLButtonElement>('sync-disable');
  const syncTag = el<HTMLElement>('sync-tag');
  const syncCodeValue = el<HTMLElement>('sync-code');
  const syncStatus = el<HTMLElement>('sync-status');

  /** Null until the player turns sync on (or restores a profile with a code).
   *  Everything below is inert while it is null — that is the default, and the
   *  game never waits on any of it. */
  let syncCredentials: SyncCredentials | null = readCredentials(storage);
  /** One request at a time from the panel: the controls disable while a call
   *  is in flight, so a double tap cannot register twice. */
  let syncBusy = false;
  /** The recovery code is masked until the player asks for it, and masked
   *  again every time the panel is reopened — it is the whole credential, and
   *  a profile screen is the kind of screen people screenshot. */
  let syncCodeShown = false;

  /** What each failure means to the player. Every one of them ends the same
   *  way — the local profile is untouched and the game plays on — so the
   *  wording never suggests progress was lost. */
  const SYNC_FAILURE_TEXT: Readonly<Record<SyncFailure, string>> = {
    offline: 'No connection. Your progress is safe on this device — try again later.',
    unavailable: 'Sync is unavailable right now. Your progress is safe on this device.',
    unauthorized: "That code doesn't match a profile. Check it and try again.",
    name_rejected: "That name can't be shown to other players — pick another one.",
    rate_limited: 'Too many attempts. Try again in a few minutes.',
  };

  function setSyncStatus(text: string): void {
    syncStatus.textContent = text;
  }

  /** Show the on/off half of the section and reflect the busy state. */
  function renderSyncSection(): void {
    const on = syncCredentials !== null;
    syncOffBlock.hidden = on;
    syncOnBlock.hidden = !on;
    if (on) {
      syncRestoreForm.hidden = true;
      syncTag.textContent = formatPlayerTag(syncCredentials!.playerId);
      syncCodeValue.textContent = syncCodeShown
        ? syncCredentials!.code
        : '•'.repeat(syncCredentials!.code.length);
      syncRevealButton.textContent = syncCodeShown ? 'Hide code' : 'Show code';
      syncRevealButton.setAttribute('aria-pressed', String(syncCodeShown));
    }
    for (const control of [
      syncEnableButton,
      syncRestoreButton,
      syncRestoreConfirm,
      syncRevealButton,
      syncCopyButton,
      syncDisableButton,
    ]) {
      control.disabled = syncBusy;
    }
  }

  /** Run one sync call with the panel's controls disabled around it. */
  async function withSyncBusy<T>(work: () => Promise<T>): Promise<T> {
    syncBusy = true;
    renderSyncSection();
    try {
      return await work();
    } finally {
      syncBusy = false;
      renderSyncSection();
    }
  }

  /** Take the server's record without ever losing what this device holds —
   *  the same never-regress merge the server just applied. The name and
   *  avatar are *not* adopted here: a background sync must never overwrite a
   *  rename made on this device (only a restore does, below). */
  function adoptRemoteRecord(remote: RemoteProfile): void {
    record.adopt(mergeRecords(record.value, remote.record));
    onRecordAdopted();
  }

  /** Push the record up, if sync is on. Fire-and-forget by design: nothing in
   *  the win flow waits on the network, and a failure is simply the next
   *  sync's problem. The avatar rides along — the sync route carries it. */
  function push(): void {
    if (syncCredentials === null) return;
    void pushRecord(syncCredentials, {
      avatar: profile.value.avatar,
      record: record.value,
    }).then((result) => {
      if (result.ok) adoptRemoteRecord(result.value);
    });
  }

  /** Publish a name the player just committed. Only ever called from the
   *  profile panel, so a screening refusal has somewhere to be shown. */
  async function publishName(name: string): Promise<void> {
    if (syncCredentials === null) return;
    const result = await pushName(syncCredentials, name);
    if (!result.ok) {
      setSyncStatus(SYNC_FAILURE_TEXT[result.reason]);
      return;
    }
    setSyncStatus('');
  }

  syncEnableButton.addEventListener('click', () => {
    void withSyncBusy(async () => {
      setSyncStatus('Turning on sync…');
      const result = await registerProfile({
        name: profile.value.name,
        avatar: profile.value.avatar,
        record: record.value,
      });
      if (!result.ok) {
        setSyncStatus(SYNC_FAILURE_TEXT[result.reason]);
        return;
      }
      syncCredentials = result.value.credentials;
      writeCredentials(storage, syncCredentials);
      // Shown straight away this once: the player has to be able to write it
      // down, and this is the moment they are being told to.
      syncCodeShown = true;
      renderSyncSection();
      // The leaderboard opt-in is gated on sync being on, so it has to be
      // re-rendered here too — the panel is already open.
      onCredentialsChanged();
      setSyncStatus('Sync is on. Write your recovery code down — it is the only way back.');
      announcer.say('Sync is on. Your recovery code is shown in your profile.');
    });
  });

  syncRestoreButton.addEventListener('click', () => {
    syncRestoreForm.hidden = false;
    setSyncStatus('');
    syncCodeInput.value = '';
    syncCodeInput.focus();
  });

  syncRestoreCancel.addEventListener('click', () => {
    syncRestoreForm.hidden = true;
    setSyncStatus('');
    syncRestoreButton.focus();
  });

  syncRestoreConfirm.addEventListener('click', () => {
    void withSyncBusy(async () => {
      setSyncStatus('Looking up your profile…');
      // Canonicalize before anything else: the server would normalize a typed
      // code anyway, but this is the form the panel stores and shows from now
      // on, and a code that is not a code is worth saying so without a round
      // trip.
      const normalized = normalizeCode(syncCodeInput.value);
      if (normalized === null) {
        setSyncStatus("That doesn't look like a recovery code — check it and try again.");
        return;
      }
      const code = formatCode(normalized);
      const found = await fetchProfile(code);
      if (!found.ok) {
        setSyncStatus(SYNC_FAILURE_TEXT[found.reason]);
        return;
      }
      // A restore *is* the case where the server's identity wins: this device
      // is being told who it is. The record still merges rather than
      // overwrites, so progress made here before restoring is not thrown away.
      const remote = found.value;
      syncCredentials = { playerId: remote.playerId, code };
      writeCredentials(storage, syncCredentials);
      onNameRestored(profile.setName(remote.name));
      // A no-op if the server holds an avatar this build does not ship (the
      // server stores the id opaquely, so a newer build's pick can come back
      // here). Keeping the local one is the right fallback — there is nothing
      // to draw for an id we do not know.
      profile.setAvatar(remote.avatar);
      // The restored record may pick a glyph set, a felt and a back (issue #229).
      adoptRemoteRecord(remote);
      setSyncStatus(`Profile restored — welcome back, ${remote.name}.`);
      announcer.say(`Profile restored. Welcome back, ${remote.name}.`);
      // Send this device's side up so the server holds the merge too.
      const pushed = await pushRecord(syncCredentials, {
        avatar: profile.value.avatar,
        record: record.value,
      });
      if (pushed.ok) adoptRemoteRecord(pushed.value);
    });
  });

  syncRevealButton.addEventListener('click', () => {
    syncCodeShown = !syncCodeShown;
    renderSyncSection();
    announcer.say(syncCodeShown ? 'Recovery code shown.' : 'Recovery code hidden.');
  });

  syncCopyButton.addEventListener('click', () => {
    if (syncCredentials === null) return;
    const code = syncCredentials.code;
    // The code is also selectable in place (`user-select: all`), which is the
    // fallback when the clipboard is unavailable — so say that rather than
    // leaving the player with nothing.
    const clipboard = navigator.clipboard;
    if (clipboard === undefined) {
      setSyncStatus('Copying is unavailable here — select the code above to copy it.');
      return;
    }
    void clipboard
      .writeText(code)
      .then(() => setSyncStatus('Recovery code copied.'))
      .catch(() => setSyncStatus('Copying failed — select the code above to copy it.'));
  });

  syncDisableButton.addEventListener('click', () => {
    forgetCredentials(storage);
    syncCredentials = null;
    renderSyncSection();
    onCredentialsChanged();
    setSyncStatus('Sync is off here. Your profile is still saved — enter your code to reconnect.');
    announcer.say('Sync turned off on this device.');
    syncEnableButton.focus();
  });

  return {
    get credentials() {
      return syncCredentials;
    },
    failureText: (reason) => SYNC_FAILURE_TEXT[reason],
    render: renderSyncSection,
    maskCode: () => {
      syncCodeShown = false;
    },
    push,
    publishName,
  };
}
