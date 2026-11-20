"""Public copy of a screen recording: keep [start, end) seconds, paint black boxes over private areas,
drop the audio, encode H.264 (yuv420p, faststart) with PyAV.
  python -I trim_mask.py <in.mp4> <out.mp4> --start 18.5 --end 72.0 --box x0,y0,x1,y1 [--box ...] [--crf 20]
Reads the input only; writes the one output file. Prints frames written and the output duration."""
import argparse
from fractions import Fraction

import av

ap = argparse.ArgumentParser()
ap.add_argument("src"); ap.add_argument("out")
ap.add_argument("--start", type=float, required=True); ap.add_argument("--end", type=float, required=True)
ap.add_argument("--box", action="append", default=[]); ap.add_argument("--crf", default="20")
a = ap.parse_args()
boxes = [tuple(int(v) for v in b.split(",")) for b in a.box]

src = av.open(a.src); vin = src.streams.video[0]
fps = Fraction(vin.average_rate).limit_denominator(1000)
out = av.open(a.out, "w", options={"movflags": "faststart"})
vout = out.add_stream("libx264", rate=fps)
vout.width, vout.height, vout.pix_fmt = vin.codec_context.width, vin.codec_context.height, "yuv420p"
vout.options = {"crf": a.crf, "preset": "medium", "profile": "main"}

n = 0
for f in src.decode(vin):
    t = float(f.pts * vin.time_base)
    if t < a.start - 1e-6:
        continue
    if t >= a.end:
        break
    img = f.to_ndarray(format="rgb24")
    for x0, y0, x1, y1 in boxes:
        img[y0:y1, x0:x1] = 0
    nf = av.VideoFrame.from_ndarray(img, format="rgb24").reformat(format="yuv420p")
    for p in vout.encode(nf):
        out.mux(p)
    n += 1
for p in vout.encode():
    out.mux(p)
out.close()
print(f"frames written {n}, duration {n / float(fps):.2f}s, from {a.start}s to {a.end}s of {a.src}")
