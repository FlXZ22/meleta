# Maleta — Project Context

> This document is the shared product context for Maleta. Read it before planning or changing the project. For every visual or interaction design decision, `DESIGN.md` is the authoritative design source. When a requirement cannot be inferred safely from this document, the current files, or `DESIGN.md`, ask the project owner before implementing it.

## Project identity

- **Official name:** Maleta
- **Product:** AI listening device and companion web application
- **Domain:** `meleta.study` was provided as the domain. It does not match the official **Maleta** spelling, so do not rename or reconfigure it until the owner confirms whether the domain will remain `meleta.study` or change to `maleta.study`.
- **Primary audience:** Students, initially the project owner
- **Primary language:** Italian
- **Language direction:** Multilingual transcription and notes in the language spoken; do not translate by default
- **Core priority:** The product must be exceptionally user-friendly. Every screen and state should minimize effort, uncertainty, and distraction, especially while the student is in a lecture.

## Product purpose

Maleta helps a tired or busy student capture a lecture without having to write everything by hand. A student starts a recording from a dedicated listening device (the "Maleta Brick") or a laptop microphone. Maleta transcribes the lecture, retains the original transcript, lightly cleans its grammar and structure without changing meaning, and produces a useful summary for revision at home.

The calendar represents the student's recurring class schedule. Recordings may be started from a class block and attached automatically, or captured independently and assigned later. A recording must never require a calendar block.

## Product principles

1. **Recording comes first.** Starting, monitoring, and safely stopping a recording must require minimal attention.
2. **Never lose the lecture.** Preserve audio and intermediate work through processing failures, weak connectivity, navigation, and reasonable browser interruptions.
3. **Do not invent meaning.** AI may repair grammar and structure, but must not silently add facts or rewrite the professor's intent.
4. **Make uncertainty visible.** Low-confidence audio or words should be marked for review and paired with contextual suggestions where possible.
5. **Progressive disclosure.** Show the cleaned note and summary first; keep the raw transcript, technical metadata, and advanced controls available without making the main experience dense.
6. **Smart defaults, easy correction.** Infer the current subject, block, title, language, and tags when confidence is high. Ask only when ambiguity matters, and always allow correction.
7. **Calendar assignment is optional.** Unassigned recordings belong in a clear inbox rather than blocking capture or processing.
8. **Design for the lecture hall.** Recording controls must work quickly, one-handed on mobile, and without requiring the screen to stay focused on the app.

## Version 1 scope

Version 1 is a functional web experience focused on recording, transcription, light cleanup, summarization, and simple class organization.

### Required capabilities

- Record live audio from the laptop microphone.
- Support the Maleta Brick as an audio source when its connection method/API is available.
- Continue capturing while the user switches to another browser tab.
- Clearly explain that a web app cannot guarantee recording after the browser is closed, the device sleeps, permission is revoked, or the operating system suspends the tab.
- Provide start, pause, resume, stop-and-save, and discard controls with a visible duration and recording status.
- Process the recording with Whisper v3 Turbo (exact deployed model identifier to be confirmed during integration).
- Preserve the original/raw transcript.
- Create a lightly cleaned transcript that corrects grammar and improves paragraph structure while preserving content, language, and meaning.
- Generate an editable title, concise summary, key points, and suggested tags.
- Let the user edit the title and cleaned transcript, then regenerate derived AI output deliberately.
- Mark low-confidence passages and poor-audio ranges instead of silently guessing.
- Retain and play the original audio after processing.
- Create and edit a simple internal weekly class schedule.
- Start a recording from a class block and associate it automatically.
- Create a recording without a block and assign it later.
- Show unassigned recordings in an Inbox.
- Browse notes and search across titles, cleaned transcripts, summaries, subjects, and tags.
- Provide clear recording, uploading, transcribing, summarizing, ready, partial-failure, retry, and deletion states.

### Default AI behavior

- Detect the spoken language and preserve it.
- Suggest a title from the transcript. If confidence is low, request a title from the user instead of generating a misleading one.
- Remove obvious verbal filler and exact accidental repetitions only when meaning is unaffected.
- Keep side comments when they may carry context, instructions, deadlines, exam hints, or useful explanation.
- Divide the cleaned transcript into readable paragraphs and sections.
- Highlight uncertain terms, retain the original guess, and offer a contextual correction.
- Do not enable speaker diarization in version 1. A typical lecture is dominated by one professor, and diarization adds complexity and possible errors. Reconsider it only when multi-speaker use becomes important.
- Derived summaries should be regenerated from the current user-approved transcript, not blindly from an older raw version.

### Not in version 1

- Uploading prerecorded audio files
- Obsidian vault storage or synchronization
- Google, Apple, or Outlook calendar integrations
- Flashcard generation
- Study-plan generation
- Chatbot / NotebookLM-style conversation
- Subject-specific AI templates, including formula-focused math templates
- Translation by default
- Advanced speaker identification

These are roadmap ideas, not current acceptance requirements.

## Core user journey

1. The student opens Maleta and sees the current or next class plus one obvious recording action.
2. The student selects the laptop microphone or Maleta Brick and starts recording. If recording starts from a class block, its subject and time are prefilled.
3. During recording, Maleta shows a strong recording indicator, elapsed time, input status, pause/stop actions, and recoverable warnings. The student may switch tabs.
4. The student stops and saves. Audio is secured before AI processing begins.
5. Maleta transcribes and then produces the cleaned transcript and summary. Progress is explicit and the user can safely leave the screen.
6. Maleta suggests a title, subject/block, key points, and tags. It asks for confirmation only when an important inference is uncertain.
7. The note opens with the cleaned content and summary. The original transcript and audio remain available for verification.
8. If the capture is not assigned, it remains visible in the Inbox and can be attached to a class block later.

## Information architecture

The initial app should use the smallest navigation that supports the core flow:

- **Record / Today:** Default destination; current class context, primary recording action, active recording state, and recent captures.
- **Calendar:** Weekly class schedule and note assignment.
- **Notes:** All processed and processing captures, with filters and an unassigned Inbox.
- **Search:** Search may be a dedicated screen or an overlay reached from Notes and a global shortcut; choose whichever creates less navigation overhead.
- **Note detail:** Audio, cleaned transcript, raw transcript, summary, key points, tags, metadata, uncertainty review, and editing.
- **Settings:** Audio source, language behavior, account/storage controls, data deletion, and later hardware integration.

Do not expose a Vault destination. The existing prototype's Vault/Obsidian concepts are obsolete for version 1.

## Calendar behavior

- Use Maleta's internal calendar only in version 1.
- The calendar models a manually entered, usually recurring weekly school timetable.
- Blocks may vary in duration even though one-hour blocks are common.
- A block should at least contain subject, start/end time, recurrence, optional professor/room, and recording/note status.
- Starting from a block assigns the capture automatically.
- Starting outside a block creates an unassigned capture; Maleta may suggest the current or nearest matching class when confidence is high.
- Use a clear, restrained status language:
  - Scheduled class with no recording
  - Recording in progress
  - Recording attached and processing
  - Note ready
  - Processing/problem requiring attention
- Do not depend on color alone to communicate status. Pair color with text, icons, dots, or patterns.
- Prefer a usable week view for the school timetable. On narrow screens, an agenda-style day/week list is acceptable when a dense grid would become hard to operate.

## Key domain objects

- **User:** Account owner and preferences.
- **Audio source:** Laptop microphone or Maleta Brick.
- **Recording:** Raw audio, duration, source, timestamps, status, and ownership.
- **Transcript:** Raw Whisper output, language, timestamps/confidence where available, and versions.
- **Cleaned note:** Editable, structured transcript derived from a transcript version.
- **AI output:** Title, summary, key points, and tags tied to a specific cleaned-note version.
- **Subject:** A course/class identity and its display metadata.
- **Schedule block:** Subject, date/time or weekly recurrence, duration, optional professor/room, and attached captures.
- **Inbox item:** A recording/note that has not been assigned to a schedule block.

## Processing and failure behavior

- Save audio before beginning transcription.
- Make long-running work asynchronous and resumable; never require the note page to remain open.
- Show plain-language progress rather than a frozen interface.
- If transcription or summarization fails, retain the audio and any completed intermediate result and offer retry.
- If only summarization fails, keep the transcript usable.
- If connectivity drops during capture, prefer buffering locally and resuming upload when technically feasible. Clearly communicate local/uploaded state.
- Warn about microphone permission, unavailable input, storage/upload failure, silence, clipped audio, and poor confidence with a direct recovery action.
- Do not claim that content is saved until durable storage confirms it.
- Destructive deletion should require confirmation and clearly state whether audio, transcripts, and generated outputs will be removed.

## Technology direction

- **Application type:** Web app
- **Current prototype technology:** HTML, CSS, JavaScript, custom `.dc.html` documents, and a bundled support runtime
- **Requested base technologies:** HTML, CSS, and JavaScript
- **Database/backend:** Supabase (interpreting the earlier “suber base” reference as Supabase)
- **Future backend option:** Self-hosting on the owner's homelab
- **Transcription:** Whisper v3 Turbo
- **Summarization:** DeepSeek API was proposed; the exact available model and identifier must be verified before integration. Claude through a consumer Pro plan must not be assumed to provide API access.
- **Domain:** `meleta.study` was provided; confirm registration/deployment and whether it should change to `maleta.study` before production configuration.

Do not introduce a framework, paid service, or significant dependency solely from this document. First inspect the actual implementation constraints and choose the smallest maintainable option. Secrets must never be embedded in browser code; AI requests requiring secret keys should run through a protected server or serverless function.

## Design system authority

All UI creation and modification must begin by reading `DESIGN.md`. It is the core design specification and overrides styling inferred from prototype files when they conflict.

Important established rules include:

- Apple-inspired, quiet, low-density visual language.
- Action Blue `#0066cc` is the single interactive accent; use the documented on-dark variant only where required.
- SF Pro/system typography with the documented size, weight, spacing, and line-height hierarchy.
- White, parchment, and near-black surfaces; no decorative gradients.
- Pill geometry for primary actions, 18px utility cards, and at least 44×44px touch targets.
- No shadows on UI cards, buttons, or text. The documented product-image shadow is the only drop shadow.
- Use surface changes, spacing, typography, and hierarchy instead of decorative chrome.
- Responsive behavior must cover phone through wide desktop. Recording is the most important mobile flow.
- Keyboard focus, readable contrast, reduced motion, screen-reader labels, and non-color status indicators must be designed even where `DESIGN.md` notes gaps.

The design guide was originally derived from marketing/product pages, so adapt its tokens carefully to an application interface. Product usability takes priority when a museum-like low-density presentation would make a calendar, transcript, or long-running workflow harder to use. Adaptation should preserve the design language, not copy an unsuitable marketing layout literally.

## Existing files and prototype status

At initialization, the repository contains:

- `DESIGN.md`: Authoritative Apple-inspired visual system.
- `prototypes/Meleta Apple v2.dc.html`: Broadest legacy prototype, including recording, live transcript, calendar, notes, search, note detail, legacy Vault concepts, and mobile examples.
- `prototypes/Meleta Apple.dc.html`: Earlier broad prototype.
- `prototypes/Meleta Simple.dc.html`: Simplified navigation and flows.
- `prototypes/Meleta Calendar Options.dc.html`: Calendar layout explorations including grid, agenda, and month approaches.
- `prototypes/support.js`: Runtime supporting the archived `.dc.html` prototypes.

The prototypes contain useful interaction explorations and sample content, but they are not proof that a feature is approved or implemented. They use the legacy name **Meleta**, include obsolete Vault/Obsidian behavior, and contain design experiments such as multiple subject colors that may conflict with `DESIGN.md`'s single-accent rule. Preserve useful UX ideas while aligning future work with this document and `DESIGN.md`.

## Recommended version-one decisions

These decisions fill unresolved details with user-friendly defaults and may be revised when implementation evidence or owner feedback requires it:

- Default to the Record/Today screen.
- Allow both assigned and unassigned recordings.
- Use an Inbox for unassigned captures.
- Use editable AI-suggested titles.
- Keep raw and cleaned transcripts as separate, versioned content.
- Show cleaned transcript and summary first; disclose the raw transcript on request.
- Use transcript timestamps when supported by the transcription pipeline so text can seek the audio.
- Keep original audio until the user deletes the note; later add configurable retention if storage cost requires it.
- Ask before overwriting manual transcript edits during regeneration and preserve version history when feasible.
- Provide search across the complete note corpus.
- Treat real background/tab recording, interruption recovery, and long-lecture reliability as engineering requirements, not merely visual states.
- Design for multi-user accounts even if the first deployment serves one person; use a simple authentication method when backend implementation begins.

## Future roadmap

- Flashcards generated from approved notes
- Full revision/study plans
- Conversational study assistant over selected notes
- Subject-specific templates, especially formula-aware mathematics notes
- Calendar provider integrations
- Audio-file imports
- Speaker diarization for seminars and group work
- Production Maleta Brick pairing and synchronization
- Optional self-hosted backend
- Carefully designed export formats if a need emerges

## Open implementation questions

These do not block UI exploration, but must be resolved before their relevant production work:

- Maleta Brick transport, firmware, pairing, and API contract
- Supabase project status, schema, authentication choice, storage limits, and retention policy
- Exact deployed Whisper endpoint/model identifier and timestamp/confidence support
- Exact summarization provider/model, API cost, privacy terms, and structured-output reliability
- Maximum expected lecture length and background capture strategy by browser/platform
- Offline buffering requirements and storage quota behavior
- Account model, consent copy, recording-law requirements, and deletion/recycle-bin policy
- Final domain decision: keep `meleta.study` or migrate to `maleta.study`
- Whether the current `.dc.html` format is a prototype-only artifact or the intended implementation base

## Definition of a successful first release

A student can open Maleta on a laptop, start a reliable live microphone recording with minimal effort, continue working in another browser tab, stop and safely save the lecture, receive an Italian (or detected-language) raw transcript, lightly cleaned editable transcript, title, summary, key points, and tags, and optionally attach the result to a block in a simple weekly class schedule. Unassigned recordings remain easy to find, processing failures never hide or discard captured audio, and every step follows `DESIGN.md` while prioritizing clarity and ease of use.
