/* Collects mono microphone samples for the live-transcript preview. This runs on
   the audio thread, so a busy main thread cannot drop capture the way the
   deprecated ScriptProcessorNode did. Samples are batched before crossing the
   thread boundary to keep message traffic low during a long lecture. */
const BATCH = 4096;

class PreviewProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(BATCH);
    this.offset = 0;
    this.capturing = true;
    this.port.onmessage = (event) => { this.capturing = Boolean(event.data?.capturing); };
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || !this.capturing) return true;
    for (let index = 0; index < channel.length; index += 1) {
      this.buffer[this.offset] = channel[index];
      this.offset += 1;
      if (this.offset === BATCH) {
        this.port.postMessage(this.buffer.slice(0));
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("preview-processor", PreviewProcessor);
