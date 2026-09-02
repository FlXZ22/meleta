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
const allowedProviders = new Set(["openai", "groq", "openrouter", "deepgram"]);

const mimeTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ttf": "font/ttf", ".md": "text/markdown; charset=utf-8" };

async function masterKey() {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  try { return await readFile(masterKeyPath); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const key = randomBytes(32); await writeFile(masterKeyPath, key, { mode: 0o600, flag: "wx" }); await chmod(masterKeyPath, 0o600); return key;
  }
}

async function loadCredentials() {
  try {
    const envelope = JSON.parse(await readFile(credentialsPath, "utf8"));
    const decipher = createDecipheriv("aes-256-gcm", await masterKey(), Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8"));
  } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}

async function saveCredentials(credentials) {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", await masterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
  const envelope = { version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") };
  await writeFile(credentialsPath, JSON.stringify(envelope), { mode: 0o600 }); await chmod(credentialsPath, 0o600);
}

function sendJson(response, status, value) { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(JSON.stringify(value)); }
async function body(request, limit = 30 * 1024 * 1024) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > limit) throw new Error("Richiesta troppo grande."); chunks.push(chunk); } return Buffer.concat(chunks); }

async function verifyProvider(provider, apiKey) {
  const checks = {
    openai: ["https://api.openai.com/v1/models", `Bearer ${apiKey}`],
    groq: ["https://api.groq.com/openai/v1/models", `Bearer ${apiKey}`],
    openrouter: ["https://openrouter.ai/api/v1/models?output_modalities=transcription", `Bearer ${apiKey}`],
    deepgram: ["https://api.deepgram.com/v1/projects", `Token ${apiKey}`],
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

async function providerModels(provider, apiKey) {
  if (provider === "deepgram") return deepgramModels;
  const urls = {
    openai: "https://api.openai.com/v1/models",
    groq: "https://api.groq.com/openai/v1/models",
    openrouter: "https://openrouter.ai/api/v1/models?output_modalities=transcription",
  };
  const result = await fetch(urls[provider], { headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "Meleta/1.0" }, signal: AbortSignal.timeout(15000) });
  if (!result.ok) throw new Error(`Impossibile caricare i modelli (${result.status}).`);
  const payload = await result.json(); let models = Array.isArray(payload.data) ? payload.data : [];
  if (provider === "openai") models = models.filter((model) => /transcri|whisper/i.test(model.id));
  if (provider === "groq") models = models.filter((model) => /whisper/i.test(model.id));
  return models.map((model) => ({ id: model.id, name: model.name || model.id, description: model.description || "" })).sort((a, b) => a.name.localeCompare(b.name));
}

function audioExtension(mime = "") { if (mime.includes("wav")) return "wav"; if (mime.includes("mp4")) return "m4a"; if (mime.includes("ogg")) return "ogg"; if (mime.includes("mpeg")) return "mp3"; return "webm"; }

async function transcribe(provider, apiKey, model, audio, mime, language) {
  const languageCode = language && language !== "auto" ? language.split("-")[0] : "";
  let result;
  if (provider === "openrouter") {
    result = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "User-Agent": "Meleta/1.0" }, body: JSON.stringify({ model, input_audio: { data: audio.toString("base64"), format: audioExtension(mime) }, ...(languageCode ? { language: languageCode } : {}) }), signal: AbortSignal.timeout(120000) });
  } else if (provider === "deepgram") {
    const query = new URLSearchParams({ model, smart_format: "true", punctuate: "true", ...(languageCode ? { language: languageCode } : { detect_language: "true" }) });
    result = await fetch(`https://api.deepgram.com/v1/listen?${query}`, { method: "POST", headers: { Authorization: `Token ${apiKey}`, "Content-Type": mime || "audio/webm" }, body: audio, signal: AbortSignal.timeout(120000) });
  } else {
    const form = new FormData(); form.append("file", new Blob([audio], { type: mime || "audio/webm" }), `lecture.${audioExtension(mime)}`);
    form.append("model", model); if (languageCode) form.append("language", languageCode);
    const base = provider === "groq" ? "https://api.groq.com/openai/v1" : "https://api.openai.com/v1";
    result = await fetch(`${base}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(120000) });
  }
  const payload = await result.json().catch(() => ({}));
  if (!result.ok) throw new Error(payload.error?.message || payload.err_msg || `Trascrizione non riuscita (${result.status}).`);
  const text = provider === "deepgram" ? payload.results?.channels?.[0]?.alternatives?.[0]?.transcript : payload.text;
  if (!text) throw new Error("Il provider non ha restituito testo."); return text;
}

async function api(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/providers") {
    const credentials = await loadCredentials(); const providers = Object.fromEntries([...allowedProviders].map((id) => [id, { connected: Boolean(credentials[id]), model: typeof credentials[id] === "object" ? credentials[id].model || null : null }])); return sendJson(response, 200, { providers });
  }
  const match = url.pathname.match(/^\/api\/providers\/([a-z]+)$/);
  if (match && allowedProviders.has(match[1])) {
    const provider = match[1]; const credentials = await loadCredentials();
    if (request.method === "GET" && url.searchParams.get("resource") === "models") {
      const stored = credentials[provider]; if (!stored) return sendJson(response, 401, { error: "Configura prima la chiave del provider." });
      const apiKey = typeof stored === "string" ? stored : stored.apiKey; return sendJson(response, 200, { models: await providerModels(provider, apiKey), selected: typeof stored === "object" ? stored.model || null : null });
    }
    if (request.method === "DELETE") { delete credentials[provider]; await saveCredentials(credentials); return sendJson(response, 200, { ok: true }); }
    if (request.method === "POST") {
      const parsed = JSON.parse((await body(request, 16 * 1024)).toString("utf8")); const apiKey = String(parsed.apiKey || "").trim();
      if (apiKey.length < 12) return sendJson(response, 400, { error: "La chiave API non sembra completa." });
      await verifyProvider(provider, apiKey); const previous = credentials[provider]; credentials[provider] = { apiKey, model: typeof previous === "object" ? previous.model || null : null }; await saveCredentials(credentials); return sendJson(response, 200, { ok: true, provider, needsModel: !credentials[provider].model });
    }
    if (request.method === "PUT") {
      const stored = credentials[provider]; if (!stored) return sendJson(response, 401, { error: "Configura prima la chiave del provider." });
      const apiKey = typeof stored === "string" ? stored : stored.apiKey; const parsed = JSON.parse((await body(request, 16 * 1024)).toString("utf8")); const model = String(parsed.model || "").trim();
      const models = await providerModels(provider, apiKey); if (!models.some((item) => item.id === model)) return sendJson(response, 400, { error: "Il modello non è disponibile per questo provider." });
      credentials[provider] = { apiKey, model }; await saveCredentials(credentials); return sendJson(response, 200, { ok: true, provider, model });
    }
  }
  if (request.method === "POST" && url.pathname === "/api/transcribe") {
    const provider = url.searchParams.get("provider"); if (!allowedProviders.has(provider)) return sendJson(response, 400, { error: "Provider non supportato." });
    const credentials = await loadCredentials(); const stored = credentials[provider]; if (!stored) return sendJson(response, 401, { error: "Configura prima il provider nelle Impostazioni." });
    const apiKey = typeof stored === "string" ? stored : stored.apiKey; const model = typeof stored === "object" ? stored.model : null; if (!model) return sendJson(response, 409, { error: "Scegli un modello nelle Impostazioni prima di trascrivere." });
    const audio = await body(request); const text = await transcribe(provider, apiKey, model, audio, url.searchParams.get("mime") || request.headers["content-type"], url.searchParams.get("language")); return sendJson(response, 200, { text, provider, model });
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
