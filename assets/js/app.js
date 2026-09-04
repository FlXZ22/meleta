import { db, makeId } from "./db.js";
import { AudioRecorder, listAudioInputs } from "./recorder.js";
import { LiveTranscriber } from "./transcriber.js";
import { initCalendar, renderCalendar, currentOrNextOccurrence, dateKey } from "./calendar.js";
import { getLocale, initI18n, localeCode, t } from "./i18n.js";
import { splitForUpload } from "./audio-split.js";
import { splitTranscript } from "./text-split.js";

/* How many finished transcript lines the live panel keeps on screen. The panel
   is full width now, so it has room for more than the last utterance. */
const TRANSCRIPT_WINDOW = 8;

const state = {
  recordings: [], classes: [], route: "today", routeId: null,
  filter: "all", query: "", recordingClassId: null,
  markers: [], tickId: null, detailUrl: null, detailAudioId: null, detailToken: null, activeDraftId: null,
  chunkSequence: 0, chunkWrites: new Set(), bufferHealthy: true, bufferMessage: "", draftCreatedAt: null, draftPersist: Promise.resolve(),
  transcriptFinal: "", transcriptInterim: "", translationFinal: "", translationInterim: "", transcriptStatus: "Anteprima pronta",
  transcriptSegments: [], animateLatestTranscript: false, renderedSegments: 0,
  player: { recordingId: null, currentTime: 0, playbackRate: 1, wasPlaying: false },
  noteMode: "note",
  settings: { livePreview: true, inputLanguage: "auto", uiLanguage: "it", activeProvider: "", activeNoteProvider: "", audioDeviceId: "" },
  providerStatus: { transcription: {}, note: {} }, selectedProvider: { transcription: null, note: null },
};
const recorder = new AudioRecorder();
const transcriber = new LiveTranscriber();
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const els = {
  views: $$('[data-view]'), toast: $(".toast"), todayContext: $("#today-context"),
  recordingPanel: $("#recording-panel"), recentList: $("#recent-list"),
  libraryList: $("#library-list"), search: $("#library-search"),
  calendarRoot: $("#calendar-root"), detail: $("#recording-detail"),
  settingsForm: $("#settings-form"), settingsStatus: $("#settings-status"),
  journeyStatus: $("#journey-status"), headerRecord: $(".header-record"),
  todayInbox: $("#today-inbox"), todayInboxList: $("#today-inbox-list"),
  recBar: $("#global-rec-bar"), recBarTimer: $("#rec-bar-timer"), recBarSubject: $("#rec-bar-subject"), recBarPause: $("#rec-bar-pause"),
};
let toastTimer;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

/* Toasts vanish after a few seconds. Anything that threatens the lecture stays
   on screen until the student dismisses it. */
function raiseAlert(message) {
  const banner = $("#alert-banner");
  if (!banner) return announce(message);
  $("#alert-text").textContent = message;
  banner.hidden = false;
}

function dismissAlert() {
  const banner = $("#alert-banner");
  if (banner) banner.hidden = true;
}

function announce(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.hidden = false;
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 4500);
}

function formatDuration(seconds = 0) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const rest = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${minutes}:${String(rest).padStart(2, "0")}`;
}

function formatPlayerTime(seconds = 0) {
  if (!Number.isFinite(seconds)) return "0:00";
  return formatDuration(Math.max(0, Math.floor(seconds)));
}

/* Deterministic bars make each recording feel like an audio object without
   decoding the full lecture into memory just to draw a decorative waveform. */
function waveformBars(seed = "meleta", count = 92) {
  let value = [...String(seed)].reduce((total, character) => (total * 31 + character.charCodeAt(0)) >>> 0, 2166136261);
  return Array.from({ length: count }, (_, index) => {
    value = (value * 1664525 + 1013904223) >>> 0;
    const rhythm = Math.abs(Math.sin(index * 0.47)) * 34;
    return 20 + Math.round((value / 4294967295) * 46 + rhythm);
  });
}

function liveWaveformBars() {
  return waveformBars("meleta-live", 84).map((height, index) => `<i style="--wave-base:${height / 100};--wave-index:${index}" aria-hidden="true"></i>`).join("");
}

function timeUntilClass(item) {
  const startsAt = new Date(item.date);
  startsAt.setMinutes(item.startMinutes);
  const minutes = Math.round((startsAt - new Date()) / 60000);
  if (minutes <= 0) return "La lezione è in corso";
  if (minutes < 60) return `Inizia tra ${minutes} min`;
  if (minutes < 24 * 60) return `Inizia tra ${Math.round(minutes / 60)} h`;
  return formatDate(startsAt, { weekday: "long", hour: "2-digit", minute: "2-digit" });
}

function formatDate(value, options = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) {
  return new Intl.DateTimeFormat(localeCode(), options).format(new Date(value));
}

/* Folds case and strips accents so "perche" finds "perché". Uses the active UI
   locale rather than always folding as Italian. */
function foldForSearch(value = "") {
  return String(value).toLocaleLowerCase(localeCode()).normalize("NFD").replace(/\p{M}/gu, "");
}

/* Folded text is cached outside the record so it is never written to IndexedDB.
   Re-folding whole transcripts on every keystroke is what made searching a large
   library stutter. */
const searchIndex = new Map();

function searchTextFor(recording) {
  const cached = searchIndex.get(recording.id);
  if (cached !== undefined) return cached;
  const subject = classFor(recording.classId)?.subject || "";
  const folded = foldForSearch(`${recordingTitle(recording)} ${subject} ${recording.rawTranscript || ""} ${recording.note?.markdown || ""} ${recording.translation || ""}`);
  searchIndex.set(recording.id, folded);
  return folded;
}

function invalidateSearchText(id) { searchIndex.delete(id); }

function classFor(id) { return state.classes.find((item) => item.id === id); }
function recordingFor(id) { return state.recordings.find((item) => item.id === id); }
function sortClasses(items) { return [...items].sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime)); }
function recordingTitle(recording) {
  const title = recording.title?.trim();
  if (title) return recording.status === "recovered" && title === "Registrazione recuperata" ? t(title) : title;
  return t(`Registrazione del ${formatDate(recording.createdAt)}`);
}

function recordingLifecycle(recording) {
  const status = recording.transcriptionStatus || (recording.rawTranscript ? "ready" : "pending");
  if (status === "running") return { key: "running", label: "Trascrizione in corso", detail: recording.transcriptionProgress ? `Parte ${recording.transcriptionProgress}` : "Puoi lasciare questa pagina" };
  if (status === "queued") return { key: "queued", label: "In coda per la trascrizione", detail: "L’audio è già al sicuro" };
  if (status === "failed") return { key: "failed", label: "Richiede attenzione", detail: "L’audio è al sicuro · puoi riprovare" };
  if (recording.rawTranscript) return { key: "ready", label: "Nota pronta", detail: "Trascrizione disponibile" };
  return { key: "saved", label: "Audio salvato", detail: state.settings.activeProvider ? "Pronta da trascrivere" : "Configura la trascrizione AI" };
}

function journeyProgress(recording) {
  const lifecycle = recordingLifecycle(recording);
  const transcriptDone = Boolean(recording.rawTranscript);
  const transcriptionActive = ["running", "queued"].includes(lifecycle.key);
  const transcriptionFailed = lifecycle.key === "failed";
  return `<ol class="journey-progress" aria-label="Stato della lezione">
    <li class="is-done"><span>1</span><div><strong>Audio salvato</strong><small>Disponibile in questo browser</small></div></li>
    <li class="${transcriptDone ? "is-done" : transcriptionFailed ? "has-problem" : transcriptionActive ? "is-active" : ""}"><span>2</span><div><strong>${transcriptDone ? "Trascrizione pronta" : transcriptionFailed ? "Trascrizione interrotta" : transcriptionActive ? "Trascrizione in corso" : "Trascrizione"}</strong><small>${transcriptionFailed ? "Riprova senza perdere l’audio" : transcriptionActive ? "Continua in background" : transcriptDone ? "Puoi leggere e cercare" : "Non ancora avviata"}</small></div></li>
    <li class="${transcriptDone ? "is-done" : ""}"><span>3</span><div><strong>Nota utilizzabile</strong><small>${transcriptDone ? "Pronta per lo studio" : "Disponibile dopo la trascrizione"}</small></div></li>
  </ol>`;
}

async function loadData() {
  await recoverInterruptedRecordings();
  [state.recordings, state.classes] = await Promise.all([db.all("recordings"), db.all("classes")]);
  state.recordings.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  await resumeInterruptedTranscriptions();
  await removeOrphanAudio();
}

/* A transcription that was running when the tab closed would otherwise stay
   "running" for ever, and the guard in transcribeSavedAudio would refuse every
   retry. Reopening the app marks them failed so the retry action is offered. */
async function resumeInterruptedTranscriptions() {
  const stuck = state.recordings.filter((recording) => recording.transcriptionStatus === "running");
  await Promise.all(stuck.map((recording) => {
    recording.transcriptionStatus = "failed";
    recording.transcriptionProgress = "";
    recording.transcriptionError = "Trascrizione interrotta. Riprova quando vuoi.";
    return db.put("recordings", recording).catch(() => {});
  }));
}

/* Reclaims audio blobs whose recording row no longer exists, which a failed or
   interrupted save can leave behind. */
async function removeOrphanAudio() {
  try {
    const keys = await db.keys("audio");
    const known = new Set(state.recordings.map((recording) => recording.id));
    const orphans = keys.filter((key) => !known.has(key));
    await Promise.all(orphans.map((key) => db.delete("audio", key)));
  } catch { /* Housekeeping only; never block startup on it. */ }
}

async function recoverInterruptedRecordings() {
  const drafts = await db.all("drafts");
  if (!drafts.length) return;
  for (const draft of drafts) {
    /* Reading by id prefix touches one draft's blobs instead of every chunk in
       the store, which used to mean loading whole lectures just to delete them. */
    const savedChunks = (await db.allByPrefix("chunks", `${draft.id}_`)).sort((a, b) => a.sequence - b.sequence);
    if (savedChunks.length) {
      const audio = new Blob(savedChunks.map((chunk) => chunk.audio), { type: draft.mimeType || savedChunks[0].audio.type || "audio/webm" });
      const id = makeId("rec");
      const recovered = {
        id, title: "Registrazione recuperata", createdAt: draft.createdAt, updatedAt: new Date().toISOString(),
        /* The draft carries real elapsed time. Chunk count only approximated it
           and drifted apart as soon as the lecture was paused. */
        durationSeconds: draft.durationSeconds || savedChunks.length,
        classId: draft.classId || null, markers: draft.markers || [], mimeType: audio.type, hasAudio: true,
        /* Live preview text is persisted alongside the audio, so a crash no
           longer throws away every word transcribed so far. */
        rawTranscript: draft.transcript || "", translation: draft.translation || "",
        status: "recovered", transcriptionStatus: "pending",
      };
      await db.write(["audio", "recordings"], ([audioStore, recordings]) => {
        audioStore.put({ id, blob: audio });
        recordings.put(recovered);
      });
    }
    await db.deleteByPrefix("chunks", `${draft.id}_`);
    await db.delete("drafts", draft.id);
  }
}

/* The single writer for the draft record, so every field stays consistent.
   createdAt is captured once at start and never recomputed: deriving it from
   elapsed time ignored pauses, so it walked forward on every marker. */
function persistDraft() {
  if (!state.activeDraftId) return Promise.resolve();
  const draft = {
    id: state.activeDraftId, createdAt: state.draftCreatedAt, classId: state.recordingClassId,
    markers: [...state.markers], mimeType: recorder.mediaRecorder?.mimeType || "audio/webm",
    durationSeconds: recorder.elapsedSeconds, transcript: state.transcriptFinal.trim(), translation: state.translationFinal.trim(),
  };
  state.draftPersist = state.draftPersist.then(() => db.put("drafts", draft)).catch(() => reportBufferFailure());
  return state.draftPersist;
}

/* The panel must stop claiming the lecture is safe once local writes fail. */
function reportBufferFailure(message = "Il salvataggio locale non sta funzionando. Termina e salva appena puoi.") {
  if (!state.bufferHealthy) return;
  state.bufferHealthy = false;
  state.bufferMessage = message;
  if (state.route === "today") renderRecordingPanel();
  raiseAlert(message);
}

async function checkStorageHeadroom() {
  try {
    await navigator.storage?.persist?.();
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate?.quota) return;
    const free = estimate.quota - (estimate.usage || 0);
    /* Capture runs at about 14 MB an hour, so this warns below roughly two hours. */
    if (free < 30 * 1024 * 1024) announce("Spazio di archiviazione quasi esaurito. Elimina qualche registrazione prima di iniziare.");
  } catch { /* Storage estimation is advisory only. */ }
}

function parseRoute() {
  const parts = (location.hash || "#/today").slice(2).split("/");
  const route = ["today", "library", "calendar", "recording", "settings"].includes(parts[0]) ? parts[0] : "today";
  state.route = route;
  state.routeId = parts[1] || null;
}

function syncHeaderAction() {
  const active = recorder.state !== "idle";
  els.headerRecord.hidden = !active && state.route === "today";
  els.headerRecord.classList.toggle("is-live", active);
  els.headerRecord.dataset.action = active ? "return-recording" : "start-unassigned";
  els.headerRecord.textContent = active ? `● ${formatDuration(recorder.elapsedSeconds)}` : "Registra";
  els.headerRecord.setAttribute("aria-label", t(active ? "Torna alla registrazione in corso" : "Inizia una registrazione"));
  syncRecBar(active);
}

/* The persistent bar keeps capture reachable from every screen. On Today the
   full immersive panel already shows, so the bar only appears elsewhere. */
function syncRecBar(active) {
  if (!els.recBar) return;
  const show = active && state.route !== "today";
  els.recBar.hidden = !show;
  if (!show) return;
  const assigned = classFor(state.recordingClassId);
  els.recBarTimer.textContent = formatDuration(recorder.elapsedSeconds);
  els.recBarSubject.textContent = assigned ? assigned.subject : t("Registrazione libera");
  if (els.recBarPause) els.recBarPause.textContent = recorder.state === "paused" ? "▶" : "❚❚";
}

function renderRoute() {
  parseRoute();
  els.views.forEach((view) => { view.hidden = view.dataset.view !== state.route; });
  $$('[data-nav]').forEach((link) => {
    const active = link.dataset.nav === state.route || (state.route === "recording" && link.dataset.nav === "library");
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  });
  syncHeaderAction();
  if (state.route === "today") renderToday();
  if (state.route === "library") renderLibrary();
  if (state.route === "calendar") { invalidateAttachments(); renderCalendar(); }
  if (state.route === "recording") renderDetail(); else { state.detailToken = null; releaseDetailAudio(); }
  if (state.route === "settings") renderSettings();
  scrollTo({ top: 0, behavior: "smooth" });
}

function currentOrNextClass() {
  const found = currentOrNextOccurrence();
  if (!found) return null;
  const when = new Date(found.occurrence.date);
  when.setMinutes(found.occurrence.startMinutes);
  return { item: found.occurrence, label: found.active ? t("In corso") : formatDate(when, { weekday: "long", hour: "2-digit", minute: "2-digit" }) };
}

/* One pass over the recordings builds a lookup keyed by class and date. This
   used to filter the whole array — and construct a Date per recording — for
   every block drawn, which is thousands of comparisons on a full week. */
let attachmentIndex = null;

function buildAttachmentIndex() {
  const index = new Map();
  for (const recording of state.recordings) {
    if (!recording.classId) continue;
    const key = `${recording.classId}|${dateKey(new Date(recording.createdAt))}`;
    const entry = index.get(key) || { length: 0, ready: 0 };
    entry.length += 1;
    if (recording.rawTranscript) entry.ready += 1;
    index.set(key, entry);
  }
  attachmentIndex = index;
}

function attachedRecordings(occurrence) {
  if (!attachmentIndex) buildAttachmentIndex();
  return attachmentIndex.get(`${occurrence.eventId}|${occurrence.key}`) || { length: 0, ready: 0 };
}

function recordingForOccurrence(occurrence) {
  return state.recordings.find((recording) => recording.classId === occurrence.eventId && dateKey(new Date(recording.createdAt)) === occurrence.key) || null;
}

function invalidateAttachments() { attachmentIndex = null; }

/* Status shown on a calendar block. Colour never carries this alone: the
   calendar always prints the label next to the marker. */
function calendarStatus(occurrence) {
  const today = dateKey(new Date());
  if (state.recordingClassId === occurrence.eventId && recorder.state !== "idle" && occurrence.key === today) return { tone: "live", label: t("In registrazione") };
  const attached = attachedRecordings(occurrence);
  if (attached.length) {
    const ready = attached.ready;
    if (ready) return { tone: "ready", label: t(ready > 1 ? `${ready} note pronte` : "Nota pronta") };
    return { tone: "pending", label: t(attached.length > 1 ? `${attached.length} registrazioni` : "Registrazione salvata") };
  }
  const end = new Date(occurrence.date);
  end.setMinutes(occurrence.endMinutes);
  return end < new Date() ? { tone: "empty", label: t("Nessuna registrazione") } : null;
}

async function persistClass(item) {
  await db.put("classes", item);
  const index = state.classes.findIndex((current) => current.id === item.id);
  if (index >= 0) state.classes[index] = item; else state.classes.push(item);
}

async function removeClass(id) {
  await db.delete("classes", id);
  state.classes = state.classes.filter((current) => current.id !== id);
  const linked = state.recordings.filter((recording) => recording.classId === id);
  await Promise.all(linked.map((recording) => { recording.classId = null; recording.updatedAt = new Date().toISOString(); return db.put("recordings", recording); }));
}

function renderToday() {
  $("#today-date").textContent = formatDate(new Date(), { weekday: "long", day: "numeric", month: "long" });
  const context = currentOrNextClass();
  if (!context) {
    $("#today-title").textContent = t("Nessuna lezione in programma");
    els.todayContext.innerHTML = `<article class="lecture-launch lecture-launch-free"><div class="lecture-launch-copy"><a class="text-link schedule-link" href="#/calendar">Aggiungi il tuo orario ›</a></div><div class="lecture-record-zone"><button class="lecture-record-button" data-action="start-unassigned" aria-label="Inizia una registrazione"><span aria-hidden="true"></span><strong>Inizia lezione</strong></button></div></article>`;
  } else {
    const item = context.item;
    $("#today-title").textContent = timeUntilClass(item);
    els.todayContext.innerHTML = `<article class="lecture-launch"><div class="lecture-launch-copy"><p class="eyebrow">${escapeHtml(context.label)} · ${escapeHtml(item.startTime)}–${escapeHtml(item.endTime)}</p><h2 data-no-translate>${escapeHtml(item.subject)}</h2><p class="today-card-meta" data-no-translate>${escapeHtml([item.room, item.professor].filter(Boolean).join(" · ") || t("Lezione programmata"))}</p></div><div class="lecture-record-zone"><button class="lecture-record-button" data-action="start-class" data-class-id="${item.eventId}" aria-label="Registra questa lezione"><span aria-hidden="true"></span><strong>Inizia lezione</strong></button></div></article>`;
  }
  renderRecordingPanel();
  renderJourneyStatus();
  renderTodayInbox();
  renderRecordingList(els.recentList, state.recordings.slice(0, 4), "Le registrazioni salvate compariranno qui.", false);
}

/* Unassigned captures surfaced on Today so "assign it later" has a home instead
   of hiding behind a Library filter. Quick-assign reuses the detail view's
   data-assign-detail hook, so no new event wiring. */
function renderTodayInbox() {
  if (!els.todayInbox) return;
  const items = state.recordings.filter((recording) => !classFor(recording.classId));
  els.todayInbox.hidden = items.length === 0;
  if (!items.length) return;
  els.todayInboxList.innerHTML = items.slice(0, 6).map(inboxCard).join("");
}

function inboxCard(recording) {
  const options = sortClasses(state.classes).map((item) => `<option value="${item.id}" data-no-translate>${escapeHtml(item.subject)}</option>`).join("");
  const assign = state.classes.length
    ? `<label class="visually-hidden" for="ia-${recording.id}">Assegna a una lezione</label><select class="select-field inbox-assign" id="ia-${recording.id}" data-assign-detail="${recording.id}"><option value="">Assegna a…</option>${options}</select>`
    : `<a class="text-link" href="#/calendar">Crea una lezione ›</a>`;
  return `<article class="inbox-card"><button class="inbox-card-open" type="button" data-open-recording="${recording.id}"><strong data-no-translate>${escapeHtml(recordingTitle(recording))}</strong><small>${formatDate(recording.createdAt)} · ${formatDuration(recording.durationSeconds)}</small></button>${assign}</article>`;
}

function renderJourneyStatus() {
  const recording = state.recordings.find((item) => ["queued", "running", "failed"].includes(item.transcriptionStatus));
  els.journeyStatus.hidden = !recording;
  if (!recording) return;
  const lifecycle = recordingLifecycle(recording);
  els.journeyStatus.innerHTML = `<a class="journey-banner" href="#/recording/${recording.id}"><span class="journey-indicator" data-state="${lifecycle.key}" aria-hidden="true"></span><span><strong>${escapeHtml(lifecycle.label)}</strong><small data-no-translate>${escapeHtml(recordingTitle(recording))}</small></span><span class="journey-detail">${escapeHtml(lifecycle.detail)} <b aria-hidden="true">›</b></span></a>`;
}

/* Returns false when the panel is not on screen in a state that can be appended
   to, in which case the caller falls back to a full render. */
function appendTranscriptLines() {
  const stream = $(".transcript-stream");
  if (!stream || recorder.state === "idle") return false;
  const pending = state.transcriptSegments.slice(state.renderedSegments);
  const listeningLine = $(".listening-line");
  /* Only the newest line animates in, matching the full-render behaviour. */
  if (pending.length) $$(".transcript-line.is-new").forEach((line) => line.classList.remove("is-new"));
  for (const segment of pending) {
    const line = document.createElement("p");
    line.className = "transcript-line is-new";
    line.textContent = segment;
    stream.insertBefore(line, listeningLine);
  }
  const finalLines = $$(".transcript-line:not(.interim-text)", stream);
  finalLines.slice(0, -TRANSCRIPT_WINDOW).forEach((line) => line.remove());
  state.renderedSegments = state.transcriptSegments.length;
  let interim = $(".interim-text");
  if (state.transcriptInterim) {
    if (!interim) {
      interim = document.createElement("p");
      interim.className = "transcript-line interim-text";
      stream.insertBefore(interim, listeningLine);
    }
    interim.textContent = state.transcriptInterim;
  } else interim?.remove();
  const placeholder = $(".transcript-placeholder");
  if (placeholder && state.transcriptSegments.length) placeholder.remove();
  scrollTranscript();
  return true;
}

function scrollTranscript() {
  requestAnimationFrame(() => {
    const viewport = $(".transcript-scroll");
    if (viewport) viewport.scrollTo({ top: viewport.scrollHeight, behavior: state.transcriptSegments.length > 1 ? "smooth" : "auto" });
    state.animateLatestTranscript = false;
  });
}

function renderRecordingPanel() {
  const active = recorder.state !== "idle";
  $('[data-view="today"]')?.classList.toggle("is-capturing", active);
  els.recordingPanel.hidden = !active;
  els.todayContext.hidden = active;
  if (!active) return;
  const assigned = classFor(state.recordingClassId);
  const label = ({ "requesting-permission": "In attesa del microfono", recording: "Registrazione in corso", paused: "Registrazione in pausa", finalizing: "Preparazione dell’audio", saving: "Salvataggio locale", "input-ended": "Microfono scollegato", error: "Problema di registrazione" })[recorder.state] || "Registrazione";
  const canControl = ["recording", "paused"].includes(recorder.state);
  els.recordingPanel.classList.toggle("is-paused", recorder.state === "paused");
  const interim = escapeHtml(state.transcriptInterim);
  const latest = state.transcriptSegments.slice(-TRANSCRIPT_WINDOW).map((segment, index, all) => `<p class="transcript-line ${state.animateLatestTranscript && index === all.length - 1 ? "is-new" : ""}">${escapeHtml(segment)}</p>`).join("");
  const lines = latest || `<p class="transcript-placeholder">Inizia a parlare.</p>`;
  /* The live transcript owns the full width of the panel; controls live in their
     own row underneath it so nothing sits beside the words being written. */
  els.recordingPanel.innerHTML = `<div class="immersive-recording">`
    + `<header class="recording-header"><div><div class="recording-state"><span class="recording-dot" aria-hidden="true"></span><span>${label}</span></div><p class="recording-context">${assigned ? `<span data-no-translate>${escapeHtml(assigned.subject)}</span>` : "Registrazione non assegnata"} · Microfono del dispositivo</p></div><time class="recording-timer">${formatDuration(recorder.elapsedSeconds)}</time></header>`
    + `<div class="live-waveform" aria-label="Livello del microfono">${liveWaveformBars()}</div>`
    + `<div class="live-lower"><section class="live-caption" aria-live="polite" aria-relevant="additions text"><div class="transcript-scroll"><div class="transcript-stream">${lines}${interim ? `<p class="transcript-line interim-text">${interim}</p>` : ""}<div class="listening-line" aria-hidden="true"><span class="listening-bars"><i></i><i></i><i></i></span><span class="listening-label">In ascolto</span></div></div></div></section></div>`
    + `<div class="recording-actions"><button class="recording-control" data-action="toggle-pause" ${canControl ? "" : "disabled"}>${recorder.state === "paused" ? "Riprendi" : "Pausa"}</button><button class="recording-control" data-action="mark" ${canControl ? "" : "disabled"}>Segna momento</button><button class="recording-control finish-control" data-action="stop-recording" ${canControl || recorder.state === "input-ended" || recorder.state === "error" ? "" : "disabled"}>Termina lezione</button></div>`
    + `<footer class="recording-footer"><button class="text-button discard-link" data-action="discard-recording" ${canControl ? "" : "disabled"}>Elimina registrazione</button>${state.bufferHealthy ? "" : `<p class="recording-help buffer-warning">${escapeHtml(state.bufferMessage)}</p>`}</footer>`
    + `</div>`;
  state.renderedSegments = state.transcriptSegments.length;
  scrollTranscript();
}

async function renderSettings() {
  const form = els.settingsForm;
  await renderAudioDevices();
  Object.entries(state.settings).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].type === "checkbox" ? form.elements[key].checked = value : form.elements[key].value = value; });
  await loadProviderStatus();
  /* A role nobody has set up yet opens itself, so the work to be done is on
     screen instead of behind a disclosure the user has to guess at. */
  for (const role of providerRoles) {
    const section = providerSection(role); if (!section || section.dataset.touched) continue;
    section.open = !section.classList.contains("is-configured");
  }
}

/* Device labels stay blank until microphone permission has been granted once,
   so the list is rebuilt whenever Settings is opened. */
async function renderAudioDevices() {
  const select = els.settingsForm.elements.audioDeviceId;
  if (!select) return;
  const devices = await listAudioInputs();
  const chosen = state.settings.audioDeviceId;
  select.innerHTML = `<option value="">Predefinito del sistema</option>${devices.map((device) => `<option value="${escapeHtml(device.deviceId)}" ${device.deviceId === chosen ? "selected" : ""} data-no-translate>${escapeHtml(device.label)}</option>`).join("")}`;
  /* A device saved earlier may no longer be plugged in. */
  if (chosen && !devices.some((device) => device.deviceId === chosen)) select.value = "";
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("maleta-settings") || "{}");
    state.settings = { livePreview: saved.livePreview !== false, inputLanguage: saved.inputLanguage || "auto", uiLanguage: saved.uiLanguage === "en" ? "en" : "it", activeProvider: saved.activeProvider || "", activeNoteProvider: saved.activeNoteProvider || "", audioDeviceId: saved.audioDeviceId || "" };
  } catch { /* use safe defaults */ }
}

function saveSettings() {
  const data = new FormData(els.settingsForm);
  const previousLanguage = state.settings.uiLanguage;
  state.settings = { ...state.settings, livePreview: data.get("livePreview") === "on", inputLanguage: data.get("inputLanguage"), uiLanguage: data.get("uiLanguage") === "en" ? "en" : "it", audioDeviceId: data.get("audioDeviceId") || "" };
  localStorage.setItem("maleta-settings", JSON.stringify(state.settings));
  if (previousLanguage !== state.settings.uiLanguage) { location.reload(); return; }
  els.settingsStatus.textContent = "Impostazioni salvate";
  announce("Impostazioni salvate.");
}

/* Providers are grouped by the job they do. Groq and OpenRouter appear in both
   groups because they sell both speech and text models; the server keeps a
   separate key and model per (role, provider) so the two never collide. */
const providerCatalog = {
  transcription: {
    openai: { name: "OpenAI", help: "https://platform.openai.com/api-keys", copy: "Crea una chiave API nel progetto OpenAI che userai per Meleta. La connessione viene verificata contro l’elenco modelli ufficiale." },
    groq: { name: "Groq", help: "https://console.groq.com/keys", copy: "Crea una chiave di progetto GroqCloud. Dopo la verifica potrai scegliere uno dei modelli Whisper disponibili nel tuo account." },
    openrouter: { name: "OpenRouter", help: "https://openrouter.ai/settings/keys", copy: "Crea una chiave OpenRouter. Dopo la verifica Meleta caricherà il catalogo Speech-to-Text disponibile." },
    deepgram: { name: "Deepgram", help: "https://console.deepgram.com/", copy: "Crea una chiave Deepgram con accesso Speech-to-Text, poi scegli esplicitamente il modello documentato da usare." },
  },
  note: {
    openrouter: { name: "OpenRouter", help: "https://openrouter.ai/settings/keys", copy: "Una sola chiave dà accesso al catalogo di quasi tutti i modelli di testo. Utile se vuoi provare modelli diversi senza aprire altri account." },
    deepseek: { name: "DeepSeek", help: "https://platform.deepseek.com/api_keys", copy: "Crea una chiave sulla piattaforma DeepSeek. deepseek-chat costa poco ed è più che sufficiente per rifinire una trascrizione." },
    groq: { name: "Groq", help: "https://console.groq.com/keys", copy: "La stessa chiave GroqCloud vale anche qui, ma va inserita di nuovo: Meleta tiene separate la chiave per la trascrizione e quella per la nota." },
  },
};
const providerRoles = Object.keys(providerCatalog);

/* Kept so the rest of the app can name a provider without knowing its role. */
const providers = { ...providerCatalog.transcription, ...providerCatalog.note };

function activeProviderFor(role) {
  return role === "note" ? state.settings.activeNoteProvider : state.settings.activeProvider;
}

function setActiveProvider(role, id) {
  if (role === "note") state.settings.activeNoteProvider = id;
  else state.settings.activeProvider = id;
  localStorage.setItem("maleta-settings", JSON.stringify(state.settings));
}

/* Every control in a provider panel is addressed relative to its section, so the
   two panels on the Settings page cannot reach into each other. */
function providerSection(role) { return $(`[data-provider-section="${role}"]`); }
function providerField(role, name) { return $(`[data-field="${name}"]`, providerSection(role)); }
function providerControl(role, action) { return $(`[data-action="${action}"]`, providerSection(role)); }
function providerStep(role, name) { return $(`[data-step="${name}"]`, providerSection(role)); }

function providerStatusFor(role, id) { return state.providerStatus[role]?.[id] || null; }

/* One place decides how far along a provider is, so the row chip, the section
   summary and the step marks can never disagree with each other. */
function providerStage(role, id) {
  const status = providerStatusFor(role, id);
  if (!status?.connected) return "key";
  if (!status.model) return "model";
  return activeProviderFor(role) === id ? "active" : "ready";
}

const stageLabels = { key: "Configura", model: "Scegli modello", ready: "Connesso", active: "In uso" };

/* Marks steps done / current / pending, and reveals only as much of the flow as
   the provider has actually reached. The previous panel showed all three steps
   at once and confirmed success in a line that rendered below the fold. */
function paintProviderSteps(role, id, { busy = "" } = {}) {
  const stage = providerStage(role, id);
  const reached = { key: 0, model: 1, ready: 2, active: 2 }[stage];
  const order = ["key", "model", "done"];
  order.forEach((name, index) => {
    const step = providerStep(role, name);
    if (!step) return;
    const done = index < reached || (name === "done" && stage === "active");
    const current = index === reached;
    step.classList.toggle("is-done", done);
    step.classList.toggle("is-current", current && !done);
    step.classList.toggle("is-pending", index > reached);
    step.classList.toggle("is-busy", busy === name);
  });
  const model = providerStatusFor(role, id)?.model;
  providerField(role, "done-hint").textContent = stage === "active"
    ? `${providerCatalog[role][id].name} · ${model || ""}`
    : stage === "ready"
      ? `Chiave e modello pronti. Manca solo di usarlo per questa funzione.`
      : "Scegli un modello per completare la configurazione.";
  providerControl(role, "activate-provider").hidden = stage !== "ready";
  providerControl(role, "remove-provider").hidden = stage === "key";
  /* A saved key collapses to two words and two actions. It only expands back
     into an input when the user asks to replace it. */
  const keyStep = providerStep(role, "key");
  const editing = stage === "key" || keyStep.classList.contains("is-editing");
  keyStep.classList.toggle("is-editing", editing);
  providerControl(role, "connect-provider").textContent = editing ? "Verifica chiave" : "Sostituisci chiave";
  providerField(role, "key").placeholder = stage === "key" ? "Incolla la chiave" : "Incolla una nuova chiave";
  if (!editing) providerField(role, "feedback").textContent = "Chiave salvata sul server.";
}

/* Brings the step the user has to act on into view. Success used to be reported
   in a paragraph that was often several hundred pixels below the fold. */
function revealStep(role, name) {
  const step = providerStep(role, name);
  if (!step) return;
  step.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
}

function flashStep(role, name) {
  const step = providerStep(role, name);
  if (!step) return;
  step.classList.remove("just-completed");
  /* Restart the animation even when the same step completes twice. */
  void step.offsetWidth;
  step.classList.add("just-completed");
}

/* The section header answers "is this set up?" without opening anything. */
function paintSectionSummary(role) {
  const section = providerSection(role);
  if (!section) return;
  const active = activeProviderFor(role);
  const status = active ? providerStatusFor(role, active) : null;
  const ready = Boolean(status?.connected && status.model);
  providerField(role, "summary").textContent = ready
    ? `${providerCatalog[role][active].name} · ${status.model}`
    : "Nessun provider attivo";
  section.classList.toggle("is-configured", ready);
  providerField(role, "summary-dot").dataset.state = ready ? "ready" : "empty";
}

async function loadProviderStatus() {
  try {
    const response = await fetch("/api/providers");
    if (!response.ok) throw new Error();
    const payload = await response.json();
    state.providerStatus = payload.roles || { transcription: payload.providers || {}, note: {} };
    for (const role of providerRoles) {
      const section = providerSection(role); if (!section) continue;
      for (const id of Object.keys(providerCatalog[role])) {
        const stage = providerStage(role, id);
        const label = $(`[data-provider-state="${id}"]`, section);
        if (label) { label.textContent = stageLabels[stage]; label.dataset.stage = stage; }
        $(`[data-provider="${id}"]`, section)?.classList.toggle("is-active", stage === "active");
      }
      paintSectionSummary(role);
      const open = state.selectedProvider[role];
      if (open) paintProviderSteps(role, open);
    }
  } catch {
    for (const role of providerRoles) {
      const section = providerSection(role); if (!section) continue;
      $$("[data-provider-state]", section).forEach((label) => { label.textContent = "Server non avviato"; delete label.dataset.stage; });
      providerField(role, "summary").textContent = "Server non avviato";
    }
  }
}

async function openProviderConfig(role, id) {
  const provider = providerCatalog[role]?.[id]; if (!provider) return;
  state.selectedProvider[role] = id;
  const section = providerSection(role);
  $$(".provider-option", section).forEach((option) => option.classList.toggle("is-open", option.dataset.provider === id));
  providerField(role, "title").textContent = provider.name;
  providerField(role, "logo").src = `assets/images/providers/${id}.svg`;
  providerField(role, "copy").textContent = provider.copy;
  providerField(role, "help").href = provider.help;
  const key = providerField(role, "key"); key.value = ""; key.type = "password";
  providerControl(role, "toggle-secret").textContent = "Mostra";
  providerField(role, "feedback").textContent = "";
  providerField(role, "model-feedback").textContent = "";
  const panel = $("[data-provider-config]", section);
  panel.hidden = false;
  providerStep(role, "key").classList.remove("is-editing");
  paintProviderSteps(role, id);
  const stage = providerStage(role, id);
  if (stage === "key") { revealStep(role, "key"); setTimeout(() => key.focus(), 320); }
  else { revealStep(role, stage === "model" ? "model" : "done"); }
  if (stage !== "key") await loadProviderModels(role, id);
}

async function loadProviderModels(role, id) {
  const select = providerField(role, "model"), feedback = providerField(role, "model-feedback");
  select.disabled = true;
  select.innerHTML = `<option value="">Caricamento modelli…</option>`;
  feedback.textContent = "Carico i modelli dal provider…";
  try {
    const response = await fetch(`/api/providers/${role}/${id}?resource=models`);
    const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Impossibile caricare i modelli.");
    select.innerHTML = `<option value="">Scegli un modello…</option>${payload.models.map((model) => `<option value="${escapeHtml(model.id)}" ${payload.selected === model.id ? "selected" : ""} data-no-translate>${escapeHtml(model.name || model.id)}${model.name && model.name !== model.id ? ` · ${escapeHtml(model.id)}` : ""}</option>`).join("")}`;
    select.disabled = false;
    feedback.textContent = payload.models.length ? `${payload.models.length} modelli disponibili.` : "Il provider non ha restituito modelli utilizzabili.";
  } catch (error) { select.innerHTML = `<option value="">Nessun modello disponibile</option>`; feedback.textContent = error.message; }
}

async function connectProvider(role, button) {
  const id = state.selectedProvider[role]; if (!id) return;
  const input = providerField(role, "key"), feedback = providerField(role, "feedback");
  const keyStep = providerStep(role, "key");
  /* First click on a completed step reveals the field rather than submitting an
     empty one. */
  if (!keyStep.classList.contains("is-editing")) {
    keyStep.classList.add("is-editing");
    button.textContent = "Verifica chiave";
    feedback.textContent = "";
    input.focus();
    return;
  }
  const apiKey = input.value.trim();
  if (!apiKey) { feedback.textContent = "Incolla prima una chiave API."; input.focus(); return; }
  button.disabled = true; button.classList.add("is-busy"); button.textContent = "Verifico…";
  feedback.textContent = "";
  paintProviderSteps(role, id, { busy: "key" });
  try {
    const response = await fetch(`/api/providers/${role}/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey }) });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Chiave non valida.");
    input.value = "";
    await loadProviderStatus();
    paintProviderSteps(role, id);
    flashStep(role, "key");
    feedback.textContent = "Chiave verificata e salvata.";
    announce(`${providerCatalog[role][id].name}: chiave verificata.`);
    await loadProviderModels(role, id);
    revealStep(role, "model");
    setTimeout(() => providerField(role, "model").focus(), 320);
  } catch (error) {
    feedback.textContent = error.message;
    paintProviderSteps(role, id);
    input.focus();
  } finally {
    button.disabled = false; button.classList.remove("is-busy");
    paintProviderSteps(role, id);
  }
}

/* Choosing a model saves and activates it in one move. The old flow needed a
   second click on a button whose label never changed, so the only sign it had
   worked was a sentence rendered off-screen. */
async function chooseProviderModel(role, model) {
  const id = state.selectedProvider[role]; if (!id || !model) return;
  const feedback = providerField(role, "model-feedback"), select = providerField(role, "model");
  select.disabled = true;
  feedback.textContent = "Attivo il modello…";
  paintProviderSteps(role, id, { busy: "model" });
  try {
    const response = await fetch(`/api/providers/${role}/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Modello non salvato.");
    setActiveProvider(role, id);
    await loadProviderStatus();
    paintProviderSteps(role, id);
    flashStep(role, "model"); flashStep(role, "done");
    feedback.textContent = "";
    revealStep(role, "done");
    announce(`${providerCatalog[role][id].name} attivo con ${model}.`);
    if (state.route === "recording") renderDetail();
  } catch (error) {
    feedback.textContent = error.message;
    paintProviderSteps(role, id);
  } finally { select.disabled = false; }
}

/* Reusing a provider that already has a key and a model: one click, no retyping. */
async function activateProvider(role) {
  const id = state.selectedProvider[role]; if (!id) return;
  setActiveProvider(role, id);
  await loadProviderStatus();
  paintProviderSteps(role, id);
  flashStep(role, "done");
  revealStep(role, "done");
  announce(`${providerCatalog[role][id].name} è ora attivo.`);
  if (state.route === "recording") renderDetail();
}

async function removeProvider(role) {
  const id = state.selectedProvider[role];
  if (!id || !confirm(`Rimuovere la chiave ${providerCatalog[role][id].name} da Meleta?`)) return;
  const response = await fetch(`/api/providers/${role}/${id}`, { method: "DELETE" });
  if (!response.ok) { providerField(role, "feedback").textContent = "Non è stato possibile rimuovere la chiave."; return; }
  if (activeProviderFor(role) === id) setActiveProvider(role, "");
  await loadProviderStatus();
  closeProviderConfig(role);
  announce("Chiave rimossa.");
}

function closeProviderConfig(role) {
  const section = providerSection(role); if (!section) return;
  $("[data-provider-config]", section).hidden = true;
  $$(".provider-option", section).forEach((option) => option.classList.remove("is-open"));
  state.selectedProvider[role] = null;
}

/* ---------------------------------------------------------------- AI note --
   The transcript is what was said; the note is that transcript with the damage
   of speech repaired. It is generated deliberately, never automatically: it
   costs the student money, and info.md asks for derived output to be regenerated
   from the transcript the user has approved rather than silently. */

/* Cheap FNV-1a over the transcript, stored with the note so a transcript that
   was re-run or edited afterwards can be reported as out of date instead of
   quietly showing a note that no longer matches. */
function transcriptFingerprint(text = "") {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return `${(hash >>> 0).toString(36)}-${text.length}`;
}

function noteLifecycle(recording) {
  const status = recording.noteStatus || (recording.note?.markdown ? "ready" : "idle");
  if (status === "running") return { key: "running", label: recording.noteProgress ? `Rifinitura in corso · ${recording.noteProgress}` : "Rifinitura in corso" };
  if (status === "failed") return { key: "failed", label: "Rifinitura non riuscita" };
  if (!recording.note?.markdown) return { key: "idle", label: "Nota non ancora generata" };
  if (recording.note.source !== transcriptFingerprint(recording.rawTranscript || "")) return { key: "stale", label: "La trascrizione è cambiata dopo questa nota" };
  return { key: "ready", label: "Nota pronta" };
}

async function setNoteStatus(recording, noteStatus, extra = {}) {
  Object.assign(recording, { noteStatus, updatedAt: new Date().toISOString() }, extra);
  invalidateSearchText(recording.id);
  await db.put("recordings", recording);
  if (state.route === "recording" && state.routeId === recording.id) renderDetail();
}

/* One note at a time, for the same reason transcriptions are serialised: a
   retry storm would fire several multi-chunk jobs at the provider at once. */
let noteQueue = Promise.resolve();

function refineRecordingNote(recordingId) {
  const recording = recordingFor(recordingId);
  if (!recording || !state.settings.activeNoteProvider) return noteQueue;
  if (recording.noteStatus === "running") return noteQueue;
  noteQueue = noteQueue.then(() => runNoteRefinement(recordingId)).catch(() => {});
  return noteQueue;
}

async function runNoteRefinement(recordingId) {
  const recording = recordingFor(recordingId);
  const provider = state.settings.activeNoteProvider;
  if (!recording || !provider) return;
  const transcript = (recording.rawTranscript || "").trim();
  if (!transcript) { await setNoteStatus(recording, "failed", { noteError: "Serve prima una trascrizione." }); return; }
  await setNoteStatus(recording, "running", { noteError: "", noteProgress: "" });
  try {
    const chunks = splitTranscript(transcript);
    const pieces = [];
    let title = "";
    let model = "";
    for (const [index, chunk] of chunks.entries()) {
      if (chunks.length > 1) await setNoteStatus(recording, "running", { noteProgress: `${index + 1}/${chunks.length}` });
      const response = await fetch(`/api/refine?provider=${encodeURIComponent(provider)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        /* Only the first chunk is asked for a title; the rest are told they are
           a continuation so they do not each invent their own heading. */
        body: JSON.stringify({ text: chunk, language: state.settings.inputLanguage, wantTitle: index === 0 }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Rifinitura non riuscita.");
      if (index === 0 && payload.title) title = payload.title;
      model = payload.model || model;
      if (payload.note) pieces.push(payload.note.trim());
    }
    const markdown = pieces.join("\n\n").trim();
    if (!markdown) throw new Error("Il modello non ha restituito una nota.");
    const note = { markdown, title, provider, model, createdAt: new Date().toISOString(), source: transcriptFingerprint(transcript) };
    /* An AI title only fills a gap. A title the student typed is never replaced. */
    const extra = { note, noteProgress: "", noteError: "" };
    if (title && !recording.title?.trim()) extra.title = title;
    await setNoteStatus(recording, "ready", extra);
    state.noteMode = "note";
    if (state.route === "recording" && state.routeId === recording.id) renderDetail();
    announce("Nota rifinita pronta.");
  } catch (error) {
    await setNoteStatus(recording, "failed", { noteProgress: "", noteError: error.message });
    announce(error.message);
  }
}

/* ------------------------------------------------------------- Markdown out --
   The note leaves the app as a plain .md file. Everything the student needs to
   file it later travels in YAML front matter, which is also what an Obsidian
   vault would read if the roadmap ever gets there. */

function yamlValue(value) { return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`; }

function markdownFileFor(recording, mode) {
  const assigned = classFor(recording.classId);
  const title = recordingTitle(recording);
  const created = new Date(recording.createdAt);
  const isNote = mode === "note";
  const fields = [
    ["title", title],
    ["date", Number.isNaN(created.valueOf()) ? "" : created.toISOString()],
    ["subject", assigned?.subject || ""],
    ["room", assigned?.room || ""],
    ["professor", assigned?.professor || ""],
    ["duration", formatDuration(recording.durationSeconds)],
    ["type", isNote ? "nota" : "trascrizione"],
    ["source", `meleta/${(isNote ? [recording.note?.provider, recording.note?.model] : [recording.transcriptionProvider, recording.transcriptionModel]).filter(Boolean).join("/") || "locale"}`],
  ];
  const body = isNote ? (recording.note?.markdown || "") : (recording.rawTranscript || "");
  const markers = recording.markers?.length
    ? `\n\n## Momenti segnati\n\n${recording.markers.map((time) => `- ${formatDuration(time)}`).join("\n")}`
    : "";
  return `---\n${fields.filter(([, value]) => value).map(([key, value]) => `${key}: ${yamlValue(value)}`).join("\n")}\n---\n\n# ${title}\n\n${body}${markers}\n`;
}

function markdownFilename(recording, mode) {
  const created = new Date(recording.createdAt);
  const day = Number.isNaN(created.valueOf()) ? "" : `${created.toISOString().slice(0, 10)}-`;
  const slug = recordingTitle(recording).toLowerCase().normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "nota";
  return `${day}${slug}${mode === "note" ? "" : "-trascrizione"}.md`;
}

function downloadRecordingMarkdown(recordingId, mode = "note") {
  const recording = recordingFor(recordingId); if (!recording) return;
  const blob = new Blob([markdownFileFor(recording, mode)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = markdownFilename(recording, mode);
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  announce("File Markdown scaricato.");
}

/* A deliberately small renderer for the block syntax the note prompt is allowed
   to produce — headings, lists and paragraphs. Text is escaped before any markup
   is added, so model output can never inject HTML. */
function renderNoteMarkdown(markdown = "") {
  return escapeHtml(markdown).split(/\n{2,}/).map((block) => {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return "";
    if (lines.every((line) => /^[-*]\s+/.test(line))) return `<ul>${lines.map((line) => `<li>${line.replace(/^[-*]\s+/, "")}</li>`).join("")}</ul>`;
    if (lines.length === 1 && /^#{1,6}\s+/.test(lines[0])) return `<h3>${lines[0].replace(/^#{1,6}\s+/, "")}</h3>`;
    return `<p>${lines.join("<br>")}</p>`;
  }).join("");
}

function notePanel(recording) {
  const lifecycle = noteLifecycle(recording);
  const provider = state.settings.activeNoteProvider;
  const providerName = providerCatalog.note[provider]?.name || "";
  const generate = (label, className = "button button-primary") => `<button class="${className}" type="button" data-action="refine-note" data-recording-id="${recording.id}">${label}</button>`;
  if (!provider) return `<div class="transcript-empty"><p>Collega un provider della nota nelle Impostazioni per rifinire la trascrizione e ottenere un titolo.</p><a class="text-link" href="#/settings">Apri Impostazioni ›</a></div>`;
  if (!recording.rawTranscript) return `<div class="transcript-empty"><p>La nota si genera dalla trascrizione. Trascrivi prima la registrazione.</p></div>`;
  if (lifecycle.key === "running") return `<div class="transcript-empty"><p>${escapeHtml(lifecycle.label)}.</p><p>Puoi lasciare questa pagina: il lavoro continua.</p></div>`;
  if (lifecycle.key === "failed") return `<div class="transcript-empty"><p>${escapeHtml(recording.noteError || "Rifinitura non riuscita.")}</p>${generate("Riprova")}</div>`;
  if (lifecycle.key === "idle") return `<div class="transcript-empty"><p>${escapeHtml(providerName)} ripulisce grammatica e struttura senza cambiare il contenuto, e propone un titolo.</p>${generate("Genera nota")}</div>`;
  const stale = lifecycle.key === "stale" ? `<p class="note-stale">${escapeHtml(lifecycle.label)}. ${generate("Rigenera", "text-button")}</p>` : "";
  return `${stale}<div class="note-copy" data-no-translate>${renderNoteMarkdown(recording.note.markdown)}</div>`;
}

function recordingRow(recording) {
  const assigned = classFor(recording.classId);
  const lifecycle = recordingLifecycle(recording);
  const pillState = ["ready", "running", "queued", "failed"].includes(lifecycle.key) ? ` data-state="${lifecycle.key}"` : "";
  /* Retry is a sibling of the row button, not nested — nested buttons are invalid
     and would fire both the open and the retry handler on one click. */
  const retry = lifecycle.key === "failed" ? `<button class="row-retry" type="button" data-action="retry-transcription" data-recording-id="${recording.id}">${t("Riprova")}</button>` : "";
  return `<div class="recording-row-wrap${retry ? " has-retry" : ""}"><button class="recording-row" type="button" data-open-recording="${recording.id}"><span class="recording-title" data-no-translate>${escapeHtml(recordingTitle(recording))}</span><span class="recording-subject status-label"><span class="status-dot ${assigned ? "" : "inbox"}"></span><span ${assigned ? "data-no-translate" : ""}>${escapeHtml(assigned?.subject || t("Da organizzare"))}</span></span><span class="recording-meta"><span class="status-pill"${pillState}>${escapeHtml(lifecycle.label)}</span><small>${formatDate(recording.createdAt)} · ${formatDuration(recording.durationSeconds)}</small></span><span class="row-arrow" aria-hidden="true">›</span></button>${retry}</div>`;
}

function renderRecordingList(container, recordings, emptyMessage, showAction = true) {
  container.innerHTML = recordings.length ? `<div class="recording-list">${recordings.map(recordingRow).join("")}</div>` : `<div class="empty-state compact-empty"><p>${emptyMessage}</p>${showAction ? `<button class="button button-primary" data-action="start-unassigned">Registra ora</button>` : ""}</div>`;
}

function renderLibrary() {
  const query = foldForSearch(state.query);
  const filtered = state.recordings.filter((recording) => {
    const assigned = classFor(recording.classId);
    const filterMatch = state.filter === "all" || (state.filter === "inbox" ? !assigned : Boolean(assigned));
    const searchMatch = !query || searchTextFor(recording).includes(query);
    return filterMatch && searchMatch;
  });
  $("#inbox-count").textContent = `(${state.recordings.filter((item) => !classFor(item.classId)).length})`;
  renderRecordingList(els.libraryList, filtered, state.query ? "Nessun risultato corrisponde alla ricerca." : "Le registrazioni salvate compariranno qui.", false);
}

function snapshotDetailPlayer() {
  const audio = $(".meleta-audio", els.detail);
  if (!audio) return;
  state.player = {
    recordingId: audio.dataset.recordingId,
    currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
    playbackRate: audio.playbackRate || 1,
    wasPlaying: !audio.paused && !audio.ended,
  };
}

function playerMarkup(recording, assigned) {
  if (!state.detailUrl) return `<div class="audio-player audio-missing"><p>L’audio di questa registrazione non è più disponibile.</p></div>`;
  const duration = Math.max(1, Math.round(recording.durationSeconds || 0));
  const bars = waveformBars(recording.id).map((height, index, all) => `<i class="player-wave-bar" style="height:${height}%" data-position="${index / Math.max(1, all.length - 1)}" aria-hidden="true"></i>`).join("");
  const markers = (recording.markers || []).filter((time) => time <= duration).map((time, index) => `<button class="player-marker" type="button" data-seek="${time}" style="left:${Math.min(100, time / duration * 100)}%" aria-label="Momento ${index + 1}, ${formatPlayerTime(time)}"></button>`).join("");
  const chapters = (recording.markers || []).slice(0, 5).map((time, index) => `<button class="player-chapter" type="button" data-seek="${time}">Momento ${index + 1} · ${formatPlayerTime(time)}</button>`).join("");
  return `<section class="audio-player meleta-player" data-player-for="${recording.id}"><audio class="meleta-audio" data-recording-id="${recording.id}" preload="metadata" src="${state.detailUrl}">Il browser non supporta la riproduzione audio.</audio><div class="player-heading"><div><strong data-no-translate>${assigned ? escapeHtml(assigned.subject) : escapeHtml(recordingTitle(recording))}</strong><small>${formatDate(recording.createdAt, { weekday: "long", day: "numeric", month: "long" })}</small></div><span class="local-audio-label">Audio locale</span></div><div class="player-wave-shell"><div class="player-waveform">${bars}</div>${markers}<input class="player-scrubber" type="range" min="0" max="${duration}" step="0.1" value="0" aria-label="Posizione nella lezione" /></div><div class="player-times"><time data-player-current>0:00</time><time data-player-duration>${formatPlayerTime(duration)}</time></div><div class="player-controls"><button class="player-speed" type="button" data-player-action="speed" aria-label="Velocità di riproduzione">1×</button><div class="player-transport"><button class="player-skip" type="button" data-player-action="skip" data-seconds="-15" aria-label="Indietro di 15 secondi"><span aria-hidden="true">↶</span><small>15</small></button><button class="player-toggle" type="button" data-player-action="toggle" aria-label="Riproduci la lezione"><span aria-hidden="true">▶</span></button><button class="player-skip" type="button" data-player-action="skip" data-seconds="15" aria-label="Avanti di 15 secondi"><small>15</small><span aria-hidden="true">↷</span></button></div><button class="player-volume" type="button" data-player-action="mute" aria-label="Disattiva audio"><span aria-hidden="true">◖</span></button></div>${chapters ? `<div class="player-chapters" aria-label="Momenti segnati">${chapters}</div>` : ""}</section>`;
}

function updatePlayerInterface(audio) {
  const player = audio.closest(".meleta-player");
  if (!player) return;
  const fallbackDuration = Number(player.querySelector(".player-scrubber")?.max) || 0;
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : fallbackDuration;
  const current = Math.min(audio.currentTime || 0, duration || Infinity);
  const scrubber = $(".player-scrubber", player);
  if (scrubber && !scrubber.matches(":active")) {
    scrubber.max = String(duration || fallbackDuration || 1);
    scrubber.value = String(current);
    scrubber.setAttribute("aria-valuetext", t(`${formatPlayerTime(current)} di ${formatPlayerTime(duration)}`));
  }
  const currentLabel = $("[data-player-current]", player);
  const durationLabel = $("[data-player-duration]", player);
  if (currentLabel) currentLabel.textContent = formatPlayerTime(current);
  if (durationLabel) durationLabel.textContent = formatPlayerTime(duration);
  const fraction = duration ? current / duration : 0;
  $$(".player-wave-bar", player).forEach((bar) => bar.classList.toggle("is-played", Number(bar.dataset.position) <= fraction));
  const toggle = $("[data-player-action=toggle]", player);
  if (toggle) {
    toggle.innerHTML = `<span aria-hidden="true">${audio.paused ? "▶" : "❚❚"}</span>`;
    toggle.setAttribute("aria-label", t(audio.paused ? "Riproduci la lezione" : "Metti in pausa la lezione"));
  }
  const mute = $("[data-player-action=mute]", player);
  if (mute) {
    mute.innerHTML = `<span aria-hidden="true">${audio.muted ? "×" : "◖"}</span>`;
    mute.setAttribute("aria-label", t(audio.muted ? "Riattiva audio" : "Disattiva audio"));
  }
  let activeSegment = null;
  $$(".transcript-segment[data-segment-start]", els.detail).forEach((segment) => {
    if (Number(segment.dataset.segmentStart) <= current) activeSegment = segment;
  });
  $$(".transcript-segment", els.detail).forEach((segment) => {
    const active = segment === activeSegment;
    segment.classList.toggle("is-current", active);
    if (active) segment.setAttribute("aria-current", "true"); else segment.removeAttribute("aria-current");
  });
}

function initDetailPlayer(recording) {
  const audio = $(".meleta-audio", els.detail);
  if (!audio) return;
  const saved = state.player.recordingId === recording.id ? state.player : { currentTime: 0, playbackRate: 1, wasPlaying: false };
  const restore = () => {
    const duration = Number.isFinite(audio.duration) ? audio.duration : recording.durationSeconds;
    audio.currentTime = Math.min(saved.currentTime || 0, Math.max(0, duration || 0));
    audio.playbackRate = saved.playbackRate || 1;
    const speed = $(".player-speed", els.detail); if (speed) speed.textContent = `${audio.playbackRate}×`;
    updatePlayerInterface(audio);
    if (saved.wasPlaying) audio.play().catch(() => {});
  };
  audio.addEventListener("loadedmetadata", restore, { once: true });
  if (audio.readyState >= 1) restore(); else updatePlayerInterface(audio);
  for (const eventName of ["timeupdate", "durationchange", "play", "pause", "ended", "volumechange"]) audio.addEventListener(eventName, () => updatePlayerInterface(audio));
  $(".player-scrubber", els.detail)?.addEventListener("input", (event) => { audio.currentTime = Number(event.target.value); updatePlayerInterface(audio); });
  $(".meleta-player", els.detail)?.addEventListener("click", (event) => {
    const action = event.target.closest("[data-player-action]");
    if (!action) return;
    if (action.dataset.playerAction === "toggle") audio.paused ? audio.play().catch(() => {}) : audio.pause();
    if (action.dataset.playerAction === "skip") audio.currentTime = Math.max(0, Math.min(audio.duration || recording.durationSeconds || 0, audio.currentTime + Number(action.dataset.seconds)));
    if (action.dataset.playerAction === "mute") audio.muted = !audio.muted;
    if (action.dataset.playerAction === "speed") {
      const speeds = [1, 1.25, 1.5, 2];
      audio.playbackRate = speeds[(speeds.indexOf(audio.playbackRate) + 1) % speeds.length];
      action.textContent = `${audio.playbackRate}×`;
    }
    updatePlayerInterface(audio);
  });
}

/* Audio is fetched only for the recording being viewed. It used to be held in
   memory for every recording at once, which grew without bound. */
async function renderDetail() {
  snapshotDetailPlayer();
  const recording = recordingFor(state.routeId);
  if (recording?.id !== state.detailAudioId) releaseDetailAudio();
  if (!recording) {
    els.detail.innerHTML = `<div class="empty-state"><h2>Registrazione non trovata</h2><p>Potrebbe essere stata eliminata.</p><a class="button button-primary" href="#/library">Torna alla raccolta</a></div>`;
    return;
  }
  const assigned = classFor(recording.classId);
  const detailToken = Symbol("detail");
  state.detailToken = detailToken;
  /* Progress updates re-render this view repeatedly; loading the blob again each
     time would restart playback, so an existing URL for the same recording is
     kept. */
  if (state.detailAudioId !== recording.id) {
    const stored = recording.hasAudio === false ? null : await db.get("audio", recording.id).catch(() => null);
    /* The view may have moved on while the blob was being read. */
    if (state.detailToken !== detailToken) return;
    state.detailUrl = stored?.blob ? URL.createObjectURL(stored.blob) : null;
    state.detailAudioId = recording.id;
  }
  const weekdays = getLocale() === "en" ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] : ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];
  const options = sortClasses(state.classes).map((item) => `<option value="${item.id}" ${item.id === recording.classId ? "selected" : ""}>${escapeHtml(item.subject)} · ${weekdays[item.weekday]} ${escapeHtml(item.startTime)}</option>`).join("");
  const transcriptContent = recording.segments?.length ? renderSegments(recording) : recording.rawTranscript ? `<p class="transcript-copy" data-no-translate>${escapeHtml(recording.rawTranscript)}</p>` : `<div class="transcript-empty"><p>Collega un provider nelle Impostazioni per generare la trascrizione.</p><a class="text-link" href="#/settings">Apri Impostazioni ›</a></div>`;
  const player = playerMarkup(recording, assigned);
  const transcriptionPanel = renderTranscriptionPanel(recording);
  const lifecycle = recordingLifecycle(recording);
  /* Two readings of the same lecture: what was said, and what it reads like once
     the AI has repaired it. Each is downloadable on its own. */
  const noteReady = Boolean(recording.note?.markdown);
  const mode = state.noteMode === "note" && (noteReady || recording.rawTranscript) ? "note" : "transcript";
  const canDownload = mode === "note" ? noteReady : Boolean(recording.rawTranscript);
  const noteHeading = `<div class="note-section-heading"><div class="note-modes" role="group" aria-label="Vista della lezione">`
    + `<button class="note-mode${mode === "transcript" ? " is-selected" : ""}" type="button" data-note-mode="transcript" aria-pressed="${mode === "transcript"}">Trascrizione</button>`
    + `<button class="note-mode${mode === "note" ? " is-selected" : ""}" type="button" data-note-mode="note" aria-pressed="${mode === "note"}">Nota rifinita</button>`
    + `</div><button class="button button-secondary note-download" type="button" data-action="download-md" data-recording-id="${recording.id}" data-mode="${mode}" ${canDownload ? "" : "disabled"}>Scarica .md</button></div>`;
  els.detail.innerHTML = `<header class="detail-header"><div><p class="eyebrow" ${assigned ? "data-no-translate" : ""}>${assigned ? escapeHtml(assigned.subject) : "Da organizzare"}</p><h1 id="detail-title" class="editable-title" contenteditable="true" spellcheck="true" data-edit-title="${recording.id}">${escapeHtml(recordingTitle(recording))}</h1><p class="detail-meta">${formatDate(recording.createdAt)} · ${formatDuration(recording.durationSeconds)}</p></div><div class="detail-state" data-state="${lifecycle.key}"><span aria-hidden="true"></span><div><strong>${escapeHtml(lifecycle.label)}</strong><small>${escapeHtml(lifecycle.detail)}</small></div></div></header>${journeyProgress(recording)}<div class="study-workspace"><section class="transcript-card">${noteHeading}${mode === "note" ? notePanel(recording) : transcriptContent}${recording.translation ? `<section class="saved-translation"><h3>Traduzione</h3><p>${escapeHtml(recording.translation)}</p></section>` : ""}</section><aside class="study-rail">${player}</aside></div><div class="detail-utilities">${transcriptionPanel}<section class="detail-card"><h3>Lezione associata</h3>${state.classes.length ? `<label class="field-label" for="detail-class">Assegna o sposta</label><select class="select-field" id="detail-class" data-assign-detail="${recording.id}"><option value="">Da organizzare</option>${options}</select>` : `<p>Non hai ancora creato lezioni.</p><a class="text-link" href="#/calendar">Crea una lezione ›</a>`}${recording.markers?.length ? `<p class="marker-list"><strong>Momenti segnati</strong><br>${recording.markers.map(formatDuration).join(" · ")}</p>` : ""}</section></div><button class="text-button danger-action detail-delete" data-action="delete-recording" data-recording-id="${recording.id}">Elimina registrazione</button>`;
  initDetailPlayer(recording);
}

/* Plain-language progress for the one long-running job in the app, plus the
   retry action that a failed transcription previously left the user without. */
function renderTranscriptionPanel(recording) {
  if (!state.settings.activeProvider) {
    return `<section class="detail-card"><h3>Nessun provider di trascrizione</h3><a class="text-link" href="#/settings">Apri Impostazioni ›</a></section>`;
  }
  const providerName = providers[state.settings.activeProvider]?.name || "";
  const status = recording.transcriptionStatus || (recording.rawTranscript ? "ready" : "pending");
  const retry = `<button class="button button-secondary" data-action="retry-transcription" data-recording-id="${recording.id}">Riprova la trascrizione</button>`;
  if (status === "queued") {
    return `<section class="detail-card"><h3>In coda</h3></section>`;
  }
  if (status === "running") {
    const progress = recording.transcriptionProgress ? ` · ${escapeHtml(recording.transcriptionProgress)}` : "";
    return `<section class="detail-card"><h3>Trascrizione in corso${progress}</h3></section>`;
  }
  if (status === "failed") {
    return `<section class="detail-card"><h3>Trascrizione non riuscita</h3><p>${escapeHtml(recording.transcriptionError || "")}</p>${retry}</section>`;
  }
  if (status === "ready") {
    return `<section class="detail-card"><h3>Trascrizione completata</h3><p>${escapeHtml(providerName)}</p>${retry}</section>`;
  }
  return `<section class="detail-card"><h3>Pronta da trascrivere</h3><p>${escapeHtml(providerName)}</p><button class="button button-primary" data-action="retry-transcription" data-recording-id="${recording.id}">Trascrivi ora</button></section>`;
}

/* Segments carry their own time and confidence, so the transcript can seek the
   audio and can mark what the model was unsure about instead of presenting every
   word as equally certain. */
function renderSegments(recording) {
  const rows = recording.segments.map((segment) => {
    const uncertain = segment.noSpeech || (segment.confidence !== null && segment.confidence < 0.55);
    const title = uncertain ? ' title="Audio poco chiaro: verifica questo passaggio"' : "";
    return `<button class="transcript-segment${uncertain ? " is-uncertain" : ""}" type="button" data-seek="${segment.start}" data-segment-start="${segment.start}"${title}><span class="segment-time">${formatDuration(Math.floor(segment.start))}</span><span class="segment-text" data-no-translate>${escapeHtml(segment.text)}</span></button>`;
  }).join("");
  const uncertainCount = recording.segments.filter((segment) => segment.noSpeech || (segment.confidence !== null && segment.confidence < 0.55)).length;
  const notice = uncertainCount ? `<p class="uncertain-notice">${uncertainCount} passaggi con audio poco chiaro sono evidenziati.</p>` : "";
  return `${notice}<div class="transcript-segments">${rows}</div>`;
}

function releaseDetailAudio() {
  if (state.detailUrl) URL.revokeObjectURL(state.detailUrl);
  state.detailUrl = null;
  state.detailAudioId = null;
}

async function startRecording(classId = null) {
  if (recorder.state !== "idle") { location.hash = "#/today"; return announce("Una registrazione è già in corso."); }
  state.recordingClassId = classId;
  state.markers = [];
  state.transcriptFinal = ""; state.transcriptInterim = ""; state.transcriptSegments = []; state.renderedSegments = 0; state.translationFinal = ""; state.translationInterim = ""; state.transcriptStatus = "Avvio anteprima…";
  state.activeDraftId = makeId("draft");
  state.draftCreatedAt = new Date().toISOString();
  state.chunkSequence = 0;
  state.chunkWrites = new Set();
  state.bufferHealthy = true; state.bufferMessage = "";
  await checkStorageHeadroom();
  location.hash = "#/today";
  renderToday();
  try {
    await recorder.start(state.settings.audioDeviceId || null);
    await persistDraft();
    transcriber.start(state.settings);
    startTick();
    renderRecordingPanel();
    announce("Registrazione iniziata. Puoi cambiare scheda, ma non chiudere la finestra.");
  } catch (error) {
    transcriber.stop();
    if (recorder.state !== "idle") recorder.discard();
    if (state.activeDraftId) await db.delete("drafts", state.activeDraftId).catch(() => {});
    state.activeDraftId = null;
    if (error.message === "unsupported") announce("Questo browser non supporta la registrazione audio.");
    else if (error.name === "NotAllowedError") announce("Accesso al microfono negato. Abilitalo nelle impostazioni del browser.");
    else if (error.name === "NotFoundError") announce("Nessun microfono disponibile.");
    else announce("Non riesco ad avviare il microfono. Controlla l’ingresso audio e riprova.");
    renderToday();
  }
}

function startTick() {
  clearInterval(state.tickId);
  let ticks = 0;
  state.tickId = setInterval(() => {
    const timer = $(".recording-timer"); if (timer && state.route === "today" && recorder.state !== "idle") timer.textContent = formatDuration(recorder.elapsedSeconds);
    syncHeaderAction();
    /* Refresh the draft periodically so a crash recovers a duration close to the
       truth, without writing a record every single second. */
    ticks += 1;
    if (ticks % 15 === 0 && recorder.state === "recording") persistDraft();
  }, 1000);
}

async function stopRecording() {
  clearInterval(state.tickId);
  const result = await recorder.stop();
  await Promise.allSettled([...state.chunkWrites, state.draftPersist]);
  if (!result?.audio.size) return announce("Non è stato acquisito audio. La registrazione non è stata salvata.");
  recorder.setState("saving"); renderRecordingPanel();
  transcriber.stop();
  const recording = { id: makeId("rec"), title: "", createdAt: state.draftCreatedAt || new Date().toISOString(), updatedAt: new Date().toISOString(), durationSeconds: result.durationSeconds, classId: state.recordingClassId, markers: [...state.markers], mimeType: result.audio.type, hasAudio: true, rawTranscript: state.transcriptFinal.trim(), translation: state.translationFinal.trim(), status: state.transcriptFinal ? "preview-ready" : "saved-locally", transcriptionStatus: "pending" };
  try {
    /* One transaction across both stores: either the lecture is fully saved or
       nothing is written. The draft is only cleared once that has committed, so
       a failure leaves the chunk buffer for the next launch to recover. */
    await db.write(["audio", "recordings"], ([audio, recordings]) => {
      audio.put({ id: recording.id, blob: result.audio });
      recordings.put(recording);
    });
    await clearActiveDraft();
    state.recordings.unshift(recording); invalidateAttachments();
    state.recordingClassId = null; state.markers = []; state.transcriptFinal = ""; state.transcriptInterim = ""; state.translationFinal = ""; state.translationInterim = "";
    recorder.setState("idle"); renderToday();
    announce("Registrazione salvata in questo browser.");
    location.hash = `#/recording/${recording.id}`;
    transcribeSavedAudio(recording.id);
  } catch {
    recorder.setState("idle"); renderToday();
    const url = URL.createObjectURL(result.audio);
    const link = document.createElement("a"); link.href = url; link.download = `maleta-${Date.now()}.webm`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce("Spazio locale non disponibile. Ho preparato il download dell’audio per non perderlo.");
  }
}

async function discardRecording() {
  if (!confirm("Eliminare la registrazione in corso? L’audio non potrà essere recuperato.")) return;
  clearInterval(state.tickId); transcriber.stop(); recorder.discard();
  state.recordingClassId = null; state.markers = []; state.transcriptFinal = ""; state.transcriptInterim = ""; state.translationFinal = ""; state.translationInterim = "";
  renderToday();
  /* Awaited: a fire-and-forget delete left the draft behind if the tab closed
     straight after, and the discarded lecture came back on the next launch. */
  try { await clearActiveDraft(); announce("Registrazione eliminata."); }
  catch { announce("Non è stato possibile eliminare del tutto la registrazione. Riprova."); }
}

async function clearActiveDraft() {
  if (!state.activeDraftId) return;
  const draftId = state.activeDraftId;
  await state.draftPersist.catch(() => {});
  await db.deleteByPrefix("chunks", `${draftId}_`);
  await db.delete("drafts", draftId);
  state.activeDraftId = null; state.draftCreatedAt = null; state.chunkWrites = new Set(); state.chunkSequence = 0;
}

async function assignRecording(recordingId, classId) {
  const recording = recordingFor(recordingId); if (!recording) return;
  recording.classId = classId || null; recording.updatedAt = new Date().toISOString();
  invalidateSearchText(recording.id); invalidateAttachments();
  await db.put("recordings", recording);
  if (state.route === "today") renderToday(); else if (state.route === "recording") renderDetail(); else renderLibrary();
  announce(classId ? "Registrazione assegnata." : "Registrazione spostata in Da organizzare.");
}

async function deleteRecording(id) {
  const recording = recordingFor(id); if (!recording || !confirm(`Eliminare “${recordingTitle(recording)}”? Audio e metadati verranno rimossi definitivamente da questo browser.`)) return;
  await db.write(["audio", "recordings"], ([audio, recordings]) => {
    audio.delete(id);
    recordings.delete(id);
  });
  invalidateSearchText(id); invalidateAttachments();
  state.recordings = state.recordings.filter((item) => item.id !== id);
  announce("Registrazione eliminata."); location.hash = "#/library";
}

recorder.addEventListener("statechange", () => { syncHeaderAction(); if (state.route === "today") renderRecordingPanel(); if (state.route === "calendar") { invalidateAttachments(); renderCalendar(); } });
recorder.addEventListener("level", (event) => {
  const level = Math.max(4, event.detail), meter = $(".level-meter span"); if (meter) meter.style.width = `${level}%`;
  $$(".listening-bars i").forEach((bar, index) => { const variation = [0.72, 1, 0.82][index]; bar.style.transform = `scaleY(${Math.max(.28, level / 55 * variation)})`; });
  $$(".live-waveform>i").forEach((bar, index) => {
    const variation = .38 + Math.abs(Math.sin(index * .54 + level * .03)) * .72;
    bar.style.transform = `scaleY(${Math.max(.16, level / 62 * variation)})`;
  });
  const glow = $(".listening-glow"); if (glow) glow.style.opacity = String(Math.min(.9, .3 + level / 130));
});
recorder.addEventListener("chunk", (event) => {
  if (!state.activeDraftId) return;
  const sequence = state.chunkSequence++;
  /* Tracked in a Set that empties as writes settle, so a long lecture does not
     accumulate thousands of promises. A rejection used to vanish silently while
     the panel kept reporting that everything was being saved. */
  const write = db.put("chunks", { id: `${state.activeDraftId}_${String(sequence).padStart(8, "0")}`, draftId: state.activeDraftId, sequence, audio: event.detail })
    .catch(() => reportBufferFailure())
    .finally(() => state.chunkWrites.delete(write));
  state.chunkWrites.add(write);
});
recorder.addEventListener("previewchunk", (event) => transcriber.pushChunk(event.detail));
/* A level bar does not tell a student the microphone is muted or the input is
   clipping. Both are unrecoverable after the lecture, so they are said plainly. */
recorder.addEventListener("inputwarning", (event) => {
  if (event.detail.kind === "silence") raiseAlert("Non sento nulla dal microfono. Controlla che non sia disattivato.");
  if (event.detail.kind === "clipping") raiseAlert("L’audio è troppo forte e viene distorto. Allontana il microfono o abbassa il volume d’ingresso.");
});
recorder.addEventListener("wakelockfailed", () => announce("Questo browser non può impedire lo spegnimento dello schermo. Tieni il dispositivo attivo."));

/* An unplugged microphone ends the track. The capture so far is safe, but the
   student needs to know immediately rather than discovering it afterwards. */
navigator.mediaDevices?.addEventListener?.("devicechange", async () => {
  if (state.route === "settings") renderAudioDevices();
  if (recorder.state !== "recording" && recorder.state !== "paused") return;
  const inputs = await listAudioInputs();
  if (!inputs.length) raiseAlert("Nessun microfono disponibile. Termina e salva per non perdere la lezione.");
});
transcriber.addEventListener("status", (event) => { state.transcriptStatus = event.detail.label; if (state.route === "today" && recorder.state !== "idle") renderRecordingPanel(); });
transcriber.addEventListener("transcript", (event) => {
  if (event.detail.finalText) {
    state.transcriptFinal += `${state.transcriptFinal ? " " : ""}${event.detail.finalText}`;
    state.transcriptSegments.push(event.detail.finalText);
    state.animateLatestTranscript = true;
    persistDraft();
  }
  state.transcriptInterim = event.detail.interimText || "";
  /* Appending the new line beats rebuilding the stream: the old path re-created
     every previous line on each update, so cost grew with the square of the
     lecture length on the one screen that has to stay responsive. */
  if (state.route === "today" && !appendTranscriptLines()) renderRecordingPanel();
});
transcriber.addEventListener("translation", (event) => { if (event.detail.finalText) { state.translationFinal += `${state.translationFinal ? " " : ""}${event.detail.finalText}`; persistDraft(); } state.translationInterim = event.detail.interimText || ""; if (state.route === "today") renderRecordingPanel(); });

document.addEventListener("click", (event) => {
  const seek = event.target.closest("[data-seek]");
  if (seek) {
    const player = $(".audio-player audio");
    if (player) { player.currentTime = Number(seek.dataset.seek) || 0; player.play().catch(() => {}); }
  }
  const open = event.target.closest("[data-open-recording]");
  if (open) location.hash = `#/recording/${open.dataset.openRecording}`;
  const noteMode = event.target.closest("[data-note-mode]");
  if (noteMode) { state.noteMode = noteMode.dataset.noteMode; renderDetail(); return; }
  const filter = event.target.closest("[data-filter]");
  if (filter) { state.filter = filter.dataset.filter; $$('[data-filter]').forEach((button) => { const selected = button === filter; button.classList.toggle("is-selected", selected); button.setAttribute("aria-pressed", selected); }); renderLibrary(); }
  const target = event.target.closest("[data-action]"); if (!target) return;
  const action = target.dataset.action;
  if (action === "open-inbox") {
    state.filter = "inbox";
    location.hash = "#/library";
    setTimeout(() => { $$('[data-filter]').forEach((button) => { const selected = button.dataset.filter === "inbox"; button.classList.toggle("is-selected", selected); button.setAttribute("aria-pressed", selected); }); renderLibrary(); }, 0);
  }
  if (action === "start-unassigned") startRecording();
  if (action === "return-recording") location.hash = "#/today";
  if (action === "start-class") startRecording(target.dataset.classId);
  if (action === "toggle-pause") { if (recorder.state === "paused") { recorder.resume(); transcriber.resume(state.settings); } else { recorder.pause(); transcriber.pause(); } }
  if (action === "mark") {
    state.markers.push(recorder.elapsedSeconds);
    persistDraft();
    announce(`Momento segnato a ${formatDuration(recorder.elapsedSeconds)}.`);
  }
  if (action === "stop-recording") stopRecording();
  if (action === "discard-recording") discardRecording();
  if (action === "delete-recording") deleteRecording(target.dataset.recordingId);
  if (action === "retry-transcription") transcribeSavedAudio(target.dataset.recordingId);
  if (action === "dismiss-alert") dismissAlert();
  const role = target.closest("[data-provider-section]")?.dataset.providerSection;
  if (action === "close-provider") closeProviderConfig(role);
  if (action === "toggle-secret") { const input = providerField(role, "key"); input.type = input.type === "password" ? "text" : "password"; target.textContent = input.type === "password" ? "Mostra" : "Nascondi"; }
  if (action === "connect-provider") connectProvider(role, target);
  if (action === "activate-provider") activateProvider(role);
  if (action === "remove-provider") removeProvider(role);
  if (action === "refine-note") refineRecordingNote(target.dataset.recordingId);
  if (action === "download-md") downloadRecordingMarkdown(target.dataset.recordingId, target.dataset.mode);
  if (action === "delete-all-data") {
    if (!confirm("Eliminare definitivamente tutte le registrazioni, le lezioni e le impostazioni salvate in questo browser?")) return;
    Promise.all([db.clear("recordings"), db.clear("audio"), db.clear("classes"), db.clear("drafts"), db.clear("chunks")]).then(() => { localStorage.removeItem("maleta-settings"); state.recordings = []; state.classes = []; loadSettings(); renderSettings(); announce("Tutti i dati locali sono stati eliminati."); });
  }
});

document.addEventListener("change", (event) => {
  if (event.target.matches("[data-assign-detail]")) assignRecording(event.target.dataset.assignDetail, event.target.value);
  if (event.target.matches('[data-field="model"]')) {
    const role = event.target.closest("[data-provider-section]")?.dataset.providerSection;
    if (role && event.target.value) chooseProviderModel(role, event.target.value);
  }
});

document.addEventListener("focusout", async (event) => {
  if (!event.target.matches("[data-edit-title]")) return;
  const recording = recordingFor(event.target.dataset.editTitle); if (!recording) return;
  const title = event.target.textContent.trim();
  if (!title) { event.target.textContent = recordingTitle(recording); return announce("Il titolo non può essere vuoto."); }
  recording.title = title; recording.updatedAt = new Date().toISOString(); invalidateSearchText(recording.id); await db.put("recordings", recording); announce("Titolo salvato.");
});

let searchTimer;
els.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = els.search.value.trim(); renderLibrary(); }, 150);
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); location.hash = "#/library"; setTimeout(() => els.search.focus(), 0); }
});
els.settingsForm.addEventListener("submit", (event) => { event.preventDefault(); saveSettings(); });
els.settingsForm.addEventListener("click", (event) => { const option = event.target.closest("[data-provider]"); if (option) openProviderConfig(option.closest("[data-provider-section]").dataset.providerSection, option.dataset.provider); });
els.settingsForm.addEventListener("toggle", (event) => { if (event.target.matches("[data-provider-section]")) event.target.dataset.touched = "1"; }, true);
window.addEventListener("hashchange", renderRoute);
/* A background tab suspends the AudioContext. MediaRecorder keeps writing audio,
   but the preview taps stop, so the live transcript would freeze with no
   explanation in exactly the case the app tells students is supported. */
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || recorder.state !== "recording") return;
  /* The browser drops the wake lock whenever the page is hidden. */
  await recorder.requestWakeLock();
  if (!recorder.meterSuspended) return;
  const resumed = await recorder.resumeContext();
  if (!resumed) announce("L’anteprima live è in pausa mentre la scheda è in secondo piano. L’audio continua a essere registrato.");
  if (state.route === "today") renderRecordingPanel();
});
window.addEventListener("beforeunload", (event) => { if (["recording", "paused"].includes(recorder.state)) { event.preventDefault(); event.returnValue = ""; } });
window.addEventListener("pagehide", () => { if (state.detailUrl) URL.revokeObjectURL(state.detailUrl); });

async function init() {
  initI18n();
  loadSettings();
  try {
    await loadData();
  } catch {
    document.querySelector("main").innerHTML = `<section class="page-shell empty-state"><h1>Impossibile aprire l’archivio locale</h1><p>Controlla che il browser consenta l’archiviazione dei dati per questo sito, quindi ricarica la pagina.</p></section>`;
    return;
  }
  try {
    initCalendar({
      root: els.calendarRoot, state, makeId, announce,
      persist: persistClass, remove: removeClass,
      startRecording: (classId) => startRecording(classId),
      openRecording: (occurrence) => {
        const recording = recordingForOccurrence(occurrence);
        if (recording) location.hash = `#/recording/${recording.id}`;
        return Boolean(recording);
      },
      statusFor: calendarStatus,
    });
    renderRoute();
  } catch (error) {
    /* Storage opened fine, so this is an interface failure. Saying so points at
       the real problem instead of sending the student to browser settings. */
    console.error(error);
    raiseAlert("Si è verificato un errore nell’interfaccia. Ricarica la pagina.");
  }
}
init();
