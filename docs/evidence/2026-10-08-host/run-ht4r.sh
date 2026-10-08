#!/usr/bin/env bash
# H-T4 re-verification after the core effort notify fix (core e98ce4a).
# Usage: run-ht4r.sh <scenario> <order: core|core-tui|tui-core> 
set -euo pipefail
SCEN="$1"; ORDER="$2"
EVROOT="$(cd "$(dirname "$0")" && pwd)"
CORE_REV="${CORE_REV:-e98ce4a}" source "$EVROOT/setup_env.sh" "$SCEN" no-auth > /tmp/ht4r-env.txt
AG="$(grep '^AG=' /tmp/ht4r-env.txt | cut -d= -f2-)"
PROJ="$(grep '^PROJ=' /tmp/ht4r-env.txt | cut -d= -f2-)"
CORE_ENTRY="$(grep '^CORE_ENTRY=' /tmp/ht4r-env.txt | cut -d= -f2-)"
TUI_ENTRY="$(grep '^TUI_ENTRY=' /tmp/ht4r-env.txt | cut -d= -f2-)"
cd "$PROJ"
case "$ORDER" in
  core) EXT="-e $CORE_ENTRY" ;;
  core-tui) EXT="-e $CORE_ENTRY -e $TUI_ENTRY" ;;
  tui-core) EXT="-e $TUI_ENTRY -e $CORE_ENTRY" ;;
esac
exec env HOME="$AG/.." PI_CODING_AGENT_DIR="$AG" TERM=xterm-256color \
  pi --no-extensions $EXT --effort ultra
