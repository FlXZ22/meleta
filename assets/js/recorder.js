export class AudioRecorder extends EventTarget {
  constructor() {
    super();
    this.state = "idle";
    this.mediaRecorder = null;
    this.stream = null;
    this.chunks = [];
    this.startedAt = null;
    this.pausedAt = null;
    this.pausedMilliseconds = 0;
    this.context = null;
    this.analyser = null;
    this.levelFrame = null;
    this.previewProcessor = null;
    this.previewGain = null;
    this.previewBuffers = [];
    this.previewSamples = 0;
    this.previewCapturing = false;
  }

  setState(state, detail = {}) {
    this.state = state;
    this.dispatchEvent(new CustomEvent("statechange", { detail: { state, ...detail } }));
  }

  get elapsedSeconds() {
    if (!this.startedAt) return 0;
    const end = this.pausedAt || Date.now();
    return Math.max(0, Math.floor((end - this.startedAt - this.pausedMilliseconds) / 1000));
  }

  async start() {
    if (this.state !== "idle") return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("unsupported");
    this.setState("requesting-permission");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
      this.mediaRecorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
      this.chunks = [];
      this.startedAt = Date.now();
      this.pausedMilliseconds = 0;
      this.previewCapturing = true;
      this.mediaRecorder.addEventListener("dataavailable", (event) => {
        if (!event.data.size) return;
        this.chunks.push(event.data);
        this.dispatchEvent(new CustomEvent("chunk", { detail: event.data }));
      });
      this.mediaRecorder.addEventListener("error", (event) => this.setState("error", { error: event.error }));
      this.stream.getAudioTracks()[0]?.addEventListener("ended", () => {
        if (["recording", "paused"].includes(this.state)) this.setState("input-ended");
      });
      this.mediaRecorder.start(1000);
      this.startMeter();
      this.setState("recording");
    } catch (error) {
      this.release();
      this.setState("idle");
      throw error;
    }
  }

  pause() {
    if (this.state !== "recording") return;
    this.mediaRecorder.pause();
    this.previewCapturing = false;
    this.flushPreviewAudio();
    this.pausedAt = Date.now();
    this.setState("paused");
  }

  resume() {
    if (this.state !== "paused") return;
    this.pausedMilliseconds += Date.now() - this.pausedAt;
    this.pausedAt = null;
    this.mediaRecorder.resume();
    this.previewCapturing = true;
    this.setState("recording");
  }

  async stop() {
    if (!["recording", "paused", "input-ended", "error"].includes(this.state)) return null;
    const durationSeconds = this.elapsedSeconds;
    this.setState("finalizing");
    this.previewCapturing = false;
    this.flushPreviewAudio();
    if (this.mediaRecorder?.state !== "inactive") {
      const stopped = new Promise((resolve) => this.mediaRecorder.addEventListener("stop", resolve, { once: true }));
      this.mediaRecorder.stop();
      await stopped;
    }
    const audio = new Blob(this.chunks, { type: this.mediaRecorder?.mimeType || "audio/webm" });
    this.release();
    this.setState("idle");
    return { audio, durationSeconds };
  }

  discard() {
    if (this.mediaRecorder?.state !== "inactive") this.mediaRecorder?.stop();
    this.release();
    this.setState("idle");
  }

  startMeter() {
    try {
      this.context = new AudioContext();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 256;
      const source = this.context.createMediaStreamSource(this.stream);
      source.connect(this.analyser);
      this.previewProcessor = this.context.createScriptProcessor(4096, 1, 1);
      this.previewGain = this.context.createGain(); this.previewGain.gain.value = 0;
      source.connect(this.previewProcessor); this.previewProcessor.connect(this.previewGain); this.previewGain.connect(this.context.destination);
      this.previewProcessor.onaudioprocess = (event) => {
        if (!this.previewCapturing) return;
        const samples = new Float32Array(event.inputBuffer.getChannelData(0)); this.previewBuffers.push(samples); this.previewSamples += samples.length;
        if (this.previewSamples >= this.context.sampleRate * 10) this.flushPreviewAudio();
      };
      const data = new Uint8Array(this.analyser.frequencyBinCount);
      const tick = () => {
        this.analyser.getByteFrequencyData(data);
        const level = Math.min(100, Math.round(data.reduce((sum, value) => sum + value, 0) / data.length * 1.7));
        this.dispatchEvent(new CustomEvent("level", { detail: level }));
        this.levelFrame = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* The meter is helpful, not required for capture. */ }
  }

  flushPreviewAudio() {
    if (!this.previewSamples || !this.context) return;
    const merged = new Float32Array(this.previewSamples); let offset = 0;
    this.previewBuffers.forEach((buffer) => { merged.set(buffer, offset); offset += buffer.length; });
    this.previewBuffers = []; this.previewSamples = 0;
    this.dispatchEvent(new CustomEvent("previewchunk", { detail: encodeWav(merged, this.context.sampleRate) }));
  }

  release() {
    cancelAnimationFrame(this.levelFrame);
    if (this.previewProcessor) { this.previewProcessor.onaudioprocess = null; this.previewProcessor.disconnect(); }
    this.previewGain?.disconnect();
    this.context?.close();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.mediaRecorder = null; this.stream = null; this.chunks = [];
    this.startedAt = null; this.pausedAt = null; this.pausedMilliseconds = 0;
    this.context = null; this.analyser = null; this.levelFrame = null; this.previewProcessor = null; this.previewGain = null;
    this.previewBuffers = []; this.previewSamples = 0; this.previewCapturing = false;
  }
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const write = (offset, text) => { for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index)); };
  write(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, samples.length * 2, true);
  let offset = 44; for (const sample of samples) { const clamped = Math.max(-1, Math.min(1, sample)); view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true); offset += 2; }
  return new Blob([buffer], { type: "audio/wav" });
}
