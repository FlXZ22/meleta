import { createServer } from "node:http";
import { readFile, writeFile, mkdir, stat, chmod } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const dataDirectory = join(root, ".data");
const masterKeyPath = join(dataDirectory, "master.key");
const credentialsPath = join(dataDirectory, "provider-credentials.enc");
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || "127.0.0.1";
/* Providers are registered per role. A provider may appear in more than one
   role — Groq and OpenRouter do both speech and text — so credentials and the
   chosen model are stored per (role, provider) pair rather than per provider.
   Adding a role here is all a future capability needs. */
const providerRoles = {
  transcription: ["openai", "groq", "openrouter", "deepgram"],
  note: ["openrouter", "deepseek", "groq"],
};
const roleNames = Object.keys(providerRoles);
const roleAllows = (role, provider) => Boolean(providerRoles[role]?.includes(provider));
const credentialKey = (role, provider) => `${role}:${provider}`;

const mimeTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ttf": "font/ttf", ".md": "text/markdown; charset=utf-8" };

async function masterKey() {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  try { return await readFile(masterKeyPath); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const key = randomBytes(32); await writeFile(masterKeyPath, key, { mode: 0o600, flag: "wx" }); await chmod(masterKeyPath, 0o600); return key;
  }
}

/* Credentials were once keyed by bare provider id, when transcription was the
   only role. Those entries are rewritten to "transcription:<id>" on first read
   so an existing vault keeps working. */
function migrateCredentials(credentials) {
  let changed = false;
  for (const [key, value] of Object.entries(credentials)) {
    if (key.includes(":")) continue;
    if (roleAllows("transcription", key)) credentials[credentialKey("transcription", key)] = value;
    delete credentials[key];
    changed = true;
  }
  return changed;
}

async function loadCredentials() {
  try {
    const envelope = JSON.parse(await readFile(credentialsPath, "utf8"));
    const decipher = createDecipheriv("aes-256-gcm", await masterKey(), Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const credentials = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8"));
    if (migrateCredentials(credentials)) await saveCredentials(credentials);
    return credentials;
  } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}

/* Returns the stored key and chosen model for a (role, provider) pair, or null
   when nothing is configured. Every provider-backed route starts here. */
function credentialFor(credentials, role, provider) {
  const stored = credentials[credentialKey(role, provider)];
  if (!stored) return null;
  return typeof stored === "string" ? { apiKey: stored, model: null } : { apiKey: stored.apiKey, model: stored.model || null };
}

async function saveCredentials(credentials) {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", await masterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
  const envelope = { version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") };
  await writeFile(credentialsPath, JSON.stringify(envelope), { mode: 0o600 }); await chmod(credentialsPath, 0o600);
}

function sendJson(response, status, value) { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(JSON.stringify(value)); }
async function body(request, limit = 30 * 1024 * 1024) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > limit) throw new Error("Richiesta troppo grande."); chunks.push(chunk); } return Buffer.concat(chunks); }

/* OpenRouter serves its model catalogue publicly, so listing models proves
   nothing about the key. /api/v1/key is the endpoint that actually authenticates. */
async function verifyProvider(provider, apiKey) {
  const checks = {
    openai: ["https://api.openai.com/v1/models", `Bearer ${apiKey}`],
    groq: ["https://api.groq.com/openai/v1/models", `Bearer ${apiKey}`],
    openrouter: ["https://openrouter.ai/api/v1/key", `Bearer ${apiKey}`],
    deepgram: ["https://api.deepgram.com/v1/projects", `Token ${apiKey}`],
    deepseek: ["https://api.deepseek.com/models", `Bearer ${apiKey}`],
  };
  const [url, authorization] = checks[provider];
  const result = await fetch(url, { headers: { Authorization: authorization, "User-Agent": "Meleta/1.0" }, signal: AbortSignal.timeout(15000) });
  if (!result.ok) throw new Error(result.status === 401 || result.status === 403 ? "La chiave è stata rifiutata dal provider." : `Il provider ha risposto con errore ${result.status}.`);
}

const deepgramModels = [
  ["nova-3", "Nova-3 General"], ["nova-3-medical", "Nova-3 Medical"], ["nova-2", "Nova-2 General"],
  ["nova-2-meeting", "Nova-2 Meeting"], ["nova-2-phonecall", "Nova-2 Phone Call"], ["nova-2-video", "Nova-2 Video"],
  ["nova-2-finance", "Nova-2 Finance"], ["nova-2-medical", "Nova-2 Medical"], ["nova", "Nova (legacy)"],
  ["enhanced", "Enhanced"], ["base", "Base"], ["whisper", "Whisper"],
].map(([id, name]) => ({ id, name }));

/* Both roles read the same catalogues; the role decides which half is useful.
   A speech model cannot write a note and a chat model cannot transcribe, so
   offering the whole list under either role would only invite a dead end. */
const modelCatalogues = {
  transcription: {
    openai: "https://api.openai.com/v1/models",
    groq: "https://api.groq.com/openai/v1/models",
    openrouter: "https://openrouter.ai/api/v1/models?output_modalities=transcription",
  },
  note: {
    openrouter: "https://openrouter.ai/api/v1/models?output_modalities=text",
    groq: "https://api.groq.com/openai/v1/models",
    deepseek: "https://api.deepseek.com/models",
  },
};

/* Groq's one catalogue mixes speech, text, vision and moderation models. */
const notSpeechModel = (id) => !/whisper|tts|speech|guard|prompt-?guard/i.test(id);

async function providerModels(role, provider, apiKey) {
  if (role === "transcription" && provider === "deepgram") return deepgramModels;
  const url = modelCatalogues[role]?.[provider];
  if (!url) throw new Error("Questo provider non offre modelli per questa funzione.");
  const result = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "Meleta/1.0" }, signal: AbortSignal.timeout(15000) });
  if (!result.ok) throw new Error(`Impossibile caricare i modelli (${result.status}).`);
  const payload = await result.json(); let models = Array.isArray(payload.data) ? payload.data : [];
  if (role === "transcription" && provider === "openai") models = models.filter((model) => /transcri|whisper/i.test(model.id));
  if (role === "transcription" && provider === "groq") models = models.filter((model) => /whisper/i.test(model.id));
  if (role === "note" && provider === "groq") models = models.filter((model) => notSpeechModel(model.id));
  return models.map((model) => ({ id: model.id, name: model.name || model.id, description: model.description || "" })).sort((a, b) => a.name.localeCompare(b.name));
}

function audioExtension(mime = "") { if (mime.includes("wav")) return "wav"; if (mime.includes("mp4")) return "m4a"; if (mime.includes("ogg")) return "ogg"; if (mime.includes("mpeg")) return "mp3"; return "webm"; }

/* Whisper reports avg_logprob per segment. Exponentiating it gives a rough 0-1
   confidence, which is enough to flag passages worth re-listening to rather than
   presenting every word as equally certain. */
function whisperSegments(payload) {
  if (!Array.isArray(payload.segments)) return [];
  return payload.segments.map((segment) => ({
    start: Number(segment.start) || 0,
    end: Number(segment.end) || 0,
    text: String(segment.text || "").trim(),
    confidence: Number.isFinite(segment.avg_logprob) ? Math.min(1, Math.exp(segment.avg_logprob)) : null,
    noSpeech: Number(segment.no_speech_prob) > 0.6,
  })).filter((segment) => segment.text);
}

/* Deepgram returns per-word timing and confidence; group words into sentences so
   the shape matches the Whisper path. */
function deepgramSegments(alternative) {
  const words = Array.isArray(alternative?.words) ? alternative.words : [];
  const segments = [];
  let current = null;
  for (const word of words) {
    const text = word.punctuated_word || word.word || "";
    if (!current) current = { start: Number(word.start) || 0, end: Number(word.end) || 0, words: [], scores: [] };
    current.words.push(text);
    current.scores.push(Number(word.confidence));
    current.end = Number(word.end) || current.end;
    if (/[.!?]$/.test(text)) {
      segments.push({ start: current.start, end: current.end, text: current.words.join(" "), confidence: average(current.scores), noSpeech: false });
      current = null;
    }
  }
  if (current) segments.push({ start: current.start, end: current.end, text: current.words.join(" "), confidence: average(current.scores), noSpeech: false });
  return segments;
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

async function transcribe(provider, apiKey, model, audio, mime, language, prompt) {
  const languageCode = language && language !== "auto" ? language.split("-")[0] : "";
  let result;
  if (provider === "openrouter") {
    result = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "User-Agent": "Meleta/1.0" }, body: JSON.stringify({ model, input_audio: { data: audio.toString("base64"), format: audioExtension(mime) }, ...(languageCode ? { language: languageCode } : {}) }), signal: AbortSignal.timeout(300000) });
  } else if (provider === "deepgram") {
    const query = new URLSearchParams({ model, smart_format: "true", punctuate: "true", ...(languageCode ? { language: languageCode } : { detect_language: "true" }) });
    result = await fetch(`https://api.deepgram.com/v1/listen?${query}`, { method: "POST", headers: { Authorization: `Token ${apiKey}`, "Content-Type": mime || "audio/webm" }, body: audio, signal: AbortSignal.timeout(300000) });
  } else {
    const form = new FormData(); form.append("file", new Blob([audio], { type: mime || "audio/webm" }), `lecture.${audioExtension(mime)}`);
    form.append("model", model); if (languageCode) form.append("language", languageCode);
    /* Timestamps and per-segment confidence cost nothing extra and are what make
       transcript-to-audio seeking and uncertainty marking possible. */
    form.append("response_format", "verbose_json");
    /* Carrying the tail of the previous chunk keeps the live preview coherent
       across segment boundaries instead of restarting cold each time. */
    if (prompt) form.append("prompt", prompt.slice(-880));
    const base = provider === "groq" ? "https://api.groq.com/openai/v1" : "https://api.openai.com/v1";
    result = await fetch(`${base}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(300000) });
  }
  const payload = await result.json().catch(() => ({}));
  if (!result.ok) throw new Error(payload.error?.message || payload.err_msg || `Trascrizione non riuscita (${result.status}).`);
  const alternative = payload.results?.channels?.[0]?.alternatives?.[0];
  const text = provider === "deepgram" ? alternative?.transcript : payload.text;
  if (!text) throw new Error("Il provider non ha restituito testo.");
  const segments = provider === "deepgram" ? deepgramSegments(alternative) : whisperSegments(payload);
  return { text, segments };
}

/* The editing contract. info.md is explicit that AI may repair grammar and
   structure but must not silently add facts or rewrite the professor's intent,
   so the prompt spends most of its words on what must survive rather than on
   what to produce. Asides about exams and deadlines are called out by name
   because a summariser's instinct is to drop them, and for a student they are
   often the most valuable lines in the hour. */
const noteSystemPrompt = `You are a careful editor preparing a student's lecture transcript for study.
Your job is to repair how the words were captured. It is not to rewrite what was said.

ALWAYS
- Write in the same language as the transcript. Never translate.
- Keep every fact, name, date, number, formula, definition and example.
- Keep asides about exams, deadlines, homework and what the professor says will be asked.
- Keep the speaker's own wording and register.

REPAIR ONLY
- Punctuation, capitalisation and sentence boundaries.
- Grammar slips, agreement errors and false starts produced by speaking rather than writing.
- Filler words and accidental repetitions, and only where removing them changes nothing.
- Transcription damage to a term you can identify with certainty from the surrounding sentence.

NEVER
- Never add information, examples, explanations or conclusions of your own.
- Never summarise, shorten, expand or paraphrase.
- Never make the language more formal or more academic than the speaker made it.
- Never guess at a garbled passage. Leave it exactly as it is.

STRUCTURE
- Break the text into paragraphs at natural shifts in the talk.
- Add "## " subheadings only where the lecture clearly moves to a new topic.
- Use "- " lists only where the speaker actually enumerated items.
- Do not use bold or italic emphasis.`;

const noteTitleInstruction = `Reply with the edited note and nothing else.
Begin with one line containing only:
# <title>
The title names what this lecture is about: specific, at most 8 words, in the language of the transcript, with no quotation marks and no trailing punctuation.
Leave one empty line after it, then the edited text.`;

const noteContinuationInstruction = `Reply with the edited text and nothing else.
This is the continuation of a note that has already started, so do not write a title and do not open with a heading.`;

const noteEndpoints = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  deepseek: "https://api.deepseek.com/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
};

/* Models occasionally wrap the whole reply in a code fence despite being asked
   for bare Markdown; unwrapping it here keeps that out of the saved note. */
function stripCodeFence(text) {
  const match = text.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  return match ? match[1] : text;
}

function parseNoteReply(raw) {
  const text = stripCodeFence(String(raw || "").trim());
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.trim());
  if (first === -1) return { title: "", note: "" };
  const heading = lines[first].trim().match(/^#\s+(.+)$/);
  if (!heading) return { title: "", note: text };
  return { title: heading[1].trim().replace(/^["'«»]|["'«».]$/g, "").trim(), note: lines.slice(first + 1).join("\n").trim() };
}

async function refineNote(provider, apiKey, model, text, language, wantTitle) {
  const endpoint = noteEndpoints[provider];
  if (!endpoint) throw new Error("Provider non supportato per la rifinitura.");
  const languageHint = language && language !== "auto" ? `\nThe transcript is in ${language}. Write the note in that language.` : "";
  const instruction = wantTitle ? noteTitleInstruction : noteContinuationInstruction;
  const result = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "User-Agent": "Meleta/1.0" },
    body: JSON.stringify({
      model,
      /* Low temperature: this is a copy-editing task, and creativity here shows
         up as invented content. */
      temperature: 0.2,
      max_tokens: 4000,
      messages: [
        { role: "system", content: `${noteSystemPrompt}\n\n${instruction}${languageHint}` },
        { role: "user", content: text },
      ],
    }),
    signal: AbortSignal.timeout(300000),
  });
  const payload = await result.json().catch(() => ({}));
  if (!result.ok) throw new Error(payload.error?.message || `Rifinitura non riuscita (${result.status}).`);
  const content = payload.choices?.[0]?.message?.content;
  if (!content || !String(content).trim()) throw new Error("Il modello non ha restituito testo.");
  return parseNoteReply(content);
}

async function api(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/providers") {
    const credentials = await loadCredentials();
    const roles = Object.fromEntries(roleNames.map((role) => [role, Object.fromEntries(providerRoles[role].map((id) => {
      const stored = credentialFor(credentials, role, id);
      return [id, { connected: Boolean(stored), model: stored?.model || null }];
    }))]));
    /* `providers` keeps the pre-role shape so nothing that only cares about
       transcription has to learn about roles. */
    return sendJson(response, 200, { roles, providers: roles.transcription });
  }
  const match = url.pathname.match(/^\/api\/providers\/([a-z]+)\/([a-z]+)$/);
  if (match && roleAllows(match[1], match[2])) {
    const [, role, provider] = match; const credentials = await loadCredentials(); const key = credentialKey(role, provider);
    if (request.method === "GET" && url.searchParams.get("resource") === "models") {
      const stored = credentialFor(credentials, role, provider); if (!stored) return sendJson(response, 401, { error: "Configura prima la chiave del provider." });
      return sendJson(response, 200, { models: await providerModels(role, provider, stored.apiKey), selected: stored.model });
    }
    if (request.method === "DELETE") { delete credentials[key]; await saveCredentials(credentials); return sendJson(response, 200, { ok: true }); }
    if (request.method === "POST") {
      const parsed = JSON.parse((await body(request, 16 * 1024)).toString("utf8")); const apiKey = String(parsed.apiKey || "").trim();
      if (apiKey.length < 12) return sendJson(response, 400, { error: "La chiave API non sembra completa." });
      await verifyProvider(provider, apiKey);
      const previous = credentialFor(credentials, role, provider);
      credentials[key] = { apiKey, model: previous?.model || null };
      await saveCredentials(credentials); return sendJson(response, 200, { ok: true, role, provider, needsModel: !credentials[key].model });
    }
    if (request.method === "PUT") {
      const stored = credentialFor(credentials, role, provider); if (!stored) return sendJson(response, 401, { error: "Configura prima la chiave del provider." });
      const parsed = JSON.parse((await body(request, 16 * 1024)).toString("utf8")); const model = String(parsed.model || "").trim();
      const models = await providerModels(role, provider, stored.apiKey); if (!models.some((item) => item.id === model)) return sendJson(response, 400, { error: "Il modello non è disponibile per questo provider." });
      credentials[key] = { apiKey: stored.apiKey, model }; await saveCredentials(credentials); return sendJson(response, 200, { ok: true, role, provider, model });
    }
  }
  if (request.method === "POST" && url.pathname === "/api/transcribe") {
    const provider = url.searchParams.get("provider"); if (!roleAllows("transcription", provider)) return sendJson(response, 400, { error: "Provider non supportato." });
    const stored = credentialFor(await loadCredentials(), "transcription", provider); if (!stored) return sendJson(response, 401, { error: "Configura prima il provider nelle Impostazioni." });
    if (!stored.model) return sendJson(response, 409, { error: "Scegli un modello nelle Impostazioni prima di trascrivere." });
    const audio = await body(request, 120 * 1024 * 1024);
    const { text, segments } = await transcribe(provider, stored.apiKey, stored.model, audio, url.searchParams.get("mime") || request.headers["content-type"], url.searchParams.get("language"), url.searchParams.get("prompt"));
    return sendJson(response, 200, { text, segments, provider, model: stored.model });
  }
  /* One chunk of transcript per request. The client splits a long lecture and
     shows progress, mirroring how oversized audio is handled for transcription. */
  if (request.method === "POST" && url.pathname === "/api/refine") {
    const provider = url.searchParams.get("provider"); if (!roleAllows("note", provider)) return sendJson(response, 400, { error: "Provider non supportato." });
    const stored = credentialFor(await loadCredentials(), "note", provider); if (!stored) return sendJson(response, 401, { error: "Configura prima il provider della nota nelle Impostazioni." });
    if (!stored.model) return sendJson(response, 409, { error: "Scegli un modello per la nota nelle Impostazioni." });
    const parsed = JSON.parse((await body(request, 2 * 1024 * 1024)).toString("utf8"));
    const text = String(parsed.text || "").trim();
    if (!text) return sendJson(response, 400, { error: "Nessun testo da rifinire." });
    const { title, note } = await refineNote(provider, stored.apiKey, stored.model, text, parsed.language, parsed.wantTitle !== false);
    return sendJson(response, 200, { title, note, provider, model: stored.model });
  }
  return sendJson(response, 404, { error: "Endpoint non trovato." });
}

async function serve(request, response, url) {
  const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  if (relative !== "index.html" && !relative.startsWith("assets/")) return sendJson(response, 403, { error: "Accesso negato." });
  const target = normalize(join(root, relative)); if (!target.startsWith(`${root}/`) && target !== join(root, "index.html")) return sendJson(response, 403, { error: "Accesso negato." });
  try { const info = await stat(target); if (!info.isFile()) throw new Error(); response.writeHead(200, { "Content-Type": mimeTypes[extname(target)] || "application/octet-stream", "Content-Length": info.size, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" }); createReadStream(target).pipe(response); }
  catch { response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); response.end("Not found"); }
}

createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  try { if (url.pathname.startsWith("/api/")) await api(request, response, url); else await serve(request, response, url); }
  catch (error) { console.error(error); sendJson(response, 500, { error: error.message || "Errore interno." }); }
}).listen(port, host, () => console.log(`Meleta disponibile su http://${host}:${port}`));
