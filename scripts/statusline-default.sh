#!/usr/bin/env bash
# Bundled default statusline for @georgedong32/pi-claude-code-tui (plan SL5).
#
# Contract (CC-compatible): the extension pipes a CC-shaped JSON document to
# stdin (see extensions/lib/statusline.ts buildStatuslineJson) and renders
# stdout lines verbatim below the editor. Requires bash + jq. Point
# /claude-statusline set at your own script for a fancier row.
#
# Layout: ~dir │ ◆branch ±dirty │ model │ Ctx p% (used/win) │ $cost
# Segments drop right-to-left when the terminal is too narrow; OVERRIDE_TERM
# _WIDTH wins over tput cols (the extension always sets it).

set -u
input=$(cat)

if ! command -v jq >/dev/null 2>&1; then
	echo "statusline: jq required"
	exit 0
fi

# One jq call emits every field preformatted (tab-separated): model, cost
# (CC precision: cents above $0.01, 4 decimals below), context %, used, win.
IFS=$'\t' read -r model coststr pct used win <<< "$(printf '%s' "$input" | jq -r '
	def tok: if . >= 1000000 then "\(. / 1000000 * 10 | round / 10)M"
	         elif . >= 1000 then "\(. / 1000 | round)k"
	         else "\(.)" end;
	[ (.model.display_name // "?"),
	  (.pi.cost_usd // 0 | if . >= 0.01 then "$\(.*100 | round / 100)" else "$\(.)" end),
	  (.context_window.used_percentage // 0 | "\(.)%"),
	  ((.context_window.used_percentage // 0) as $p
	   | (.context_window.context_window_size // 0) as $w
	   | (($p * $w / 100) | round | tok)),
	  (.context_window.context_window_size // 0 | tok)
	] | @tsv')"

# --- git: ONE call carries branch + dirty count (perf gate, plan SL5) ---
gitbranch=""
gitdirty=0
gitout=$(git --no-optional-locks status -b --porcelain 2>/dev/null)
if [ -n "$gitout" ]; then
	while IFS= read -r line; do
		case $line in
			"## "*) gitbranch=${line#\#\# }; gitbranch=${gitbranch%%...*} ;;
			*) gitdirty=$((gitdirty + 1)) ;;
		esac
	done <<< "$gitout"
fi

# --- width ---
if [ -n "${OVERRIDE_TERM_WIDTH:-}" ]; then
	TERM_WIDTH=$OVERRIDE_TERM_WIDTH
else
	TERM_WIDTH=$(tput cols 2>/dev/null || echo 100)
fi
case $TERM_WIDTH in (*[!0-9]* | "") TERM_WIDTH=100 ;; esac

# --- palette (CC dark-daltonized approximations) ---
RESET=$'\033[39m'
C_DIR=$'\033[38;2;229;229;229m'
C_GIT=$'\033[38;2;154;205;255m'
C_MODEL=$'\033[38;2;255;175;0m'
C_CTX=$'\033[38;2;152;152;152m'
C_SEP=$'\033[38;2;120;120;120m'

dir=${PWD/#"$HOME"/\~}

# Compose right-to-left dropping: every segment tracks its plain width so the
# ANSI bytes never disturb the fit math.
plain=0
seg=""
add() { # $1 paint  $2 text — appends a separator when not first
	if [ -n "$seg" ]; then plain=$((plain + 3)); seg="${seg}${C_SEP} │ ${RESET}"; fi
	plain=$((plain + ${#2}))
	seg="${seg}$1$2${RESET}"
}
fits() { [ $((plain + 3 + $1 + 1)) -le "$TERM_WIDTH" ]; } # +3 sep, +1 badge gap reserve

add_dir() { plain=$((plain + ${#dir})); seg="${C_DIR}${dir}${RESET}"; }
add_dir
gitseg="◆ ${gitbranch} ${gitdirty}"
[ -n "$gitbranch" ] && fits ${#gitseg} && add "$C_GIT" "$gitseg"
fits ${#model} && add "$C_MODEL" "$model"
ctxseg="Ctx ${pct} (${used}/${win})"
fits ${#ctxseg} && add "$C_CTX" "$ctxseg"
[ "$coststr" != "\$0" ] && fits ${#coststr} && add "$C_CTX" "$coststr"

printf '%s\n' "$seg"
