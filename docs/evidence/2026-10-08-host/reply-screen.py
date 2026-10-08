#!/usr/bin/env python3
"""Replay a raw PTY byte log through pyte and dump the final visible screen."""
import sys
import pyte
log_path, out_path, cols, rows = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
screen = pyte.Screen(cols, rows)
stream = pyte.ByteStream(screen)
stream.feed(open(log_path, "rb").read())
with open(out_path, "w") as f:
    for line in screen.display:
        f.write(line.rstrip() + "\n")
