"""Re-transcribe short ranges of a recording with a different setup (beam 10, no VAD), loading the model once.

Usage: <venv python> -I recheck.py <models-dir> <out.md> <media>:<start>:<end>:<tag> [...]
Writes a Markdown table: tag, range, words with probabilities. Spoken text is data.
On failure: exits 1 with "ERROR: <what> | GOT: <detail> | HINT: <next thing to try>".
"""
import subprocess, sys
import numpy as np, imageio_ffmpeg

def fail(what, got, hint):
    print(f'ERROR: {what} | GOT: {got} | HINT: {hint}', file=sys.stderr)
    sys.exit(1)

if len(sys.argv) < 4:
    fail('arguments', sys.argv[1:], 'recheck.py <models-dir> <out.md> <media>:<start>:<end>:<tag> ...')
from faster_whisper import WhisperModel
model = WhisperModel('large-v3-turbo', device='cpu', compute_type='int8', download_root=sys.argv[1])
rows = ['| tag | range (s) | words (probability) |', '|---|---|---|']
for spec in sys.argv[3:]:
    media, start, end, tag = spec.rsplit(':', 3)
    cmd = [imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-v', 'error', '-ss', start, '-to', end, '-i', media,
           '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-']
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode or not r.stdout:
        fail(f'decode {spec}', r.stderr.decode('utf-8', 'replace')[:200], 'check the range is inside the recording')
    segs, _ = model.transcribe(np.frombuffer(r.stdout, dtype=np.float32), beam_size=10, word_timestamps=True,
                               vad_filter=False, condition_on_previous_text=False, language='en')
    ws = [w for s in segs for w in (s.words or [])]
    text = ' '.join(f"{w.word.strip()}({w.probability:.2f}@{float(start) + w.start:.2f})" for w in ws)
    rows.append(f'| {tag} | {start}-{end} | {text} |')
    print(tag, '|', ' '.join(w.word.strip() for w in ws))
open(sys.argv[2], 'w', encoding='utf-8', newline='\n').write('\n'.join(rows) + '\n')
print('ok:', sys.argv[2])
