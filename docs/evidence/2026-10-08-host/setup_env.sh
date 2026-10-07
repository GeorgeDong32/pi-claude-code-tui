#!/usr/bin/env bash
# Shared scenario setup for H-T1..H-T5 (spec 2026-10-08 follow-up §4).
# Builds an ISOLATED agentDir/project pair and a fixed core snapshot, prints
# the paths. Usage: source setup_env.sh <scenario-name> [with-auth]
set -euo pipefail

SCEN="${1:?scenario name}"
WITH_AUTH="${2:-no-auth}"
EVROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AG="$EVROOT/run/$SCEN/agent"
PROJ="$EVROOT/run/$SCEN/proj"
mkdir -p "$AG" "$PROJ"

# Fixed-revision core snapshot (real path — /tmp is a symlink on macOS and
# splits jiti module identity; see spec §9). Recreated if absent.
WORKSPACE="$(cd "$EVROOT/../../../.." && pwd)"
CORE_REPO="$WORKSPACE/pi-claude-code-core"
CORE_REV="${CORE_REV:-ff81050}"
CORE_SNAP="$EVROOT/run/core-snap-$CORE_REV"
if [ ! -d "$CORE_SNAP" ]; then
    mkdir -p "$CORE_SNAP"
    git -C "$CORE_REPO" archive "$CORE_REV" | tar -x -C "$CORE_SNAP"
    ln -s "$CORE_REPO/node_modules" "$CORE_SNAP/node_modules"
fi

TUI_ENTRY="$WORKSPACE/pi-claude-code-tui/extensions/claude-code-tui.ts"
CORE_ENTRY="$CORE_SNAP/extensions/index.ts"

# Project: a real git repo so usage/branch display has grounds.
if [ ! -d "$PROJ/.git" ]; then
    git -C "$PROJ" init -q
    git -C "$PROJ" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
fi

# Isolated settings: no packages (we load via -e), deterministic flags.
cat > "$AG/settings.json" <<EOF
{
  "packages": [],
  "quietStartup": true,
  "defaultProvider": "CPA",
  "defaultModel": "glm/glm-5.3-flash",
  "theme": "claude-code",
  "tuiMode": "fullscreen"
}
EOF

if [ "$WITH_AUTH" = "with-auth" ]; then
    # Credentials NEVER printed/logged; local copy only, inside the evidence run dir.
    cp "$HOME/.pi/agent/auth.json" "$AG/auth.json"
    cp "$HOME/.pi/agent/models.json" "$AG/models.json" 2>/dev/null || true
fi

echo "EVROOT=$EVROOT"
echo "AG=$AG"
echo "PROJ=$PROJ"
echo "CORE_SNAP=$CORE_SNAP"
echo "TUI_ENTRY=$TUI_ENTRY"
echo "CORE_ENTRY=$CORE_ENTRY"
echo "PI_BIN=$(command -v pi)"
echo "PI_VERSION=$(pi --version 2>&1 | head -1)"
echo "TUI_REV=$(git -C "$EVROOT/../.." rev-parse --short HEAD)"
echo "CORE_REV=$CORE_REV"
