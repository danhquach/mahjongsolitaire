# 0020 — Feedback attachments ride the JSON payload as base64, capped by the mail provider

**Date:** 2026-09-02 · **Status:** accepted · **Ticket:** issue #130 (parent: #118, decision 0019)

## Context

Issue #130 lets a playtester attach up to three screenshots or a short screen
recording to a feedback report, so a visual bug can be seen rather than
described. The issue sketches multipart uploads, ~10 MB per image, ~50 MB per
video, delivery "inline for images, as an attachment or a download link for
video if the mail provider caps size", metadata stripped from images, and a
server-side size cap alongside the client one.

Three facts shaped what actually ships:

- **Resend caps a whole email at 40 MB *after* base64 encoding** (its
  attachments API takes `{ filename, content }` with `content` as a base64
  string). Base64 inflates by 4/3, so at most ~29 MB of raw file can ever be
  emailed, and a 50 MB video cannot. A "download link" path would need object
  storage (an R2 bucket bound to the Worker) that does not exist yet, and
  binding a missing bucket breaks `wrangler deploy` — so it would have to be
  provisioned by hand before the branch could merge.
- **The Worker's CPU budget is unknown.** Nobody is logged in to wrangler on
  the dev machine, so whether the account is on the free plan (10 ms CPU per
  request) or paid cannot be checked. Measured in Node (same V8): base64-
  encoding 28 MB in a JavaScript loop costs ~130 ms; `JSON.parse` of the same
  data as a 38 MB string costs ~15 ms, `JSON.stringify` ~8 ms, reading the body
  ~45 ms — all native, no per-byte JavaScript.
- **A cached bundle keeps posting the old shape.** A player with the pre-#130
  page open still sends the issue #118 JSON body after the Worker deploys.

## Decision

- **Attachments are base64-encoded on the client and sent inside the existing
  JSON body** as `attachments: [{ name, type, content }]`, optional and
  absent for a text-only report. Not multipart: the client does the one
  per-byte encode (`base64FromBytes`, ~130 ms for the largest allowed report,
  once, at Send), and the Worker only parses, checks sizes by arithmetic on
  the base64 length, and re-serialises for Resend. One content path serves
  both old and new clients.
- **Caps (client in `ui/src/feedback-form.ts`, backstop in
  `worker/index.mjs`, keep them in step):** 3 files; images ≤ 10 MB each;
  video ≤ 25 MB; ≤ 25 MB combined; a body with attachments ≤ 36 MB, a
  text-only body still ≤ 8 KB (issue #118). The video cap is the provider's
  40 MB envelope divided by 4/3 with headroom for the text — the issue's
  "~50 MB" is not reachable by email. The server answers `413
  attachment_too_large` for an over-cap file and `400 invalid_payload` for a
  wrong shape (a fourth file, a type off the allow-list, a name that is empty
  or over 200 characters, a base64 length that is not a multiple of 4).
- **Type allow-list.** Picker: PNG, JPEG, WebP, HEIC/HEIF, MP4, MOV, WebM
  (by MIME type, falling back to the extension only when the browser hands
  over an empty `type`, which desktop browsers do for HEIC). Server: PNG and
  JPEG images, MP4/MOV/WebM video — narrower than the picker because every
  image is re-encoded before it leaves the device (next point), so HEIC and
  WebP never arrive as such.
- **Images are redrawn through a canvas before sending**
  (`stripImageMetadata` in `ui/src/main.ts`): `createImageBitmap` with
  `imageOrientation: 'from-image'` bakes the EXIF rotation into the pixels,
  the bitmap is drawn to a canvas (scaled to fit 4096 px on the long edge), and
  `toBlob` produces a fresh PNG (for PNG sources — screenshots keep crisp UI
  text) or a JPEG at quality 0.92 (everything else). Only pixels cross;
  EXIF, GPS, and every other metadata block are gone. The filename's
  extension follows the new type (`IMG_0001.HEIC` → `IMG_0001.jpg`). A file
  the browser cannot decode (HEIC on Chrome, a corrupt file) is refused with
  "Couldn't read <name>". Size is checked twice: on the picked file (so a
  huge file is refused before any decode) and on the re-encoded result (the
  size that ships).
- **Video is passed through as picked.** The issue asks for metadata
  stripping on images; remuxing a video to drop its atoms is not something a
  browser does without a large library, and is out of scope.
- **Delivery is as email attachments, not inline images.** Resend's
  attachments are attachments; Gmail (the QA inbox) previews image
  attachments in the message anyway. A plain-text `Attachments: N — name
  (size), …` line is added to the email body so a report without its files
  is noticeable.
- **The `mailto:` fallback stays text-only.** When a send fails with files
  pending, the form keeps the text and the thumbnails, shows "Email it
  instead", and adds "Attachments couldn't be included — please reply to the
  email with them" (the wording the issue gives). The mailto body never
  carries attachment data.
- **Filenames are scrubbed server-side** (path separators, control
  characters → `_`; empty → `attachment`) so whatever a client sends is
  displayable and cannot look like a path in the mail client.

## Consequences

- **Free-plan risk, stated plainly:** if the Worker turns out to be on the free
  plan, a maximal 36 MB body costs roughly 70 ms of native CPU (read + parse +
  stringify) — over the 10 ms cap, and the request would fail with a
  Cloudflare 1102. Text-only reports and small screenshots (the common case,
  well under 1 MB) are unaffected. If large reports fail in the field, the
  choices are: upgrade the plan, or lower `MAX_TOTAL_ATTACHMENT_BYTES` /
  `MAX_VIDEO_BYTES` in both files. Neither the plan nor the failure mode can
  be checked without wrangler login.
- **Memory:** the Worker briefly holds the raw bytes, the decoded string, the
  parsed object and the outgoing JSON — up to ~4 × 36 MB if V8 collected
  nothing in between, against a 128 MB isolate. In practice the earlier
  buffers are unreferenced before the later ones are allocated, so GC has
  every chance; the 25 MB combined cap (not the 30 MB three images would
  otherwise allow) is the margin for this.
- **No base64 charset validation on the server.** Checking 33 MB of content
  against `[A-Za-z0-9+/=]` would be a per-byte scan for no security gain: the
  content goes into a JSON string for Resend, which rejects malformed base64
  itself (→ `502 provider_error`, and the client falls back to mailto).
- **Attachments are never logged** by the Worker — same rule as the text.
  Nothing in the report identifies the player beyond what they typed and
  attached; the profile name is still not part of the context block.
- **Larger video, or "inline" images with `cid:` references, are open
  follow-ups**, not partial implementations. Larger video needs R2 (a bucket,
  a binding, a signed-URL route, and an expiry policy); inline images need an
  HTML body and Resend's `content_id` field. Both are additive and do not
  change this payload shape.
- The QA harnesses cover the whole path in a real browser:
  `ui/qa/e2e-slice.mjs` pushes a JPEG with a spliced-in EXIF segment, an
  11 MB fake image, a text file and a fake MP4 through the picker, checks the
  refusals and thumbnails, then captures the POST body on a mocked 202 and
  asserts the JPEG left without its EXIF and the MP4 left byte-for-byte;
  `ui/qa/a11y-audit.mjs` checks the Add and Remove controls are named and
  ≥ 48dp.

## Update (2026-09-04, issue #191)

The 36 MB allowance is now open only to a request carrying the game's build
header (`X-Lantern-Tiles-Build`); without it the route keeps 0019's 8 KB cap,
decided before the body is read. See [0033](0033-api-limits.md), which also
tables every route's caps, limits and quotas.
