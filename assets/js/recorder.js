/* Opus at 32 kbps mono is transparent enough for speech and keeps a three-hour
   lecture inside both the browser storage budget and the provider upload limits.
   The default (~128 kbps) produced files four times larger for no useful gain. */
const AUDIO_BITS_PER_SECOND = 32000;
const PREVIEW_SAMPLE_RATE = 16000;
const PREVIEW_SECONDS = 10;
/* Below this RMS the room is effectively silent. Sustained silence usually means
   a muted or dead microphone, which no amount of storage safety can undo later. */
const SILENCE_RMS = 0.004;
const SILENCE_SECONDS = 25;
const CLIP_RATIO = 0.02;

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
    this.previewNode = null;
    this.previewGain = null;
    this.previewBuffers = [];
    this.previewSamples = 0;
    this.previewCapturing = false;
    this.wakeLock = null;
    this.deviceId = null;
    this.silentSeconds = 0;
    this.warnedSilence = false;
    this.warnedClipping = false;
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

  async start(deviceId = null) {
    if (this.state !== "idle") return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("unsupported");
    this.setState("requesting-permission");
    try {
      this.deviceId = deviceId;
      const audio = { echoCancellation: false, noiseSuppression: false, channelCount: 1 };
      /* An exact deviceId would fail outright if the device disappeared; the
         browser default is a better outcome than refusing to record. */
      if (deviceId) audio.deviceId = { ideal: deviceId };
      this.stream = await navigator.mediaDevices.getUserMedia({ audio });
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
      this.mediaRecorder = new MediaRecorder(this.stream, { audioBitsPerSecond: AUDIO_BITS_PER_SECOND, ...(mimeType ? { mimeType } : {}) });
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
      this.silentSeconds = 0; this.warnedSilence = false; this.warnedClipping = false;
      await this.startMeter();
      await this.requestWakeLock();
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
    this.setPreviewCapturing(false);
    this.flushPreviewAudio();
    this.pausedAt = Date.now();
    this.setState("paused");
  }

  resume() {
    if (this.state !== "paused") return;
    this.pausedMilliseconds += Date.now() - this.pausedAt;
    this.pausedAt = null;
    this.mediaRecorder.resume();
    this.setPreviewCapturing(true);
    this.setState("recording");
  }

  async stop() {
    if (!["recording", "paused", "input-ended", "error"].includes(this.state)) return null;
    const durationSeconds = this.elapsedSeconds;
    this.setState("finalizing");
    this.setPreviewCapturing(false);
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

  setPreviewCapturing(capturing) {
    this.previewCapturing = capturing;
    if (this.previewNode?.port) this.previewNode.port.postMessage({ capturing });
  }

  /* Without a wake lock the screen sleeps, the OS suspends the tab, and the
     lecture stops mid-sentence. The lock is dropped by the browser whenever the
     page is hidden, so it has to be re-acquired when the tab comes back. */
  async requestWakeLock() {
    if (!navigator.wakeLock?.request || this.wakeLock) return;
    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
      this.wakeLock.addEventListener("release", () => { this.wakeLock = null; });
    } catch { this.dispatchEvent(new CustomEvent("wakelockfailed")); }
  }

  releaseWakeLock() {
    const lock = this.wakeLock;
    this.wakeLock = null;
    lock?.release?.().catch(() => {});
  }

  /* Browsers suspend an AudioContext in a background tab. MediaRecorder keeps
     writing audio, but the preview taps go silent, so the live transcript would
     stop with no explanation. The app resumes the context when the tab returns. */
  async resumeContext() {
    if (!this.context || this.context.state !== "suspended") return false;
    try { await this.context.resume(); return this.context.state === "running"; }
    catch { return false; }
  }

  get meterSuspended() {
    return Boolean(this.context && this.context.state === "suspended");
  }

  async startMeter() {
    try {
      this.context = new AudioContext();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 256;
      const source = this.context.createMediaStreamSource(this.stream);
      source.connect(this.analyser);
      await this.startPreviewTap(source);
      const data = new Uint8Array(this.analyser.frequencyBinCount);
      const waveform = new Uint8Array(this.analyser.fftSize);
      let lastCheck = performance.now();
      const tick = () => {
        this.analyser.getByteFrequencyData(data);
        const level = Math.min(100, Math.round(data.reduce((sum, value) => sum + value, 0) / data.length * 1.7));
        this.dispatchEvent(new CustomEvent("level", { detail: level }));
        const now = performance.now();
        if (now - lastCheck >= 1000) { this.inspectInput(waveform, (now - lastCheck) / 1000); lastCheck = now; }
        this.levelFrame = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* The meter is helpful, not required for capture. */ }
  }

  async startPreviewTap(source) {
    const onSamples = (samples) => {
      if (!this.previewCapturing) return;
      this.previewBuffers.push(samples);
      this.previewSamples += samples.length;
      if (this.previewSamples >= this.context.sampleRate * PREVIEW_SECONDS) this.flushPreviewAudio();
    };
    if (this.context.audioWorklet) {
      try {
        await this.context.audioWorklet.addModule("assets/js/level-worklet.js");
        this.previewNode = new AudioWorkletNode(this.context, "preview-processor", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
        this.previewNode.port.onmessage = (event) => onSamples(event.data);
        source.connect(this.previewNode);
        return;
      } catch { /* Fall through to the legacy tap below. */ }
    }
    /* ScriptProcessorNode is deprecated but remains the only fallback where
       AudioWorklet is unavailable. It needs a destination connection to run, so
       it is routed through a silent gain node. */
    this.previewNode = this.context.createScriptProcessor(4096, 1, 1);
    this.previewGain = this.context.createGain();
    this.previewGain.gain.value = 0;
    this.previewNode.onaudioprocess = (event) => onSamples(new Float32Array(event.inputBuffer.getChannelData(0)));
    source.connect(this.previewNode);
    this.previewNode.connect(this.previewGain);
    this.previewGain.connect(this.context.destination);
  }

  /* Watches the waveform once a second for the two failures a level bar does not
     communicate on its own: a microphone that is capturing nothing, and input so
     hot that it clips. Each warning is emitted once per recording. */
  inspectInput(waveform, elapsedSeconds) {
    if (this.state !== "recording") return;
    this.analyser.getByteTimeDomainData(waveform);
    let sumSquares = 0;
    let clipped = 0;
    for (const sample of waveform) {
      const value = (sample - 128) / 128;
      sumSquares += value * value;
      if (Math.abs(value) > 0.985) clipped += 1;
    }
    const rms = Math.sqrt(sumSquares / waveform.length);
    if (rms < SILENCE_RMS) this.silentSeconds += elapsedSeconds; else this.silentSeconds = 0;
    if (this.silentSeconds >= SILENCE_SECONDS && !this.warnedSilence) {
      this.warnedSilence = true;
      this.dispatchEvent(new CustomEvent("inputwarning", { detail: { kind: "silence" } }));
    }
    if (clipped / waveform.length > CLIP_RATIO && !this.warnedClipping) {
      this.warnedClipping = true;
      this.dispatchEvent(new CustomEvent("inputwarning", { detail: { kind: "clipping" } }));
    }
  }

  flushPreviewAudio() {
    if (!this.previewSamples || !this.context) return;
    const merged = new Float32Array(this.previewSamples);
    let offset = 0;
    this.previewBuffers.forEach((buffer) => { merged.set(buffer, offset); offset += buffer.length; });
    this.previewBuffers = [];
    this.previewSamples = 0;
    const downsampled = downsample(merged, this.context.sampleRate, PREVIEW_SAMPLE_RATE);
    this.dispatchEvent(new CustomEvent("previewchunk", { detail: encodeWav(downsampled, PREVIEW_SAMPLE_RATE) }));
  }

  release() {
    this.releaseWakeLock();
    cancelAnimationFrame(this.levelFrame);
    if (this.previewNode) {
      if (this.previewNode.port) this.previewNode.port.onmessage = null;
      else this.previewNode.onaudioprocess = null;
      this.previewNode.disconnect();
    }
    this.previewGain?.disconnect();
    this.context?.close();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.mediaRecorder = null; this.stream = null; this.chunks = [];
    this.startedAt = null; this.pausedAt = null; this.pausedMilliseconds = 0;
    this.context = null; this.analyser = null; this.levelFrame = null; this.previewNode = null; this.previewGain = null;
    this.previewBuffers = []; this.previewSamples = 0; this.previewCapturing = false;
    this.silentSeconds = 0; this.warnedSilence = false; this.warnedClipping = false;
  }
}

/* Input devices offered in Settings. Labels are only populated once the user has
   granted microphone permission, so an unlabelled device still gets a name. */
export async function listAudioInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "audioinput")
      .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microfono ${index + 1}` }));
  } catch { return []; }
}

/* Speech models resample to 16 kHz anyway, so the preview is averaged down before
   upload. Averaging across the source window doubles as a crude anti-alias filter. */
function downsample(samples, fromRate, toRate) {
  if (fromRate <= toRate) return samples;
  const ratio = fromRate / toRate;
  const output = new Float32Array(Math.floor(samples.length / ratio));
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(samples.length, Math.floor((index + 1) * ratio));
    let total = 0;
    for (let position = start; position < end; position += 1) total += samples[position];
    output[index] = end > start ? total / (end - start) : 0;
  }
  return output;
}

export function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const write = (offset, text) => { for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index)); };
  write(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, samples.length * 2, true);
  let offset = 44; for (const sample of samples) { const clamped = Math.max(-1, Math.min(1, sample)); view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true); offset += 2; }
  return new Blob([buffer], { type: "audio/wav" });
}
