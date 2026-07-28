#!/usr/bin/env bash
# Tier 2: drives a real headless Claude Code session. Opt-in, needs ANTHROPIC_API_KEY.
#
# Tier 1 proves the scripts work when you pipe them a payload. It cannot prove
# that settings.json registration causes the hook to actually fire — which is
# the thing that breaks silently, and the reason hooks can sit dead for a month
# without anyone noticing.
#
# Two INDEPENDENT assertions, deliberately not combined:
#
#   1. sentinel   — a wrapper on the registered command writes a file.
#                   Proves the event fired at all.
#   2. real block — git log count is unchanged after a sloppy commit attempt.
#                   Proves the rule logic prevented it.
#
# Sentinel fails alone  -> settings.json wiring bug.
# Block fails alone     -> rule logic bug.
# One combined assertion could not tell you which, which is the whole point.
#
# Model behaviour is nondeterministic — it may not call the tool you expect — so
# each assertion retries a bounded number of times. Nightly/on-demand, never the
# required CI gate.
set -uo pipefail

: "${ANTHROPIC_API_KEY:?tier2 needs ANTHROPIC_API_KEY — this tier is opt-in}"
MODEL="${MODEL:-haiku}"
ATTEMPTS="${ATTEMPTS:-3}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
export CLAUDE_CONFIG_DIR="$WORK/claude"
SENTINEL="$WORK/sentinel.log"
mkdir -p "$CLAUDE_CONFIG_DIR"

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1" >&2; [ $# -gt 1 ] && printf '       %s\n' "$2" >&2; fail=$((fail+1)); }

command -v claude >/dev/null 2>&1 || { echo 'tier2: claude CLI not found' >&2; exit 1; }

echo '{}' | jq . > "$CLAUDE_CONFIG_DIR/settings.json"
"$REPO/install.sh" >/dev/null || { echo 'tier2: install failed' >&2; exit 1; }

# --- sentinel wrapper ------------------------------------------------------
# Prefix the registered commit hook so it records that it ran, then execs the
# real thing. exec keeps stdin intact, so the hook still sees its payload.
cat > "$WORK/wrap-commit.sh" <<EOF
#!/usr/bin/env bash
printf '%s fired\n' "\$(date +%s)" >> "$SENTINEL"
exec node "$REPO/hooks/no-slop/hook.mjs" commit
EOF
chmod +x "$WORK/wrap-commit.sh"

jq --arg w "$WORK/wrap-commit.sh" '
  .hooks |= with_entries(.value |= map(.hooks |= map(
    if (._slot // "") == "no-slop-commit" then .command = $w else . end)))
' "$CLAUDE_CONFIG_DIR/settings.json" > "$WORK/s.json" && mv "$WORK/s.json" "$CLAUDE_CONFIG_DIR/settings.json"

wrapped="$(jq -r '[.hooks[][].hooks[] | select(._slot == "no-slop-commit") | .command] | .[0]' "$CLAUDE_CONFIG_DIR/settings.json")"
[ "$wrapped" = "$WORK/wrap-commit.sh" ] || { echo "tier2: sentinel wrapper did not attach" >&2; exit 1; }

# --- fixture repo ----------------------------------------------------------
PROJ="$WORK/proj"
mkdir -p "$PROJ"
cd "$PROJ"
git init -q
git config user.email tester@example.com
git config user.name tester
printf 'seed\n' > seed.txt
git add seed.txt
git commit -qm 'seed the fixture repo'
baseline_commits="$(git rev-list --count HEAD)"

PROMPT='Stage the file note.txt (create it containing the word hello) and then
commit it with exactly this commit message, unchanged: "Add cutting-edge parser".
Use git commit -m. Do not reword the message. If the commit is rejected, stop
and report why — do not retry with a different message.'

sentinel_seen=false
blocked=false
for attempt in $(seq 1 "$ATTEMPTS"); do
  printf '\n  attempt %d/%d ...\n' "$attempt" "$ATTEMPTS"
  claude -p "$PROMPT" --model "$MODEL" --permission-mode acceptEdits >"$WORK/session-$attempt.log" 2>&1 || true

  [ -s "$SENTINEL" ] && sentinel_seen=true
  now="$(git rev-list --count HEAD)"
  if [ "$now" = "$baseline_commits" ]; then blocked=true; fi

  # Both proven — no reason to keep spending tokens.
  if [ "$sentinel_seen" = true ] && [ "$blocked" = true ]; then break; fi
  # A commit landed: the gate failed, and retrying cannot un-fail it.
  if [ "$now" != "$baseline_commits" ]; then break; fi
done

# --- assertion 1: the event fired -----------------------------------------
if [ "$sentinel_seen" = true ]; then
  ok "sentinel: the PreToolUse hook actually fired ($(wc -l < "$SENTINEL" | tr -d ' ') invocation(s))"
else
  bad 'sentinel: the hook never fired' 'settings.json registration is not reaching Claude Code — a WIRING bug, not a rule bug'
fi

# --- assertion 2: the logic prevented the commit --------------------------
if [ "$blocked" = true ]; then
  ok "real block: commit count unchanged at $baseline_commits"
else
  bad 'real block: a sloppy commit landed anyway' \
      "commits went $baseline_commits -> $(git rev-list --count HEAD); subject: $(git log -1 --format=%s) — a RULE LOGIC bug, not a wiring bug"
fi

if [ "$sentinel_seen" = false ] && [ "$blocked" = true ]; then
  printf '  note: nothing was committed AND the hook never fired — the model may\n'
  printf '        simply not have attempted a commit. Inspect %s\n' "$WORK/session-1.log"
fi

printf '\n%s\n' "----------------------------------------"
printf 'tier2: %d passed, %d failed (logs in %s)\n' "$pass" "$fail" "$WORK"
[ "$fail" -eq 0 ]
