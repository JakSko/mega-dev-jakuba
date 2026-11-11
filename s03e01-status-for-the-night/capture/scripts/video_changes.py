"""Find every moment a video's picture changes, and save those frames, so text shown only briefly
(a note typed and deleted, a slide shown for two seconds) is not missed.

  python -E -P video_changes.py <video> <out dir> [--thr 8] [--min-px 1]

Compares each frame with the previous one. Prints change runs as "frames a-b (s1-s2 s): box x0-x1
y0-y1, max px N" (codec noise shows as a few pixels and small diffs). Saves the first frame, the
last frame of each run and the frame after the last change, so a person or a model can read them.
Needs OpenCV. Reads the video only; writes PNGs into the out dir.
"""
import argparse
import os

import cv2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("out")
    ap.add_argument("--thr", type=int, default=8)
    ap.add_argument("--min-px", type=int, default=1)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    cap = cv2.VideoCapture(a.video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    ok, prev = cap.read()
    if not ok:
        raise SystemExit("ERROR: no frames | HINT: check the file with ffprobe or another reader")
    cv2.imwrite(os.path.join(a.out, "f0000.png"), prev)
    i, runs, last = 0, [], None
    while True:
        ok, f = cap.read()
        if not ok:
            break
        i += 1
        d = cv2.absdiff(f, prev).max(axis=2)
        mask = d > a.thr
        px = int(mask.sum())
        if px >= a.min_px:
            ys, xs = mask.nonzero()
            box = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
            if runs and i - runs[-1]["b"] <= 3:
                r = runs[-1]
                r["b"] = i
                r["box"] = [min(r["box"][0], box[0]), min(r["box"][1], box[1]), max(r["box"][2], box[2]), max(r["box"][3], box[3])]
                r["px"] = max(r["px"], px)
                r["frame"] = f
            else:
                runs.append({"a": i, "b": i, "box": box, "px": px, "frame": f})
        prev = f
        last = f
    print(f"{os.path.basename(a.video)}: {i + 1} frames at {fps:g} fps = {(i + 1) / fps:.2f}s")
    for r in runs:
        name = f"f{r['b']:04d}.png"
        cv2.imwrite(os.path.join(a.out, name), r["frame"])
        b = r["box"]
        print(f"frames {r['a']}-{r['b']} ({r['a'] / fps:.2f}-{r['b'] / fps:.2f}s): box x{b[0]}-{b[2]} y{b[1]}-{b[3]}, max px {r['px']} -> {name}")
    if last is not None:
        cv2.imwrite(os.path.join(a.out, "last.png"), last)


if __name__ == "__main__":
    main()
