# Realtime transcription backend contract

The browser never receives an OpenAI API key. Configure a protected `wss://` endpoint in Maleta Settings; that server owns credentials and connects to OpenAI Realtime.

## Browser → server

```json
{"type":"session.configure","model":"gpt-realtime-whisper","translate":false,"targetLanguage":"it","inputLanguage":"auto"}
{"type":"audio.append","mimeType":"audio/webm;codecs=opus","audio":"<base64>"}
```

## Server → browser

```json
{"type":"transcript.delta","text":"testo provvisorio"}
{"type":"transcript.final","text":"testo confermato"}
{"type":"translation.delta","text":"traduzione provvisoria"}
{"type":"translation.final","text":"traduzione confermata"}
{"type":"error","message":"messaggio leggibile"}
```

The server should authenticate the Maleta user, enforce origin and rate limits, validate message sizes and MIME types, and close the upstream Realtime session when the browser disconnects. Translation is opt-in; transcription preserves the spoken language by default.

OpenAI model references: [GPT-Realtime-Whisper](https://developers.openai.com/api/docs/models/gpt-realtime-whisper) and [GPT-Realtime-Translate](https://developers.openai.com/api/docs/models/gpt-realtime-translate).
