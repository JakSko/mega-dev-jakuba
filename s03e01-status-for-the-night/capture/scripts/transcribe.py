"""Transcribe audio or video files locally with faster-whisper, with word timestamps.

  .venv/Scripts/python transcribe.py <out.json> <file> [<file> ...] [--model medium.en]

Writes one JSON: {file: {duration, language, segments: [{start, end, text, words: [{start, end, word}]}]}}
and prints each segment as "[start-end] text". Nothing leaves this machine except the one-time
model download from Hugging Face.
"""
import json
import os
import sys

import av
import numpy as np
from faster_whisper import WhisperModel


def decode(path, rate=16000):
    """Decode the first audio stream to mono float32 at 16 kHz. faster-whisper 1.2.1 passes
    metadata_errors= to av.open, which av 19 no longer takes, so we decode here."""
    res = av.AudioResampler(format="s16", layout="mono", rate=rate)
    chunks = []
    with av.open(path) as c:
        for frame in c.decode(audio=0):
            for f in res.resample(frame):
                chunks.append(f.to_ndarray().reshape(-1))
        for f in res.resample(None):
            chunks.append(f.to_ndarray().reshape(-1))
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def main(argv):
    model_name = "medium.en"
    if "--model" in argv:
        i = argv.index("--model")
        model_name = argv[i + 1]
        del argv[i:i + 2]
    out, files = argv[0], argv[1:]
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    result = {}
    for f in files:
        segments, info = model.transcribe(decode(f), word_timestamps=True, vad_filter=False, beam_size=5)
        segs = []
        print(f"== {os.path.basename(f)} ({info.duration:.2f}s, {info.language})")
        for s in segments:
            segs.append({
                "start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip(),
                "words": [{"start": round(w.start, 2), "end": round(w.end, 2), "word": w.word} for w in (s.words or [])],
            })
            print(f"[{s.start:6.2f}-{s.end:6.2f}] {s.text.strip()}")
        result[os.path.basename(f)] = {"duration": info.duration, "language": info.language, "model": model_name, "segments": segs}
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main(sys.argv[1:])
