#!/usr/bin/env python3
"""PTY driver for host-terminal evidence (spec 2026-10-08 follow-up §4).

Spawns a real process on a real pseudo-terminal (python stdlib pty) and
reconstructs the VISIBLE screen with pyte — pi's fullscreen TUI redraws with
cursor moves, so raw-byte greps double-count; assertions must run against
the emulated screen. Raw bytes are kept alongside for the record.

Run with the evidence dir's venv: .venv/bin/python pty_driver.py ...

  --snap MS NAME      at MS milliseconds, save the visible screen to
                      <logdir>/<MS>ms-<NAME>.txt (repeatable, time-ordered)
  --send-after MS TX  write TX to the pty at MS (\r = Enter, escapes OK)
  --quit-at MS MODE   ctrlc | exit | kill at MS (default: kill at last snap)
  CMD after --        the command line to spawn
"""
import argparse
import os
import pty
import select
import struct
import subprocess
import sys
import time
import fcntl
import termios

import pyte


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", required=True, help="raw byte log path")
    ap.add_argument("--rows", type=int, default=40)
    ap.add_argument("--cols", type=int, default=120)
    ap.add_argument("--env", action="append", default=[])
    ap.add_argument("--send-after", nargs=2, action="append", default=[], metavar=("MS", "TEXT"))
    ap.add_argument("--snap", nargs=2, action="append", default=[], metavar=("MS", "NAME"))
    ap.add_argument("--quit-at", nargs=2, action="append", default=[], metavar=("MS", "MODE"))
    ap.add_argument("--tail-ms", type=int, default=2000, help="idle time after the last event before ending")
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    args = ap.parse_args()
    cmd = args.cmd[1:] if args.cmd and args.cmd[0] == "--" else args.cmd
    if not cmd:
        ap.error("no command given")

    env = dict(os.environ)
    env.update(dict(kv.split("=", 1) for kv in args.env))
    env.setdefault("TERM", "xterm-256color")

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", args.rows, args.cols, 0, 0))
    proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True, close_fds=True)
    os.close(slave)

    screen = pyte.Screen(args.cols, args.rows)
    stream = pyte.ByteStream(screen)

    def send(data: bytes) -> None:
        try:
            os.write(master, data)
        except OSError:
            pass

    events: list[tuple[int, str, object]] = []
    for ms, text in args.send_after:
        events.append((int(ms), "send", text.encode().decode("unicode_escape").encode("utf-8")))
    for ms, name in args.snap:
        events.append((int(ms), "snap", name))
    for ms, mode in args.quit_at:
        events.append((int(ms), "quit", mode))
    events.sort(key=lambda e: e[0])
    last_ms = events[-1][0] if events else 0
    end_ms = last_ms + args.tail_ms

    log = open(args.log, "wb")
    logdir = os.path.dirname(os.path.abspath(args.log))
    t0 = time.monotonic()
    quit_sent = False

    try:
        while True:
            now_ms = int((time.monotonic() - t0) * 1000)
            while events and events[0][0] <= now_ms:
                _, kind, payload = events.pop(0)
                if kind == "send":
                    log.write(f"\n<<<SEND@{now_ms}ms>>>\n".encode())
                    log.write(payload + b"\n<<<END>>>\n")
                    send(payload)
                elif kind == "snap":
                    path = os.path.join(logdir, f"{now_ms:05d}ms-{payload}.txt")
                    with open(path, "w") as f:
                        f.write("\n".join(line.rstrip() for line in screen.display))
                    print(f"snap {now_ms}ms -> {payload}", file=sys.stderr)
                elif kind == "quit" and not quit_sent:
                    quit_sent = True
                    if payload == "ctrlc":
                        for _ in range(3):
                            send(b"\x03")
                            time.sleep(0.4)
                            if proc.poll() is not None:
                                break
                    elif payload == "exit":
                        send(b"\r/exit\r")
            if now_ms >= end_ms and not events:
                break
            if proc.poll() is not None and not events:
                break
            r, _, _ = select.select([master], [], [], 0.05)
            if r:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    chunk = b""
                if chunk:
                    log.write(chunk)
                    log.flush()
                    stream.feed(chunk)
            if time.monotonic() - t0 > 300:  # hard safety stop
                break
    finally:
        if proc.poll() is None:
            proc.kill()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass
        log.write(f"\n<<<DRIVER exit={proc.returncode} elapsed={time.monotonic()-t0:.1f}s>>>".encode())
        log.close()
        os.close(master)

    print(f"process exit={proc.returncode}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
