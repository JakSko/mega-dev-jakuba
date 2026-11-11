"""Loudness map of a recording, and the speech onset before given times.

  <python with faster-whisper> audio_map.py <media> [--near 5.5 18.7 ...] [--win 0.02]

Prints a line of 0.25 s cells (' ' silence under 1% of peak, '.' under 5%, ':' under 20%, '#' speech)
so quiet speech in the gaps of a transcript shows up. For each --near time it prints the start of the
sound run that holds that time (or starts just after it): use it as `at` for a spoken tag, because
word timestamps of different models differ by up to a second. Reads the file only.
"""
import argparse
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from transcribe import decode  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("media")
    ap.add_argument("--near", nargs="*", type=float, default=[])
    ap.add_argument("--win", type=float, default=0.02)
    a = ap.parse_args()
    x = decode(a.media)
    rate = 16000
    cell = rate // 4
    rms = np.array([np.sqrt(np.mean(x[i:i + cell] ** 2)) for i in range(0, len(x), cell)])
    peak = rms.max()
    line = "".join(" " if v < peak * .01 else "." if v < peak * .05 else ":" if v < peak * .2 else "#" for v in rms)
    print(f"{os.path.basename(a.media)}: {len(x) / rate:.2f}s, peak rms {peak:.4f}")
    for k in range(0, len(line), 40):
        print(f"{k / 4:6.1f}s |{line[k:k + 40]}|")
    w = int(rate * a.win)
    fine = np.array([np.sqrt(np.mean(x[i:i + w] ** 2)) for i in range(0, len(x), w)])
    loud = fine >= peak * 0.05
    for t in a.near:
        i = min(int(t / a.win), len(loud) - 1)
        j = i
        if not loud[j]:  # the hint fell in a gap: take the next sound
            while j < len(loud) and not loud[j]:
                j += 1
        else:  # walk back to the start of this sound run, through gaps under 0.15 s
            gap = 0
            while j > 0:
                if loud[j - 1]:
                    gap = 0
                elif gap * a.win >= 0.15:
                    break
                else:
                    gap += 1
                j -= 1
            j += gap
        print(f"near {t:6.2f}s -> onset {j * a.win:6.2f}s")


if __name__ == "__main__":
    main()
