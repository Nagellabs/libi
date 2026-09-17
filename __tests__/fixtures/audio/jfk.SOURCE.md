# jfk.wav

~11 s, 16 kHz mono excerpt of John F. Kennedy's 1961 inaugural address
("And so my fellow Americans, ask not what your country can do for you —
ask what you can do for your country.").

A work of the US federal government — **public domain** (no copyright).
This is the canonical sample shipped by whisper.cpp
(`samples/jfk.wav`). Used here as the shared transcription test fixture.

## The goldens are frozen — do not regenerate them from Whisper

`__tests__/fixtures/whisper/jfk.*.json` are an **independent** reference
transcript of this exact clip, produced once (2026-09-07) by ElevenLabs'
`scribe_v1` speech-to-text — a transcriber libi itself no longer calls.

That independence is the whole point. `whisper-transcribe-e2e.test.ts`
measures faster-whisper's word error rate and per-word timing drift
*against* these files. Re-deriving them from Whisper would make the test
compare Whisper to itself: WER would be 0 by construction, the timing
alignment exact, and the assertions would hold no matter how badly the
real transcription regressed.

So there is no generator any more — `scripts/gen-transcript-golden.ts` was
deleted on 2026-09-09. It read `ELEVENLABS_API_KEY` from the environment
and POSTed it to a provider, which is also the one thing libi does not do
anywhere else: libi never handles a provider key, and a script in the repo
doing it is a bad example even when nothing runs it.

The three files:

- `jfk.elevenlabs.json` — the raw scribe_v1 response, kept as the audit
  trail for the two derived files. Read by nothing.
- `jfk.expected.json` — the assertion contract: normalized text, key
  phrases, `minWords`, `maxDurationSeconds`, `maxWER`, and `refWords`
  (word tokens only) for the timing comparison.
- `jfk.fw-output.json` — a faster-whisper-SHAPED stand-in for the
  parse/shape tests: the same word tokens, re-tagged as faster-whisper
  emits them (`type: "word"`, `speaker_id: null`, no spacing or audio
  events).

**If this audio is ever replaced**, the goldens do not survive it. Getting a
new independent reference means transcribing the new clip with some
transcriber that is not Whisper and hand-writing the three files above —
or, more simply, keeping this clip and adding a second fixture beside it.
