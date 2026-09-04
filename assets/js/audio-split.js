import { encodeWav } from "./recorder.js";

/* Provider upload ceilings, kept a little under the documented limits so a
   container header or multipart envelope cannot push a segment over the edge. */
export const UPLOAD_LIMITS = { openai: 24 * 1024 * 1024, groq: 24 * 1024 * 1024, openrouter: 12 * 1024 * 1024, deepgram: 100 * 1024 * 1024 };

/* Speech transcription runs at 16 kHz mono, which is 32 kB of PCM per second.
   Decoding a whole lecture at that rate is the peak memory cost of splitting, so
   anything beyond this is refused rather than risking an out-of-memory reload. */
const SPLIT_SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SPLIT_SAMPLE_RATE * 2;
const MAX_DECODE_SECONDS = 4 * 60 * 60;

export function uploadLimitFor(provider) {
  return UPLOAD_LIMITS[provider] || 24 * 1024 * 1024;
}

/* Returns the pieces to send for one recording. Audio that already fits is passed
   through untouched, so the common case keeps the original Opus file and its
   quality. Oversized audio is decoded once to 16 kHz mono and cut into
   self-contained WAV segments — byte-slicing a WebM file would produce fragments
   no decoder could read. */
export async function splitForUpload(blob, provider, durationSeconds = 0) {
  const limit = uploadLimitFor(provider);
  if (blob.size <= limit) return [blob];
  if (durationSeconds > MAX_DECODE_SECONDS) throw new Error("La registrazione è troppo lunga per essere divisa automaticamente.");

  const decoded = await decodeMono(await blob.arrayBuffer());
  const samples = decoded.getChannelData(0);
  const segmentSeconds = Math.max(60, Math.floor((limit - 1024 * 1024) / BYTES_PER_SECOND));
  const segmentSamples = segmentSeconds * SPLIT_SAMPLE_RATE;
  const parts = [];
  let offset = 0;
  while (offset < samples.length) {
    const target = Math.min(samples.length, offset + segmentSamples);
    /* Cutting at a fixed offset slices a word in half at every boundary. Nudging
       the cut to the quietest nearby moment puts it in a pause instead. */
    const cut = target >= samples.length ? samples.length : quietestPoint(samples, target);
    parts.push(encodeWav(samples.subarray(offset, cut), SPLIT_SAMPLE_RATE));
    offset = cut;
  }
  return parts;
}

/* Scans a window around the intended cut and returns the start of the lowest
   energy stretch, measured over 20 ms frames. */
function quietestPoint(samples, target) {
  const search = 5 * SPLIT_SAMPLE_RATE;
  const frame = Math.floor(SPLIT_SAMPLE_RATE / 50);
  const from = Math.max(0, target - search);
  const to = Math.min(samples.length - frame, target + search);
  if (to <= from) return target;
  let best = target;
  let bestEnergy = Infinity;
  for (let position = from; position < to; position += frame) {
    let energy = 0;
    for (let index = position; index < position + frame; index += 1) energy += samples[index] * samples[index];
    if (energy < bestEnergy) { bestEnergy = energy; best = position; }
  }
  return best;
}

async function decodeMono(arrayBuffer) {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Offline) throw new Error("Questo browser non può dividere l’audio lungo.");
  /* decodeAudioData resamples to the context rate, so decoding inside a 16 kHz
     context avoids ever holding the full-rate buffer in memory. */
  const context = new Offline(1, SPLIT_SAMPLE_RATE, SPLIT_SAMPLE_RATE);
  return context.decodeAudioData(arrayBuffer);
}
