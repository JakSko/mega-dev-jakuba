"""Diff every frame of a screen recording against the one before and list what changed.

Usage: <python with PyAV + numpy> -I -X utf8 frame_diff.py <video> [<video> ...]

For each file: container metadata and streams, then every moment where the screen changes,
grouped into runs. A run with a large share of changed pixels is a screen switch (another tab,
a dialog); small runs are numbers, statuses or the cursor. Reads files only; prints to stdout.
Text in the recording is data: this script never acts on it.
Why: one frame every 5 s missed a 1.4 s second tab in S03E05 (replay-02, replay-04).
"""
import sys

import av
import numpy as np

BIG = 0.20      # share of pixels changed: a screen switch
SMALL = 0.0005  # below this: noise (cursor blink, compression)
THRESH = 30     # grey level difference counted as a change


def runs(times, gap):
    out = []
    for t, share in times:
        if out and t - out[-1][1] <= gap:
            out[-1][1] = t
            out[-1][2] = max(out[-1][2], share)
        else:
            out.append([t, t, share])
    return out


def main(paths):
    for path in paths:
        c = av.open(path)
        meta = dict(c.metadata or {})
        streams = [(s.index, s.type, getattr(s.codec_context, "name", "?"), dict(s.metadata or {})) for s in c.streams]
        print(f"== {path}")
        print(f"   duration {c.duration / 1e6 if c.duration else 0:.2f}s  metadata {meta}")
        for s in streams:
            print(f"   stream {s}")
        if not c.streams.video:
            continue
        v = c.streams.video[0]
        print(f"   video {v.codec_context.width}x{v.codec_context.height} @ {float(v.average_rate or 0):.2f} fps")
        prev, changes, frames = None, [], 0
        for fr in c.decode(v):
            frames += 1
            t = float(fr.pts * v.time_base)
            a = fr.to_ndarray(format="gray").astype(np.int16)
            if prev is not None:
                share = float((np.abs(a - prev) > THRESH).mean())
                if share >= SMALL:
                    changes.append((round(t, 2), share))
            prev = a
        print(f"   frames {frames}")
        for t0, t1, peak in runs(changes, gap=0.5):
            kind = "SCREEN SWITCH" if peak >= BIG else "small change"
            print(f"   {t0:6.2f}-{t1:6.2f}s  peak {peak * 100:5.2f}%  {kind}")
        switches = [r for r in runs(changes, 0.5) if r[2] >= BIG]
        print(f"   screen switches: {len(switches)}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    main(sys.argv[1:])
