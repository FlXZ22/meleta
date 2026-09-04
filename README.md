# Meleta

Meleta is a local-first web app for recording lectures and turning them into searchable, live transcripts.

## Project structure

```text
.
├── assets/
│   ├── css/                # Design tokens, components, and calendar styles
│   ├── fonts/inter/        # Vendored Inter weights (300/400/600/700)
│   ├── images/             # Production brand and provider assets
│   └── js/
│       ├── app.js          # Router, rendering, and application logic
│       ├── calendar.js     # Calendar rendering and interactions
│       ├── audio-split.js  # Cuts oversized audio into per-provider segments
│       ├── db.js           # IndexedDB persistence
│       ├── i18n.js         # Italian source strings with an English locale
│       ├── recorder.js     # Microphone recording state machine
│       ├── text-split.js   # Cuts a long transcript into note-sized chunks
│       └── transcriber.js  # Live and provider transcription orchestration
├── docs/                   # Integration and backend notes
├── logo/                   # Original supplied brand artwork
├── prototypes/             # Archived design explorations; not production code
├── .env.example            # Optional, non-secret local server configuration
├── SECURITY.md             # Secret-handling and deployment boundaries
├── DESIGN.md               # Authoritative visual design system
├── info.md                 # Product requirements and decisions
├── index.html              # Semantic application markup
├── server.mjs              # Local static and provider-proxy server
└── package.json
```

## Run locally

The current version has no build step or third-party runtime dependencies. Start the secure local server with Node 22 or newer:

```bash
npm start
```

Then open `http://127.0.0.1:8080`.

All runtime assets are local. No package installation or external font/CDN request is required.

Live transcript preview uses provider audio chunks when a provider is configured and browser speech recognition as a fallback when available. Provider calls go through the same-origin Node server.

Providers are registered per **role**, and each role keeps its own key and model:

| Role | Job | Providers |
| --- | --- | --- |
| `transcription` | Audio to text | OpenAI, Groq, OpenRouter, Deepgram |
| `note` | Cleaning up the transcript and titling it | OpenRouter, DeepSeek, Groq |

Groq and OpenRouter appear in both roles because they sell both kinds of model. Their credentials are stored separately per role, so the transcription key and model can never be used for the note or vice versa. Adding a role means adding one entry to `providerRoles` in `server.mjs` and one to `providerCatalog` in `app.js`.

Every key is verified against the provider before saving, encrypted at rest with AES-256-GCM, and stored under the ignored `.data/` directory with restrictive file permissions. The server binds to `127.0.0.1` by default.

Never publish this local credential server directly to the internet. A hosted deployment must add authentication, user-scoped database records, HTTPS, CSRF protection, rate limits, and a managed secret-encryption key before accepting provider credentials.

## Current MVP

- Records from the device microphone with pause, resume, markers, safe stop, and discard.
- Stores audio chunks locally while recording and recovers interrupted captures on the next launch.
- Persists recordings, titles, assignments, and the recurring class schedule in IndexedDB.
- Provides real audio playback, search, Inbox filtering, assignment, and deletion.
- Computes the current or next class from the saved weekly schedule.
- Connects supported providers per role and loads their currently available models.
- Shows live transcription while recording and stores the completed transcript with the note.
- Turns a transcript into a cleaned note: an AI provider repairs grammar, punctuation and paragraphing without changing the content, and proposes a title. Long lectures are chunked at sentence boundaries and stitched back together.
- Keeps the transcript and the note as two views of the same recording, and exports either one as a Markdown file with YAML front matter.
- Flags a note as out of date when the transcript it came from has since changed.

Notes and recordings currently live only in the active browser profile. Clearing site data removes them. Provider credentials remain in the server-side `.data/` directory and are never returned to browser JavaScript.

## Before publishing

Run the repository checks:

```bash
npm run check
```

Confirm that `git status --ignored` lists `.data/` as ignored. Never force-add that directory, a `.env` file, or any private key. See [SECURITY.md](SECURITY.md) for the security and hosting boundary.

## Development rules

- Read `info.md` before changing product behavior.
- Read `DESIGN.md` before changing any interface or interaction.
- Keep HTML, CSS, and JavaScript separated.
- Keep archived prototypes as references only; do not build new features inside them.
- Never place private API keys in browser JavaScript. AI and database integrations require a protected backend layer.
