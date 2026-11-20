"""Change timeline of a screen recording with PyAV + numpy (no OpenCV on this machine).
  python -I video_timeline.py <video> <out dir> [--step 0.5] [--thr 12]
Samples a frame every --step seconds, compares it with the previous sample (pixels whose max channel
difference exceeds --thr), prints "t  changed%  box" for each change, and saves those frames as PNG.
Reads the video only; writes PNGs into the out dir."""
import argparse, os, struct, zlib
import av, numpy as np

def png(path, a):
    h, w, _ = a.shape
    raw = b"".join(b"\x00" + a[y].tobytes() for y in range(h))
    ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw, 6)) + ch(b"IEND", b""))

ap = argparse.ArgumentParser(); ap.add_argument("video"); ap.add_argument("out")
ap.add_argument("--step", type=float, default=0.5); ap.add_argument("--thr", type=int, default=12)
a = ap.parse_args(); os.makedirs(a.out, exist_ok=True)
c = av.open(a.video); v = c.streams.video[0]
nxt, prev = 0.0, None
for f in c.decode(v):
    t = float(f.pts * v.time_base)
    if t + 1e-6 < nxt: continue
    nxt = t + a.step
    img = f.to_ndarray(format="rgb24")
    if prev is not None:
        d = np.abs(img.astype(np.int16) - prev.astype(np.int16)).max(axis=2) > a.thr
        n = int(d.sum())
        if n > 50:
            ys, xs = d.nonzero()
            print(f"{t:6.1f}s  {100*n/d.size:5.1f}%  box x{xs.min()}-{xs.max()} y{ys.min()}-{ys.max()}")
            png(os.path.join(a.out, f"c{t:06.1f}.png"), img)
    else:
        print(f"{t:6.1f}s  first frame"); png(os.path.join(a.out, f"c{t:06.1f}.png"), img)
    prev = img
print(f"end {float(c.duration/1e6):.1f}s")
