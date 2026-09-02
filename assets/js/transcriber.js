export class LiveTranscriber extends EventTarget {
  constructor() { super(); this.recognition = null; this.mode = "off"; this.settings = null; this.queue = Promise.resolve(); this.session = 0; }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  start(settings) {
    this.stop(); this.settings = settings; this.session += 1;
    if (!settings.livePreview) return this.emit("status", { mode: "off", label: "Anteprima disattivata" });
    if (settings.activeProvider) { this.mode = "provider"; return this.emit("status", { mode: this.mode, label: "Preparazione trascrizione live…" }); }
    this.startBrowserPreview(settings);
  }

  startBrowserPreview(settings) {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) { this.mode = "unavailable"; return this.emit("status", { mode: this.mode, label: "Configura un provider per l’anteprima live" }); }
    this.mode = "browser"; this.recognition = new Recognition(); this.recognition.continuous = true; this.recognition.interimResults = true;
    if (settings.inputLanguage && settings.inputLanguage !== "auto") this.recognition.lang = settings.inputLanguage;
    this.recognition.onresult = (event) => {
      let finalText = "", interimText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) { const text = event.results[index][0].transcript; if (event.results[index].isFinal) finalText += text; else interimText += text; }
      this.emit("transcript", { finalText: finalText.trim(), interimText: interimText.trim(), source: "device" });
    };
    this.recognition.onerror = () => this.emit("status", { mode: "unavailable", label: "Anteprima locale non disponibile" });
    this.recognition.onend = () => { if (this.mode === "browser") try { this.recognition.start(); } catch { /* restart pending */ } };
    try { this.recognition.start(); this.emit("status", { mode: this.mode, label: "Anteprima dal dispositivo" }); }
    catch { this.emit("status", { mode: "unavailable", label: "Anteprima locale non disponibile" }); }
  }

  pushChunk(blob) {
    if (this.mode !== "provider" || !this.settings?.activeProvider) return;
    const session = this.session, settings = { ...this.settings };
    this.emit("status", { mode: "provider", label: "Trascrizione del segmento…" });
    this.queue = this.queue.then(async () => {
      const query = new URLSearchParams({ provider: settings.activeProvider, mime: blob.type || "audio/wav", language: settings.inputLanguage || "auto", preview: "true" });
      const response = await fetch(`/api/transcribe?${query}`, { method: "POST", headers: { "Content-Type": blob.type || "audio/wav" }, body: blob });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Anteprima non riuscita.");
      if (this.mode !== "provider" || this.session !== session) return;
      this.emit("transcript", { finalText: payload.text?.trim() || "", interimText: "", source: settings.activeProvider });
      this.emit("status", { mode: "provider", label: `${payload.provider} · ${payload.model}` });
    }).catch((error) => { if (this.session === session && this.mode === "provider") this.emit("status", { mode: "error", label: error.message }); });
  }

  pause() { if (this.mode === "browser") { this.mode = "paused-browser"; this.recognition?.stop(); } else if (this.mode === "provider") this.mode = "paused-provider"; }
  resume(settings) { if (this.mode === "paused-browser") this.startBrowserPreview(settings); else if (this.mode === "paused-provider") { this.mode = "provider"; this.emit("status", { mode: "provider", label: "Trascrizione live attiva" }); } }
  stop() { this.session += 1; this.mode = "off"; if (this.recognition) { this.recognition.onend = null; this.recognition.stop(); this.recognition = null; } }
}
