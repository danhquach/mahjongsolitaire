// The Send feedback dialog's browser wiring (issues #118, #130, #135), moved
// out of main.ts by issue #244: its elements, its state, its listeners and
// its Panel declaration live here, and main.ts only says where in the stack
// it sits and what it may reach — the announcer, the ladder level for the
// report's context line, and the Settings dialog it steps aside from.
//
// The pure parts — payload shape, attachment caps, the mailto and report
// text — stay in feedback-form.ts, where their tests are.

import type { Announcer } from './a11y.js';
import { el } from './dom.js';
import {
  ATTACHMENT_ACCEPT,
  FEEDBACK_INBOX,
  MAX_ATTACHMENTS,
  buildFeedbackPayload,
  canSend as canSendFeedback,
  checkAttachment,
  copyText,
  encodeAttachments,
  feedbackSubject,
  feedbackText,
  reencodedName,
  refusalMessage,
  mailtoUrl,
  reportText,
  sendFeedback,
} from './feedback-form.js';
import type { Panel, PanelStack } from './panel.js';

/** What the feedback dialog is allowed to reach outside itself. */
export interface FeedbackPanelDeps {
  /** The stack it registers with; the call's position is its stacking order. */
  readonly panels: PanelStack;
  readonly announcer: Pick<Announcer, 'say'>;
  /** The dialog it replaces rather than stacks on (it opens from a Settings row). */
  readonly settingsDialog: Panel;
  /** Where focus goes back to on close. */
  readonly settingsButton: HTMLElement;
  /** The ladder level right now — the one line of game context the report
   *  carries (never the profile name). */
  readonly currentLevel: () => number;
  /** The build's version label, sent with every report. */
  readonly version: string;
}

/** Files picked for the current report (issue #130), in pick order. Images
 *  are already re-encoded (metadata stripped); `previewUrl` is an object
 *  URL revoked when the entry goes away. */
interface PendingAttachment {
  readonly id: number;
  readonly name: string;
  readonly type: string;
  readonly kind: 'image' | 'video';
  readonly blob: Blob;
  readonly size: number;
  readonly previewUrl: string;
}

/**
 * Look up the dialog's elements, wire its controls, and declare it on the
 * stack. Returns the Panel so the caller can open it from elsewhere if it
 * ever needs to; today only the Settings row does, and that listener is
 * attached here.
 */
export function mountFeedbackPanel(deps: FeedbackPanelDeps): Panel {
  const { panels, announcer, settingsDialog, settingsButton, currentLevel, version } = deps;

  const feedbackPanel = el<HTMLDivElement>('feedback');
  const feedbackButton = el<HTMLButtonElement>('btn-feedback');
  const feedbackSummaryInput = el<HTMLInputElement>('feedback-summary');
  const feedbackBodyInput = el<HTMLTextAreaElement>('feedback-body');
  const feedbackStatus = el<HTMLElement>('feedback-status');
  const feedbackSend = el<HTMLButtonElement>('feedback-send');
  const feedbackCancel = el<HTMLButtonElement>('feedback-cancel');
  const feedbackMailto = el<HTMLAnchorElement>('feedback-mailto');
  const feedbackMailtoNote = el<HTMLElement>('feedback-mailto-note');
  const feedbackInbox = el<HTMLParagraphElement>('feedback-inbox');
  const feedbackInboxAddress = el<HTMLElement>('feedback-inbox-address');
  const feedbackCopy = el<HTMLButtonElement>('feedback-copy');
  const feedbackCopyStatus = el<HTMLElement>('feedback-copy-status');
  const feedbackReportLabel = el<HTMLLabelElement>('feedback-report-label');
  const feedbackReport = el<HTMLTextAreaElement>('feedback-report');
  const feedbackAttachButton = el<HTMLButtonElement>('feedback-attach');
  const feedbackFileInput = el<HTMLInputElement>('feedback-file');
  const feedbackAttachmentList = el<HTMLUListElement>('feedback-attachments');
  const feedbackAttachStatus = el<HTMLElement>('feedback-attach-status');

  /** The success state's auto-close (issue #118); held so a Cancel-and-reopen
   *  inside that second cannot have a stale timer close the new dialog. */
  let feedbackCloseTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while a submit is in flight — Send stays disabled regardless of
   *  field content so a slow request cannot be fired twice (issue #118). */
  let feedbackSending = false;
  /** The report "Copy report" puts on the clipboard (issue #135): set by the
   *  failure path from the payload that was actually sent, cleared with the
   *  rest of the failure state. */
  let feedbackReportText: string | null = null;
  let feedbackAttachments: PendingAttachment[] = [];
  let nextAttachmentId = 1;
  /** True while a picked batch is being checked and re-encoded: Add and Send
   *  wait for it, so a second pick cannot interleave with the first and a
   *  Send cannot go out missing the file still on the canvas. */
  let feedbackPicking = false;

  const feedbackDialog = panels.add({
    name: 'feedback',
    element: feedbackPanel,
    replaces: () => settingsDialog,
    beforeOpen: () => {
      clearFeedbackCloseTimer();
      resetFeedbackStatus();
      updateFeedbackSendEnabled();
    },
    focusIn: () => feedbackSummaryInput.focus(),
    opener: () => settingsButton,
    announce: () => 'Send feedback.',
    // The typed fields are deliberately kept: Cancel, Escape and a backdrop
    // tap all leave whatever the player wrote for the rest of the session
    // (issue #118); only a successful send clears them. The auto-close timer
    // is dropped so a Cancel-and-reopen inside that second cannot have a
    // stale timer close the new dialog.
    beforeClose: () => clearFeedbackCloseTimer(),
  });

  /** The current level string sent as feedback context: the ladder level —
   *  never the profile name (no player-identifying data beyond what the
   *  player typed). */
  function currentLevelLabel(): string {
    return `Level ${currentLevel()}`;
  }

  /** Send is enabled once both fields have content, and only when nothing is
   *  already in flight (issue #118: no double-submit on a slow request). */
  function updateFeedbackSendEnabled(): void {
    feedbackSend.disabled =
      feedbackSending ||
      feedbackPicking ||
      !canSendFeedback(feedbackSummaryInput.value, feedbackBodyInput.value);
  }

  /** Clear the status line and hide the mailto fallback — the start of every
   *  open and every fresh submit attempt. */
  function resetFeedbackStatus(): void {
    feedbackStatus.textContent = '';
    feedbackStatus.className = '';
    feedbackMailto.hidden = true;
    feedbackMailtoNote.hidden = true;
    feedbackInbox.hidden = true;
    feedbackCopy.hidden = true;
    feedbackCopyStatus.textContent = '';
    feedbackReportLabel.hidden = true;
    feedbackReport.hidden = true;
    feedbackReport.value = '';
    feedbackReportText = null;
    feedbackAttachStatus.textContent = '';
  }

  /** Copy report (issue #135): the subject line plus the full email text, for
   *  a player whose mail handler silently does nothing. When the clipboard is
   *  missing or refuses, the same text is shown selected in a read-only field
   *  so it can still be copied by hand — never a "Copied" that didn't happen. */
  async function copyFeedbackReport(): Promise<void> {
    if (feedbackReportText === null) return;
    const text = feedbackReportText;
    const copied = await copyText(text, navigator.clipboard);
    if (copied) {
      feedbackCopyStatus.textContent = 'Copied';
      announcer.say('Copied.');
      return;
    }
    feedbackCopyStatus.textContent = "Couldn't copy — select the text below";
    feedbackReport.value = text;
    feedbackReportLabel.hidden = false;
    feedbackReport.hidden = false;
    feedbackReport.focus();
    // select() alone is unreliable on iOS WebKit; the explicit range is the
    // belt-and-braces version of the same thing.
    feedbackReport.select();
    feedbackReport.setSelectionRange(0, text.length);
    announcer.say("Couldn't copy. The report text is selected below.");
  }

  // --- attachments (issue #130) ------------------------------------------------

  /** Re-encode an image through a canvas so EXIF/location metadata never
   *  leaves the device — the pixels are redrawn, nothing else is carried over.
   *  `imageOrientation: 'from-image'` bakes the EXIF rotation into the pixels
   *  first, so the upright photo survives losing its orientation tag. PNG
   *  stays PNG (screenshots keep crisp UI text); everything else — JPEG, WebP,
   *  HEIC — becomes JPEG, which is also what makes HEIC deliverable to any
   *  mail client. Very large photos are scaled to fit 4096 px on the long
   *  edge: well under every browser's canvas limit and plenty for a bug. */
  async function stripImageMetadata(file: File): Promise<Blob> {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      const scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('no 2d context');
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92));
      if (blob === null) throw new Error('encode failed');
      return blob;
    } finally {
      bitmap.close();
    }
  }

  function setAttachStatus(message: string): void {
    feedbackAttachStatus.textContent = message;
    if (message !== '') announcer.say(message);
  }

  function updateAttachButton(): void {
    feedbackAttachButton.disabled =
      feedbackSending || feedbackPicking || feedbackAttachments.length >= MAX_ATTACHMENTS;
  }

  /** Rebuild the thumbnail strip from the list: one <li> per file with its
   *  preview, name, and a named Remove control (≥ 48dp, spec §7). */
  function renderAttachments(): void {
    feedbackAttachmentList.replaceChildren();
    for (const item of feedbackAttachments) {
      const li = document.createElement('li');
      const preview =
        item.kind === 'image'
          ? Object.assign(document.createElement('img'), { src: item.previewUrl, alt: '' })
          : Object.assign(document.createElement('video'), {
              src: item.previewUrl,
              muted: true,
              playsInline: true,
              preload: 'metadata',
            });
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = item.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.setAttribute('aria-label', `Remove ${item.name}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => removeAttachment(item.id));
      li.append(preview, name, remove);
      feedbackAttachmentList.append(li);
    }
    feedbackAttachmentList.hidden = feedbackAttachments.length === 0;
    updateAttachButton();
  }

  function removeAttachment(id: number): void {
    const item = feedbackAttachments.find((a) => a.id === id);
    if (item === undefined) return;
    URL.revokeObjectURL(item.previewUrl);
    feedbackAttachments = feedbackAttachments.filter((a) => a.id !== id);
    renderAttachments();
    announcer.say(`Removed ${item.name}.`);
    feedbackAttachButton.focus();
  }

  function clearAttachments(): void {
    for (const item of feedbackAttachments) URL.revokeObjectURL(item.previewUrl);
    feedbackAttachments = [];
    renderAttachments();
  }

  /** The picker returned: check each file against the caps (issue #130 — an
   *  over-limit file is refused with a short message, the rest of the form
   *  is untouched), strip image metadata, and add what survives. */
  async function addPickedFiles(files: readonly File[]): Promise<void> {
    if (feedbackPicking) return;
    feedbackPicking = true;
    updateAttachButton();
    updateFeedbackSendEnabled();
    try {
      await addPickedFilesInner(files);
    } finally {
      feedbackPicking = false;
      renderAttachments();
      updateFeedbackSendEnabled();
    }
  }

  async function addPickedFilesInner(files: readonly File[]): Promise<void> {
    setAttachStatus('');
    for (const file of files) {
      // Cheap check on the picked file first, so a huge file is refused
      // before anything tries to decode it.
      const pre = checkAttachment(feedbackAttachments, file);
      if (!pre.ok) {
        setAttachStatus(refusalMessage(pre.reason));
        continue;
      }
      let blob: Blob = file;
      let name = file.name;
      let type = file.type;
      if (pre.kind === 'image') {
        try {
          blob = await stripImageMetadata(file);
        } catch {
          setAttachStatus(`Couldn't read ${file.name}`);
          continue;
        }
        type = blob.type;
        name = reencodedName(file.name, type);
      }
      // The re-encoded size is the one that ships — check it again.
      const post = checkAttachment(feedbackAttachments, { name, type, size: blob.size });
      if (!post.ok) {
        setAttachStatus(refusalMessage(post.reason));
        continue;
      }
      feedbackAttachments = [
        ...feedbackAttachments,
        {
          id: nextAttachmentId++,
          name,
          type,
          kind: post.kind,
          blob,
          size: blob.size,
          previewUrl: URL.createObjectURL(blob),
        },
      ];
      announcer.say(`Attached ${name}.`);
    }
  }

  function clearFeedbackCloseTimer(): void {
    if (feedbackCloseTimer !== null) {
      clearTimeout(feedbackCloseTimer);
      feedbackCloseTimer = null;
    }
  }

  /** POST to the Worker endpoint (worker/index.mjs); on failure — network
   *  error or non-2xx — offer the mailto fallback so the feedback is never
   *  lost, with the typed text kept in the fields either way. */
  async function submitFeedback(): Promise<void> {
    if (feedbackSend.disabled) return;
    feedbackSending = true;
    updateFeedbackSendEnabled();
    updateAttachButton();
    resetFeedbackStatus();
    const payload = buildFeedbackPayload({
      summary: feedbackSummaryInput.value,
      body: feedbackBodyInput.value,
      version,
      level: currentLevelLabel(),
      ua: navigator.userAgent,
      date: new Date().toISOString(),
      attachments: await encodeAttachments(feedbackAttachments),
    });
    const result = await sendFeedback(payload, (input, init) => fetch(input, init));
    feedbackSending = false;
    updateAttachButton();
    if (result === 'sent') {
      feedbackStatus.textContent = 'Thanks, your feedback was sent';
      feedbackStatus.className = 'success';
      announcer.say('Thanks, your feedback was sent.');
      feedbackSummaryInput.value = '';
      feedbackBodyInput.value = '';
      clearAttachments();
      updateFeedbackSendEnabled();
      // Leave the confirmation up for a beat before closing, so it is
      // perceivable rather than an instant swap back to Settings.
      feedbackCloseTimer = setTimeout(() => {
        feedbackCloseTimer = null;
        feedbackDialog.close();
      }, 1000);
    } else {
      feedbackStatus.textContent = "Couldn't send, try again";
      feedbackStatus.className = 'error';
      announcer.say("Couldn't send. Try again, or email it instead.");
      feedbackMailto.href = mailtoUrl(
        FEEDBACK_INBOX,
        feedbackSubject(payload.summary),
        feedbackText(payload),
      );
      feedbackMailto.hidden = false;
      // Issue #135: the mailto handoff can be a silent no-op, so the address
      // is also shown as text and the report can be copied instead.
      feedbackInbox.hidden = false;
      feedbackCopy.hidden = false;
      feedbackReportText = reportText(feedbackSubject(payload.summary), feedbackText(payload));
      // A mailto: link cannot carry files (issue #130): the attachments stay
      // in the form, and the player is told to add them to the email.
      feedbackMailtoNote.hidden = feedbackAttachments.length === 0;
      updateFeedbackSendEnabled();
    }
  }

  feedbackButton.addEventListener('click', () => feedbackDialog.open());
  feedbackCancel.addEventListener('click', () => feedbackDialog.close());
  feedbackSend.addEventListener('click', () => void submitFeedback());
  // Issue #135: the inbox address is filled from the one constant so the
  // markup never carries a second copy of it.
  feedbackInboxAddress.textContent = FEEDBACK_INBOX;
  feedbackCopy.addEventListener('click', () => void copyFeedbackReport());
  // Attachments (issue #130): the visible button opens the (hidden) native
  // picker; the input is reset after each pick so choosing the same file
  // again still fires `change`.
  feedbackFileInput.accept = ATTACHMENT_ACCEPT;
  feedbackAttachButton.addEventListener('click', () => feedbackFileInput.click());
  feedbackFileInput.addEventListener('change', () => {
    const files = Array.from(feedbackFileInput.files ?? []);
    feedbackFileInput.value = '';
    void addPickedFiles(files);
  });
  feedbackSummaryInput.addEventListener('input', () => updateFeedbackSendEnabled());
  feedbackBodyInput.addEventListener('input', () => updateFeedbackSendEnabled());

  return feedbackDialog;
}
