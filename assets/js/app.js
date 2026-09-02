import { db, makeId } from "./db.js";
import { AudioRecorder } from "./recorder.js";
import { LiveTranscriber } from "./transcriber.js";
import { initCalendar, renderCalendar, currentOrNextOccurrence, dateKey } from "./calendar.js";

const state = {
  recordings: [], classes: [], route: "today", routeId: null,
  filter: "all", query: "", recordingClassId: null,
  markers: [], tickId: null, detailUrl: null, activeDraftId: null,
  chunkSequence: 0, chunkWrites: [],
  transcriptFinal: "", transcriptInterim: "", translationFinal: "", translationInterim: "", transcriptStatus: "Anteprima pronta",
  transcriptSegments: [], animateLatestTranscript: false,
  settings: { livePreview: true, inputLanguage: "auto", activeProvider: "" }, providerStatus: {}, selectedProvider: null,
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
};
let toastTimer;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
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

function formatDate(value, options = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) {
  return new Intl.DateTimeFormat("it-IT", options).format(new Date(value));
}

function classFor(id) { return state.classes.find((item) => item.id === id); }
function recordingFor(id) { return state.recordings.find((item) => item.id === id); }
function sortClasses(items) { return [...items].sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime)); }
function recordingTitle(recording) { return recording.title?.trim() || `Registrazione del ${formatDate(recording.createdAt)}`; }

async function loadData() {
  await recoverInterruptedRecordings();
  [state.recordings, state.classes] = await Promise.all([db.all("recordings"), db.all("classes")]);
  state.recordings.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function recoverInterruptedRecordings() {
  const drafts = await db.all("drafts");
  if (!drafts.length) return;
  const chunks = await db.all("chunks");
  for (const draft of drafts) {
    const savedChunks = chunks.filter((chunk) => chunk.draftId === draft.id).sort((a, b) => a.sequence - b.sequence);
    if (savedChunks.length) {
      const audio = new Blob(savedChunks.map((chunk) => chunk.audio), { type: draft.mimeType || savedChunks[0].audio.type || "audio/webm" });
      await db.put("recordings", { id: makeId("rec"), title: "Registrazione recuperata", createdAt: draft.createdAt, updatedAt: new Date().toISOString(), durationSeconds: savedChunks.length, classId: draft.classId || null, markers: draft.markers || [], mimeType: audio.type, audio, status: "recovered" });
    }
    await Promise.all(savedChunks.map((chunk) => db.delete("chunks", chunk.id)));
    await db.delete("drafts", draft.id);
  }
}

function parseRoute() {
  const parts = (location.hash || "#/today").slice(2).split("/");
  const route = ["today", "library", "calendar", "recording", "settings"].includes(parts[0]) ? parts[0] : "today";
  state.route = route;
  state.routeId = parts[1] || null;
}

function renderRoute() {
  parseRoute();
  els.views.forEach((view) => { view.hidden = view.dataset.view !== state.route; });
  $$('[data-nav]').forEach((link) => {
    const active = link.dataset.nav === state.route || (state.route === "recording" && link.dataset.nav === "library");
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  });
  if (state.route === "today") renderToday();
  if (state.route === "library") renderLibrary();
  if (state.route === "calendar") renderCalendar();
  if (state.route === "recording") renderDetail();
  if (state.route === "settings") renderSettings();
  scrollTo({ top: 0, behavior: "smooth" });
}

function currentOrNextClass() {
  const found = currentOrNextOccurrence();
  if (!found) return null;
  const when = new Date(found.occurrence.date);
  when.setMinutes(found.occurrence.startMinutes);
  return { item: found.occurrence, label: found.active ? "In corso" : formatDate(when, { weekday: "long", hour: "2-digit", minute: "2-digit" }) };
}

/* Status shown on a calendar block. Colour never carries this alone: the
   calendar always prints the label next to the marker. */
function calendarStatus(occurrence) {
  const today = dateKey(new Date());
  if (state.recordingClassId === occurrence.eventId && recorder.state !== "idle" && occurrence.key === today) return { tone: "live", label: "In registrazione" };
  const attached = state.recordings.filter((recording) => recording.classId === occurrence.eventId && dateKey(new Date(recording.createdAt)) === occurrence.key);
  if (attached.length) {
    const ready = attached.filter((recording) => recording.rawTranscript).length;
    if (ready) return { tone: "ready", label: ready > 1 ? `${ready} note pronte` : "Nota pronta" };
    return { tone: "pending", label: attached.length > 1 ? `${attached.length} registrazioni` : "Registrazione salvata" };
  }
  const end = new Date(occurrence.date);
  end.setMinutes(occurrence.endMinutes);
  return end < new Date() ? { tone: "empty", label: "Nessuna registrazione" } : null;
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
    els.todayContext.innerHTML = `<article class="today-card no-class"><div><p class="eyebrow">Nessuna lezione programmata</p><h2>Registra senza assegnazione</h2><p class="today-card-meta">La troverai nella sezione “Da organizzare”.</p></div><button class="button button-primary context-action" data-action="start-unassigned">Inizia a registrare</button></article>`;
  } else {
    const item = context.item;
    els.todayContext.innerHTML = `<article class="today-card"><div class="class-time"><span>${escapeHtml(item.startTime)}</span><span>—</span><span>${escapeHtml(item.endTime)}</span></div><div><p class="eyebrow">${escapeHtml(context.label)}</p><h2>${escapeHtml(item.subject)}</h2><p class="today-card-meta">${escapeHtml([item.room, item.professor].filter(Boolean).join(" · ") || "Lezione programmata")}</p></div><button class="button button-primary context-action" data-action="start-class" data-class-id="${item.eventId}">Registra questa lezione</button></article>`;
  }
  renderRecordingPanel();
  renderRecordingList(els.recentList, state.recordings.slice(0, 5), "Non hai ancora registrato nulla.");
}

function renderRecordingPanel() {
  const active = recorder.state !== "idle";
  els.recordingPanel.hidden = !active;
  els.todayContext.hidden = active;
  if (!active) return;
  const assigned = classFor(state.recordingClassId);
  const label = ({ "requesting-permission": "In attesa del microfono", recording: "Registrazione in corso", paused: "Registrazione in pausa", finalizing: "Preparazione dell’audio", saving: "Salvataggio locale", "input-ended": "Microfono scollegato", error: "Problema di registrazione" })[recorder.state] || "Registrazione";
  const canControl = ["recording", "paused"].includes(recorder.state);
  els.recordingPanel.classList.toggle("is-paused", recorder.state === "paused");
  const interim = escapeHtml(state.transcriptInterim);
  const lines = state.transcriptSegments.length ? state.transcriptSegments.map((segment, index) => `<p class="transcript-line ${state.animateLatestTranscript && index === state.transcriptSegments.length - 1 ? "is-new" : ""}">${escapeHtml(segment)}</p>`).join("") : `<p class="transcript-placeholder">Inizia a parlare. Le nuove frasi appariranno qui, una alla volta.</p>`;
  els.recordingPanel.innerHTML = `<div class="recording-header"><div><div class="recording-state"><span class="recording-dot" aria-hidden="true"></span><span>${label}</span></div><p class="recording-context">${assigned ? escapeHtml(assigned.subject) : "Registrazione non assegnata"} · Microfono del dispositivo</p></div><time class="recording-timer">${formatDuration(recorder.elapsedSeconds)}</time></div><div class="audio-activity"><span class="level-meter" aria-label="Livello del microfono"><span style="width:4%"></span></span><span>Ingresso audio</span></div><div class="live-preview"><div class="preview-heading"><div><p class="eyebrow">Trascrizione live</p><h2>Anteprima della lezione</h2></div><span class="preview-status">${escapeHtml(state.transcriptStatus)}</span></div><div class="transcript-scroll" aria-live="polite" aria-relevant="additions text"><div class="transcript-stream">${lines}${interim ? `<p class="transcript-line interim-text">${interim}</p>` : ""}<div class="listening-line" aria-hidden="true"><span class="listening-glow"></span><span class="listening-bars"><i></i><i></i><i></i></span><span class="listening-label">In ascolto</span></div></div></div></div><div class="recording-footer"><p class="recording-help">L’audio viene salvato localmente mentre registri. Non chiudere la finestra.</p><div class="recording-actions"><button class="button button-secondary" data-action="toggle-pause" ${canControl ? "" : "disabled"}>${recorder.state === "paused" ? "Riprendi" : "Pausa"}</button><button class="button button-secondary" data-action="mark" ${canControl ? "" : "disabled"}>Segna</button><button class="button button-primary save-action" data-action="stop-recording" ${canControl || recorder.state === "input-ended" || recorder.state === "error" ? "" : "disabled"}>Termina e salva</button><button class="text-button discard-link" data-action="discard-recording" ${canControl ? "" : "disabled"}>Elimina</button></div></div>`;
  requestAnimationFrame(() => { const viewport = $(".transcript-scroll"); if (viewport) viewport.scrollTo({ top: viewport.scrollHeight, behavior: state.transcriptSegments.length > 1 ? "smooth" : "auto" }); state.animateLatestTranscript = false; });
}

async function renderSettings() {
  const form = els.settingsForm;
  Object.entries(state.settings).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].type === "checkbox" ? form.elements[key].checked = value : form.elements[key].value = value; });
  await loadProviderStatus();
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("maleta-settings") || "{}");
    state.settings = { livePreview: saved.livePreview !== false, inputLanguage: saved.inputLanguage || "auto", activeProvider: saved.activeProvider || "" };
  } catch { /* use safe defaults */ }
}

function saveSettings() {
  const data = new FormData(els.settingsForm);
  state.settings = { ...state.settings, livePreview: data.get("livePreview") === "on", inputLanguage: data.get("inputLanguage") };
  localStorage.setItem("maleta-settings", JSON.stringify(state.settings));
  els.settingsStatus.textContent = "Impostazioni salvate";
  announce("Impostazioni salvate.");
}

const providers = {
  openai: { name: "OpenAI", help: "https://platform.openai.com/api-keys", copy: "Crea una chiave API nel progetto OpenAI che userai per Maleta. La connessione viene verificata contro l’elenco modelli ufficiale." },
  groq: { name: "Groq", help: "https://console.groq.com/keys", copy: "Crea una chiave di progetto GroqCloud. Dopo la verifica potrai scegliere uno dei modelli Whisper disponibili nel tuo account." },
  openrouter: { name: "OpenRouter", help: "https://openrouter.ai/settings/keys", copy: "Crea una chiave OpenRouter. Dopo la verifica Maleta caricherà il catalogo Speech-to-Text disponibile." },
  deepgram: { name: "Deepgram", help: "https://console.deepgram.com/", copy: "Crea una chiave Deepgram con accesso Speech-to-Text, poi scegli esplicitamente il modello documentato da usare." },
};

async function loadProviderStatus() {
  try {
    const response = await fetch("/api/providers");
    if (!response.ok) throw new Error();
    const payload = await response.json(); state.providerStatus = payload.providers || {};
    Object.keys(providers).forEach((id) => {
      const connected = Boolean(state.providerStatus[id]?.connected);
      const label = $(`[data-provider-state="${id}"]`); if (label) label.textContent = connected ? (state.settings.activeProvider === id && state.providerStatus[id]?.model ? "In uso" : state.providerStatus[id]?.model ? "Connesso" : "Scegli modello") : "Configura";
      $(`[data-provider="${id}"]`)?.classList.toggle("is-active", state.settings.activeProvider === id && connected);
    });
  } catch {
    Object.keys(providers).forEach((id) => { const label = $(`[data-provider-state="${id}"]`); if (label) label.textContent = "Server non avviato"; });
  }
}

function openProviderConfig(id) {
  const provider = providers[id]; if (!provider) return;
  state.selectedProvider = id;
  $("#provider-config-title").textContent = provider.name;
  $("#provider-config-copy").textContent = provider.copy;
  $("#provider-help-link").href = provider.help;
  $("#provider-api-key").value = ""; $("#provider-api-key").type = "password";
  $("#provider-feedback").textContent = "";
  $("#model-picker").hidden = true; $("#model-feedback").textContent = "";
  const connected = Boolean(state.providerStatus[id]?.connected);
  $('[data-action="remove-provider"]').hidden = !connected;
  $('[data-action="connect-provider"]').textContent = connected ? "Usa questo provider" : "Verifica e salva";
  $("#provider-config").hidden = false; $("#provider-config").scrollIntoView({ behavior: "smooth", block: "nearest" });
  if (connected) loadProviderModels(id);
}

async function loadProviderModels(id) {
  const picker = $("#model-picker"), select = $("#provider-model"); picker.hidden = false; select.disabled = true;
  select.innerHTML = `<option value="">Caricamento modelli…</option>`; $("#model-feedback").textContent = "Aggiornamento dal provider.";
  try {
    const response = await fetch(`/api/providers/${id}?resource=models`); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Impossibile caricare i modelli.");
    select.innerHTML = `<option value="">Scegli un modello…</option>${payload.models.map((model) => `<option value="${escapeHtml(model.id)}" ${payload.selected === model.id ? "selected" : ""}>${escapeHtml(model.name || model.id)}${model.name && model.name !== model.id ? ` · ${escapeHtml(model.id)}` : ""}</option>`).join("")}`;
    select.disabled = false; $("#model-feedback").textContent = payload.models.length ? `${payload.models.length} modelli di trascrizione disponibili.` : "Il provider non ha restituito modelli di trascrizione.";
  } catch (error) { select.innerHTML = `<option value="">Nessun modello disponibile</option>`; $("#model-feedback").textContent = error.message; }
}

async function connectProvider(button) {
  const id = state.selectedProvider; const apiKey = $("#provider-api-key").value.trim();
  if (!id) return;
  if (!apiKey && state.providerStatus[id]?.connected) {
    if (!state.providerStatus[id]?.model) { $("#provider-feedback").textContent = "Scegli prima un modello qui sotto."; return loadProviderModels(id); }
    state.settings.activeProvider = id; localStorage.setItem("maleta-settings", JSON.stringify(state.settings)); $("#provider-feedback").textContent = `${providers[id].name} è ora il provider attivo.`; await loadProviderStatus(); return;
  }
  if (!apiKey) return $("#provider-feedback").textContent = "Incolla prima una chiave API.";
  button.disabled = true; button.textContent = "Verifica…"; $("#provider-feedback").textContent = "Connessione al provider in corso.";
  try {
    const response = await fetch(`/api/providers/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey }) });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Chiave non valida.");
    $("#provider-api-key").value = ""; $("#provider-feedback").textContent = `${providers[id].name} è connesso. Ora scegli un modello.`; await loadProviderStatus(); await loadProviderModels(id); $('[data-action="remove-provider"]').hidden = false;
  } catch (error) { $("#provider-feedback").textContent = error.message; }
  finally { button.disabled = false; button.textContent = state.providerStatus[id]?.connected ? "Usa questo provider" : "Verifica e salva"; }
}

async function saveProviderModel(button) {
  const id = state.selectedProvider, model = $("#provider-model").value; if (!id || !model) return $("#model-feedback").textContent = "Scegli un modello dalla lista.";
  button.disabled = true; button.textContent = "Salvataggio…";
  try {
    const response = await fetch(`/api/providers/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Modello non salvato.");
    state.settings.activeProvider = id; localStorage.setItem("maleta-settings", JSON.stringify(state.settings)); $("#model-feedback").textContent = `${model} è ora il modello attivo.`; await loadProviderStatus();
  } catch (error) { $("#model-feedback").textContent = error.message; }
  finally { button.disabled = false; button.textContent = "Salva modello"; }
}

async function removeProvider() {
  const id = state.selectedProvider; if (!id || !confirm(`Rimuovere la chiave ${providers[id].name} da Maleta?`)) return;
  const response = await fetch(`/api/providers/${id}`, { method: "DELETE" });
  if (!response.ok) return $("#provider-feedback").textContent = "Non è stato possibile rimuovere la chiave.";
  if (state.settings.activeProvider === id) state.settings.activeProvider = "";
  localStorage.setItem("maleta-settings", JSON.stringify(state.settings)); $("#provider-config").hidden = true; await loadProviderStatus(); announce("Provider rimosso.");
}

async function transcribeSavedAudio(recording) {
  if (!state.settings.activeProvider) return;
  try {
    const response = await fetch(`/api/transcribe?provider=${encodeURIComponent(state.settings.activeProvider)}&mime=${encodeURIComponent(recording.mimeType)}&language=${encodeURIComponent(state.settings.inputLanguage)}`, { method: "POST", headers: { "Content-Type": recording.mimeType }, body: recording.audio });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Trascrizione non riuscita.");
    recording.rawTranscript = payload.text || recording.rawTranscript; recording.status = "transcript-ready"; recording.updatedAt = new Date().toISOString(); await db.put("recordings", recording);
    if (state.route === "recording" && state.routeId === recording.id) renderDetail(); announce(`Trascrizione completata con ${providers[state.settings.activeProvider]?.name || "il provider"}.`);
  } catch (error) { recording.status = "transcription-error"; await db.put("recordings", recording); announce(error.message); }
}

function recordingRow(recording) {
  const assigned = classFor(recording.classId);
  return `<button class="recording-row" type="button" data-open-recording="${recording.id}"><span class="recording-title">${escapeHtml(recordingTitle(recording))}</span><span class="recording-subject status-label"><span class="status-dot ${assigned ? "" : "inbox"}"></span>${escapeHtml(assigned?.subject || "Da organizzare")}</span><span class="recording-meta">${formatDate(recording.createdAt)} · ${formatDuration(recording.durationSeconds)}</span><span class="row-arrow" aria-hidden="true">›</span></button>`;
}

function renderRecordingList(container, recordings, emptyMessage) {
  container.innerHTML = recordings.length ? `<div class="recording-list">${recordings.map(recordingRow).join("")}</div>` : `<div class="empty-state"><h2>Nessuna registrazione</h2><p>${emptyMessage}</p><button class="button button-primary" data-action="start-unassigned">Registra ora</button></div>`;
}

function renderLibrary() {
  const query = state.query.toLocaleLowerCase("it");
  const filtered = state.recordings.filter((recording) => {
    const assigned = classFor(recording.classId);
    const filterMatch = state.filter === "all" || (state.filter === "inbox" ? !assigned : Boolean(assigned));
    const searchMatch = !query || `${recordingTitle(recording)} ${assigned?.subject || ""}`.toLocaleLowerCase("it").includes(query);
    return filterMatch && searchMatch;
  });
  $("#inbox-count").textContent = `(${state.recordings.filter((item) => !classFor(item.classId)).length})`;
  renderRecordingList(els.libraryList, filtered, state.query ? "Nessun risultato corrisponde alla ricerca." : "Le registrazioni salvate compariranno qui.");
}

function renderDetail() {
  if (state.detailUrl) { URL.revokeObjectURL(state.detailUrl); state.detailUrl = null; }
  const recording = recordingFor(state.routeId);
  if (!recording) {
    els.detail.innerHTML = `<div class="empty-state"><h2>Registrazione non trovata</h2><p>Potrebbe essere stata eliminata.</p><a class="button button-primary" href="#/library">Torna alla raccolta</a></div>`;
    return;
  }
  const assigned = classFor(recording.classId);
  state.detailUrl = URL.createObjectURL(recording.audio);
  const options = sortClasses(state.classes).map((item) => `<option value="${item.id}" ${item.id === recording.classId ? "selected" : ""}>${escapeHtml(item.subject)} · ${["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"][item.weekday]} ${escapeHtml(item.startTime)}</option>`).join("");
  const transcriptContent = recording.rawTranscript ? `<p class="transcript-copy">${escapeHtml(recording.rawTranscript)}</p>` : `<div class="transcript-empty"><h3>Audio pronto per Whisper</h3><p>Collega il backend nelle Impostazioni per generare la trascrizione completa. L’audio originale è al sicuro.</p><a class="text-link" href="#/settings">Apri Impostazioni ›</a></div>`;
  els.detail.innerHTML = `<header class="detail-header"><div><p class="eyebrow">${assigned ? escapeHtml(assigned.subject) : "Da organizzare"}</p><h1 id="detail-title" class="editable-title" contenteditable="true" spellcheck="true" data-edit-title="${recording.id}">${escapeHtml(recordingTitle(recording))}</h1><p class="detail-meta">${formatDate(recording.createdAt)} · ${formatDuration(recording.durationSeconds)} · Salvata in questo browser</p></div></header><div class="audio-player"><audio controls preload="metadata" src="${state.detailUrl}">Il browser non supporta la riproduzione audio.</audio></div><div class="note-layout"><main class="transcript-card"><div class="note-section-heading"><div><p class="eyebrow">Trascrizione</p><h2>Lezione</h2></div><span class="status-badge">${recording.rawTranscript ? "Anteprima salvata" : "In attesa"}</span></div>${transcriptContent}${recording.translation ? `<section class="saved-translation"><p class="eyebrow">Traduzione</p><p>${escapeHtml(recording.translation)}</p></section>` : ""}</main><aside class="note-sidebar"><section class="detail-card"><p class="eyebrow">Organizzazione</p><h3>Lezione associata</h3>${state.classes.length ? `<label class="field-label" for="detail-class">Assegna o sposta</label><select class="select-field" id="detail-class" data-assign-detail="${recording.id}"><option value="">Da organizzare</option>${options}</select>` : `<p>Non hai ancora creato lezioni.</p><a class="text-link" href="#/calendar">Crea una lezione ›</a>`}${recording.markers?.length ? `<p class="marker-list"><strong>Momenti segnati</strong><br>${recording.markers.map(formatDuration).join(" · ")}</p>` : ""}</section><button class="text-button danger-action" data-action="delete-recording" data-recording-id="${recording.id}">Elimina registrazione</button></aside></div>`;
}

async function startRecording(classId = null) {
  if (recorder.state !== "idle") { location.hash = "#/today"; return announce("Una registrazione è già in corso."); }
  state.recordingClassId = classId;
  state.markers = [];
  state.transcriptFinal = ""; state.transcriptInterim = ""; state.transcriptSegments = []; state.translationFinal = ""; state.translationInterim = ""; state.transcriptStatus = "Avvio anteprima…";
  state.activeDraftId = makeId("draft");
  state.chunkSequence = 0;
  state.chunkWrites = [];
  location.hash = "#/today";
  renderToday();
  try {
    await recorder.start();
    await db.put("drafts", { id: state.activeDraftId, createdAt: new Date().toISOString(), classId, markers: [], mimeType: recorder.mediaRecorder?.mimeType || "audio/webm" });
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
  state.tickId = setInterval(() => { const timer = $(".recording-timer"); if (timer && state.route === "today" && recorder.state !== "idle") timer.textContent = formatDuration(recorder.elapsedSeconds); }, 1000);
}

async function stopRecording() {
  clearInterval(state.tickId);
  const result = await recorder.stop();
  await Promise.allSettled(state.chunkWrites);
  if (!result?.audio.size) return announce("Non è stato acquisito audio. La registrazione non è stata salvata.");
  recorder.setState("saving"); renderRecordingPanel();
  transcriber.stop();
  const recording = { id: makeId("rec"), title: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), durationSeconds: result.durationSeconds, classId: state.recordingClassId, markers: [...state.markers], mimeType: result.audio.type, audio: result.audio, rawTranscript: state.transcriptFinal.trim(), translation: state.translationFinal.trim(), status: state.transcriptFinal ? "preview-ready" : "saved-locally" };
  try {
    await db.put("recordings", recording);
    await clearActiveDraft();
    state.recordings.unshift(recording);
    state.recordingClassId = null; state.markers = []; state.transcriptFinal = ""; state.transcriptInterim = ""; state.translationFinal = ""; state.translationInterim = "";
    recorder.setState("idle"); renderToday();
    announce("Registrazione salvata in questo browser.");
    location.hash = `#/recording/${recording.id}`;
    transcribeSavedAudio(recording);
  } catch {
    recorder.setState("idle"); renderToday();
    const url = URL.createObjectURL(result.audio);
    const link = document.createElement("a"); link.href = url; link.download = `maleta-${Date.now()}.webm`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce("Spazio locale non disponibile. Ho preparato il download dell’audio per non perderlo.");
  }
}

function discardRecording() {
  if (!confirm("Eliminare la registrazione in corso? L’audio non potrà essere recuperato.")) return;
  clearInterval(state.tickId); transcriber.stop(); recorder.discard(); clearActiveDraft(); state.recordingClassId = null; state.markers = []; state.transcriptFinal = ""; state.transcriptInterim = ""; state.translationFinal = ""; state.translationInterim = ""; renderToday(); announce("Registrazione eliminata.");
}

async function clearActiveDraft() {
  if (!state.activeDraftId) return;
  const draftId = state.activeDraftId;
  const chunks = await db.all("chunks");
  await Promise.all(chunks.filter((chunk) => chunk.draftId === draftId).map((chunk) => db.delete("chunks", chunk.id)));
  await db.delete("drafts", draftId);
  state.activeDraftId = null; state.chunkWrites = []; state.chunkSequence = 0;
}

async function assignRecording(recordingId, classId) {
  const recording = recordingFor(recordingId); if (!recording) return;
  recording.classId = classId || null; recording.updatedAt = new Date().toISOString();
  await db.put("recordings", recording);
  if (state.route === "recording") renderDetail(); else renderLibrary();
  announce(classId ? "Registrazione assegnata." : "Registrazione spostata in Da organizzare.");
}

async function deleteRecording(id) {
  const recording = recordingFor(id); if (!recording || !confirm(`Eliminare “${recordingTitle(recording)}”? Audio e metadati verranno rimossi definitivamente da questo browser.`)) return;
  await db.delete("recordings", id); state.recordings = state.recordings.filter((item) => item.id !== id);
  announce("Registrazione eliminata."); location.hash = "#/library";
}

recorder.addEventListener("statechange", () => { if (state.route === "today") renderRecordingPanel(); if (state.route === "calendar") renderCalendar(); });
recorder.addEventListener("level", (event) => {
  const level = Math.max(4, event.detail), meter = $(".level-meter span"); if (meter) meter.style.width = `${level}%`;
  $$(".listening-bars i").forEach((bar, index) => { const variation = [0.72, 1, 0.82][index]; bar.style.transform = `scaleY(${Math.max(.28, level / 55 * variation)})`; });
  const glow = $(".listening-glow"); if (glow) glow.style.opacity = String(Math.min(.9, .3 + level / 130));
});
recorder.addEventListener("chunk", (event) => {
  if (!state.activeDraftId) return;
  const sequence = state.chunkSequence++;
  state.chunkWrites.push(db.put("chunks", { id: `${state.activeDraftId}_${String(sequence).padStart(8, "0")}`, draftId: state.activeDraftId, sequence, audio: event.detail }));
});
recorder.addEventListener("previewchunk", (event) => transcriber.pushChunk(event.detail));
transcriber.addEventListener("status", (event) => { state.transcriptStatus = event.detail.label; if (state.route === "today" && recorder.state !== "idle") renderRecordingPanel(); });
transcriber.addEventListener("transcript", (event) => { if (event.detail.finalText) { state.transcriptFinal += `${state.transcriptFinal ? " " : ""}${event.detail.finalText}`; state.transcriptSegments.push(event.detail.finalText); state.animateLatestTranscript = true; } state.transcriptInterim = event.detail.interimText || ""; if (state.route === "today") renderRecordingPanel(); });
transcriber.addEventListener("translation", (event) => { if (event.detail.finalText) state.translationFinal += `${state.translationFinal ? " " : ""}${event.detail.finalText}`; state.translationInterim = event.detail.interimText || ""; if (state.route === "today") renderRecordingPanel(); });

document.addEventListener("click", (event) => {
  const open = event.target.closest("[data-open-recording]");
  if (open) location.hash = `#/recording/${open.dataset.openRecording}`;
  const filter = event.target.closest("[data-filter]");
  if (filter) { state.filter = filter.dataset.filter; $$('[data-filter]').forEach((button) => { const selected = button === filter; button.classList.toggle("is-selected", selected); button.setAttribute("aria-pressed", selected); }); renderLibrary(); }
  const target = event.target.closest("[data-action]"); if (!target) return;
  const action = target.dataset.action;
  if (action === "start-unassigned") startRecording();
  if (action === "start-class") startRecording(target.dataset.classId);
  if (action === "toggle-pause") { if (recorder.state === "paused") { recorder.resume(); transcriber.resume(state.settings); } else { recorder.pause(); transcriber.pause(); } }
  if (action === "mark") {
    state.markers.push(recorder.elapsedSeconds);
    if (state.activeDraftId) db.put("drafts", { id: state.activeDraftId, createdAt: new Date(Date.now() - recorder.elapsedSeconds * 1000).toISOString(), classId: state.recordingClassId, markers: [...state.markers], mimeType: recorder.mediaRecorder?.mimeType || "audio/webm" });
    announce(`Momento segnato a ${formatDuration(recorder.elapsedSeconds)}.`);
  }
  if (action === "stop-recording") stopRecording();
  if (action === "discard-recording") discardRecording();
  if (action === "delete-recording") deleteRecording(target.dataset.recordingId);
  if (action === "close-provider") $("#provider-config").hidden = true;
  if (action === "toggle-secret") { const input = $("#provider-api-key"); input.type = input.type === "password" ? "text" : "password"; target.textContent = input.type === "password" ? "Mostra" : "Nascondi"; }
  if (action === "connect-provider") connectProvider(target);
  if (action === "save-provider-model") saveProviderModel(target);
  if (action === "remove-provider") removeProvider();
  if (action === "delete-all-data") {
    if (!confirm("Eliminare definitivamente tutte le registrazioni, le lezioni e le impostazioni salvate in questo browser?")) return;
    Promise.all([db.clear("recordings"), db.clear("classes"), db.clear("drafts"), db.clear("chunks")]).then(() => { localStorage.removeItem("maleta-settings"); state.recordings = []; state.classes = []; loadSettings(); renderSettings(); announce("Tutti i dati locali sono stati eliminati."); });
  }
});

document.addEventListener("change", (event) => {
  if (event.target.matches("[data-assign-detail]")) assignRecording(event.target.dataset.assignDetail, event.target.value);
});

document.addEventListener("focusout", async (event) => {
  if (!event.target.matches("[data-edit-title]")) return;
  const recording = recordingFor(event.target.dataset.editTitle); if (!recording) return;
  const title = event.target.textContent.trim();
  if (!title) { event.target.textContent = recordingTitle(recording); return announce("Il titolo non può essere vuoto."); }
  recording.title = title; recording.updatedAt = new Date().toISOString(); await db.put("recordings", recording); announce("Titolo salvato.");
});

els.search.addEventListener("input", () => { state.query = els.search.value.trim(); renderLibrary(); });
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); location.hash = "#/library"; setTimeout(() => els.search.focus(), 0); }
});
els.settingsForm.addEventListener("submit", (event) => { event.preventDefault(); saveSettings(); });
els.settingsForm.addEventListener("click", (event) => { const option = event.target.closest("[data-provider]"); if (option) openProviderConfig(option.dataset.provider); });
window.addEventListener("hashchange", renderRoute);
window.addEventListener("beforeunload", (event) => { if (["recording", "paused"].includes(recorder.state)) { event.preventDefault(); event.returnValue = ""; } });
window.addEventListener("pagehide", () => { if (state.detailUrl) URL.revokeObjectURL(state.detailUrl); });

async function init() {
  try {
    loadSettings();
    await loadData();
    initCalendar({
      root: els.calendarRoot, state, makeId, announce,
      persist: persistClass, remove: removeClass,
      startRecording: (classId) => startRecording(classId),
      statusFor: calendarStatus,
    });
    renderRoute();
  }
  catch { document.querySelector("main").innerHTML = `<section class="page-shell empty-state"><h1>Impossibile aprire l’archivio locale</h1><p>Controlla che il browser consenta l’archiviazione dei dati per questo sito, quindi ricarica la pagina.</p></section>`; }
}
init();
