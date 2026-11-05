# S01E02 - who said what

Solved 2026-11-03.

**The task, in my words:** two recordings from one night, an audio file and a video. Report what each says and where, file one record of the night, and then, in a new session that holds only that record, answer one more question about both.

**What decided it:** a transcriber that really ran, with word timestamps, and a source label on every part of the hand-off. The first answer in the new session crossed the two recordings' times, because the joined record had lost which part came from which file; a search in the first session's transcript settled it.

| File | What it does |
|---|---|
| `tools/transcribe.py` | faster-whisper (large-v3-turbo) on CPU, word timestamps, JSON and plain text |
| `tools/recheck.py` | re-transcribes short ranges with a different setup to settle uncertain words |
| `tools/compare.py` | compares two passes, flags low-probability words and text aimed at an agent |
| `tools/media_info.py` | inspects mp3/mp4 without ffmpeg: SHA-256, duration, tracks, metadata |
| `tools/post.py` | sends a body with curl, saves the reply, logs it with tickets masked |

Not here: the recordings, transcripts, corrections and the answers, because they are course material.

**Kept for later:** label each part of a hand-off with its source; state the clock with every time.
