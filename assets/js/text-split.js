/* Splitting a transcript for the note model.

   A lecture is far longer than any chat model will return in one reply, so the
   transcript is refined in pieces and stitched back together. Cuts are made at
   paragraph and sentence boundaries: a cut inside a sentence would give the
   model half a thought to edit, and it would invent the other half. */

export const NOTE_CHUNK_CHARS = 6000;

/* Whisper sometimes returns long stretches with no terminal punctuation at all,
   so a "sentence" here falls back to whatever precedes the next break. */
const SENTENCE = /[^.!?…]+(?:[.!?…]+["'»)\]]*\s*|$)/g;

function hardSplit(sentence, limit) {
  const words = sentence.split(/\s+/).filter(Boolean);
  const parts = [];
  let current = "";
  for (const word of words) {
    if (current && current.length + word.length + 1 > limit) { parts.push(current); current = word; }
    else current = current ? `${current} ${word}` : word;
  }
  if (current) parts.push(current);
  return parts;
}

/* Returns the pieces to refine, in order. Text that already fits is returned
   untouched so the common short lecture makes exactly one request. */
export function splitTranscript(text, limit = NOTE_CHUNK_CHARS) {
  const source = String(text || "").trim();
  if (!source) return [];
  if (source.length <= limit) return [source];

  const chunks = [];
  let current = "";
  const push = () => { if (current.trim()) chunks.push(current.trim()); current = ""; };

  for (const paragraph of source.split(/\n{2,}/)) {
    for (const raw of paragraph.match(SENTENCE) || [paragraph]) {
      const sentence = raw.trim();
      if (!sentence) continue;
      if (sentence.length > limit) {
        push();
        for (const part of hardSplit(sentence, limit)) chunks.push(part);
        continue;
      }
      if (current.length + sentence.length + 1 > limit) push();
      current = current ? `${current} ${sentence}` : sentence;
    }
    /* A paragraph break is the best cut available, so prefer it when the chunk
       is already substantial rather than carrying it into the next topic. */
    if (current.length > limit * 0.6) push();
  }
  push();
  return chunks;
}
