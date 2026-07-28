#!/usr/bin/env bash
# Install these hooks into ~/.claude/settings.json.
#
# Idempotent. Each entry carries _source="claude-hooks" and a _slot id, so a
# re-run replaces exactly the entries this installer owns, in this checkout, and
# leaves everything else alone — including a second checkout somewhere else.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$REPO_DIR/hooks"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"
TAG="claude-hooks"

info() { printf '  %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die()  { printf 'install: %s\n' "$*" >&2; exit 1; }
hash_of() { node -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$1"; }

# --- preflight -------------------------------------------------------------

command -v jq >/dev/null 2>&1 || die 'jq is required (>= 1.6). brew install jq / apk add jq / apt install jq'
case "$(jq --version | sed 's/^jq-//')" in
  1.[0-5]|1.[0-5].*) die "jq $(jq --version) is too old; 1.6 or newer is required" ;;
esac

command -v node >/dev/null 2>&1 || die 'node is required (>= 18)'
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] || die "node $(node -v) is too old; 18 or newer is required"

[ -d "$HOOKS_DIR" ] || die "hooks directory not found at $HOOKS_DIR"
mkdir -p "$CLAUDE_DIR"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
jq -e . "$SETTINGS" >/dev/null 2>&1 || die "$SETTINGS is not valid JSON; fix or move it aside first"

chmod +x "$HOOKS_DIR"/*.sh "$HOOKS_DIR"/no-slop/hook.mjs 2>/dev/null || true

# --- what gets installed ---------------------------------------------------
#
#   slot <TAB> event <TAB> matcher <TAB> command
#
# A matcher of "-" means the event takes no matcher key. It has to be a real
# token: tab is IFS whitespace, so `read` collapses two adjacent tabs and an
# empty field would silently shift every column after it. The commit gate is
# registered against every Bash call and self-gates inside hook.mjs: it exits 0
# unless the command is a `git commit` whose message is visible on the command
# line. Doing it there rather than with a settings-level condition keeps the
# registration portable across Claude Code versions.

ENTRIES=$(cat <<EOF
no-slop-write	PostToolUse	Write|Edit|MultiEdit	node "$HOOKS_DIR/no-slop/hook.mjs" write
verify-edit	PostToolUse	Write|Edit|MultiEdit	"$HOOKS_DIR/verify-edit.sh"
no-slop-commit	PreToolUse	Bash	node "$HOOKS_DIR/no-slop/hook.mjs" commit
no-slop-turn	Stop	-	node "$HOOKS_DIR/no-slop/hook.mjs" turn
engineering-discipline	UserPromptSubmit	.*	"$HOOKS_DIR/engineering-discipline.sh"
EOF
)

# --- back up ---------------------------------------------------------------

backup="$SETTINGS.bak.$(date +%Y%m%d-%H%M%S)"
cp "$SETTINGS" "$backup"
info "backed up -> $backup"
before_hash="$(hash_of "$SETTINGS")"

# --- protect hand-edited entries -------------------------------------------
#
# An entry we own but whose command no longer matches what we would write means
# the user edited it. Leave it exactly as-is and skip that slot entirely.

protected=""
while IFS=$'\t' read -r slot event matcher command; do
  [ -z "$slot" ] && continue
  [ "$matcher" = "-" ] && matcher=""
  prev="$(jq -r --arg tag "$TAG" --arg slot "$slot" --arg dir "$HOOKS_DIR" '
    [ (.hooks // {})[]?[]?.hooks[]?
      | select((._source // "") == $tag and (._slot // "") == $slot and ((.command // "") | contains($dir))) ]
    | .[0].command // empty' "$SETTINGS")"
  if [ -n "$prev" ] && [ "$prev" != "$command" ]; then
    warn "$slot: your copy differs from the default — keeping yours, skipping this slot"
    warn "    yours: $prev"
    warn "    ours:  $command"
    protected="$protected $slot"
  fi
done <<< "$ENTRIES"

is_protected() { case " $protected " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# --- merge -----------------------------------------------------------------

tmp="$(mktemp)"
trap 'rm -f "$tmp" "$tmp.next"' EXIT
cp "$SETTINGS" "$tmp"

# Drop our unprotected entries from this checkout. Matching on (_source, _slot,
# absolute path) means another checkout's entries are left in place.
protected_json="$(printf '%s' "$protected" | tr ' ' '\n' | jq -R . | jq -s 'map(select(. != ""))')"
jq --arg tag "$TAG" --arg dir "$HOOKS_DIR" --argjson keep "$protected_json" '
  .hooks //= {}
  | .hooks |= with_entries(
      .value |= (
        map(.hooks |= map(select(
              (._source // "") != $tag
              or ((.command // "") | contains($dir) | not)
              or ((._slot // "") as $s | $keep | index($s) != null)
            )))
        | map(select((.hooks | length) > 0))
      ))
  | .hooks |= with_entries(select((.value | length) > 0))
' "$tmp" > "$tmp.next" && mv "$tmp.next" "$tmp"

while IFS=$'\t' read -r slot event matcher command; do
  [ -z "$slot" ] && continue
  [ "$matcher" = "-" ] && matcher=""
  is_protected "$slot" && continue
  jq --arg event "$event" --arg matcher "$matcher" --arg cmd "$command" --arg tag "$TAG" --arg slot "$slot" '
    ({type: "command", command: $cmd, _source: $tag, _slot: $slot}) as $hook
    | .hooks //= {}
    | .hooks[$event] //= []
    # Append to the FIRST group with this matcher only. An event can legitimately
    # carry several groups with the same matcher, and appending to each would
    # register the hook once per group.
    | (.hooks[$event] | map(.matcher // "") | index($matcher)) as $i
    | if $i == null
      then .hooks[$event] += [ (if $matcher == "" then {hooks: [$hook]} else {matcher: $matcher, hooks: [$hook]} end) ]
      else .hooks[$event][$i].hooks += [$hook]
      end
  ' "$tmp" > "$tmp.next" && mv "$tmp.next" "$tmp"
done <<< "$ENTRIES"

# --- validate --------------------------------------------------------------

jq -e . "$tmp" >/dev/null || die 'merge produced invalid JSON; settings.json untouched'

# jq -e proves syntax only. Assert the shape we intended actually landed.
while IFS=$'\t' read -r slot event matcher command; do
  [ -z "$slot" ] && continue
  [ "$matcher" = "-" ] && matcher=""
  is_protected "$slot" && continue
  n="$(jq --arg e "$event" --arg c "$command" '[ (.hooks[$e] // [])[] | (.hooks // [])[] | select(.command == $c) ] | length' "$tmp")"
  [ "$n" = "1" ] || die "post-merge check failed: expected exactly 1 '$slot' entry, found $n"
done <<< "$ENTRIES"

while read -r key; do
  jq -e --arg k "$key" 'has($k)' "$tmp" >/dev/null || die "post-merge check failed: top-level key '$key' was lost"
done < <(jq -r 'keys[]' "$backup")

# --- concurrency guard -----------------------------------------------------
#
# Claude Code rewrites settings.json itself (/config toggles, plugin installs).
# Re-hash right before the swap; if it moved under us, abort rather than
# silently discarding whatever it just wrote. No lock needed.

[ "$before_hash" = "$(hash_of "$SETTINGS")" ] || die 'settings.json changed during install — nothing written, re-run'

mv "$tmp" "$SETTINGS"
trap - EXIT

info "installed into $SETTINGS"
jq -r '.hooks | to_entries[] | "  \(.key): \(.value | map(.hooks | length) | add) hook(s)"' "$SETTINGS"

cat <<'EOF'

  Next:
    - Restart Claude Code — hooks are read at session start.
    - On an existing repo, snapshot what is already there so you only see NEW findings:
        node hooks/no-slop/hook.mjs baseline .
    - Uninstall: ./uninstall.sh

  Not registered by default (opt-in, see README): hooks/optimize-claude-md.sh
EOF
