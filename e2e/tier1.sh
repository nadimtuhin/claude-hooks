#!/usr/bin/env bash
# Tier 1: deterministic, no API key, the CI gate.
#
# Piping payloads proves the scripts work. Registration is the part that
# silently breaks — that needs tier2.sh and a real session. This tier covers
# everything that can be proven without one.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
export CLAUDE_CONFIG_DIR="$WORK/claude"
mkdir -p "$CLAUDE_CONFIG_DIR"

pass=0; fail=0
ok()   { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  FAIL %s\n' "$1" >&2; [ $# -gt 1 ] && printf '       %s\n' "$2" >&2; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3], got [$2]"; fi; }
section(){ printf '\n== %s\n' "$1"; }

HOOK="node $REPO/hooks/no-slop/hook.mjs"

# ---------------------------------------------------------------------------
section 'unit tests'
# ---------------------------------------------------------------------------
if (cd "$REPO/hooks/no-slop" && node --test >/tmp/unit.log 2>&1); then
  ok "node --test ($(grep -c '^ok\|^    ok' /tmp/unit.log) assertions)"
else
  bad 'node --test' "$(tail -20 /tmp/unit.log)"
fi

# ---------------------------------------------------------------------------
section 'hook modes via stdin'
# ---------------------------------------------------------------------------
printf "it('works', () => {});\n" > "$WORK/a.test.ts"
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$WORK/a.test.ts\"}}" | $HOOK write >/dev/null 2>&1
check 'write mode surfaces a finding (exit 2)' "$?" 2

printf 'export const two = 1 + 1;\n' > "$WORK/clean.ts"
echo "{\"tool_input\":{\"file_path\":\"$WORK/clean.ts\"}}" | $HOOK write >/dev/null 2>&1
check 'write mode on clean file (exit 0)' "$?" 0

echo '{"tool_input":{"command":"git commit -m \"Add cutting-edge parser\""}}' | $HOOK commit >/dev/null 2>&1
check 'commit mode blocks slop (exit 2)' "$?" 2

echo '{"tool_input":{"command":"git commit -m \"fix null deref in parser\""}}' | $HOOK commit >/dev/null 2>&1
check 'commit mode allows a clean subject (exit 0)' "$?" 0

out="$(echo '{"tool_input":{"command":"git commit -F msg.txt"}}' | $HOOK commit 2>&1)"; rc=$?
check 'commit -F exits 0' "$rc" 0
check 'commit -F is silent (a gate that cannot see its input must not block)' "${#out}" 0

out="$(echo '{"tool_input":{"command":"git commit"}}' | $HOOK commit 2>&1)"; rc=$?
check 'bare git commit exits 0' "$rc" 0
check 'bare git commit is silent' "${#out}" 0

printf '%s\n' '{"message":{"role":"assistant","content":[{"type":"text","text":"You'"'"'re absolutely right."}]}}' > "$WORK/t.jsonl"
echo "{\"transcript_path\":\"$WORK/t.jsonl\"}" | $HOOK turn >/dev/null 2>&1
check 'turn mode is advisory (exit 0 even on BLOCK)' "$?" 0

echo 'not json' | $HOOK commit >/dev/null 2>&1
check 'garbage stdin does not crash the hook' "$?" 0

# ---------------------------------------------------------------------------
section 'config must fail loud, never silently disable'
# ---------------------------------------------------------------------------
mkdir -p "$WORK/proj/.git"
printf '// as you requested\n' > "$WORK/proj/x.ts"

$HOOK scan "$WORK/proj/x.ts" >/dev/null 2>&1
check 'a finding is reported with no config' "$?" 1

printf '{ not json' > "$WORK/proj/.no-slop.json"
out="$($HOOK scan "$WORK/proj/x.ts" 2>&1)"; rc=$?
check 'malformed .no-slop.json exits non-zero' "$([ $rc -ne 0 ] && echo yes || echo no)" yes
case "$out" in *'.no-slop.json'*) ok 'the error names the offending file' ;; *) bad 'the error names the offending file' "$out" ;; esac
case "$out" in *clean*) bad 'malformed config must NOT report clean' "$out" ;; *) ok 'malformed config does not report clean' ;; esac

printf '{"rules":{"comment-provinance":"off"}}' > "$WORK/proj/.no-slop.json"
out="$($HOOK scan "$WORK/proj/x.ts" 2>&1)"; rc=$?
check 'unknown rule id exits non-zero' "$([ $rc -ne 0 ] && echo yes || echo no)" yes
case "$out" in *comment-provinance*) ok 'the error names the unknown rule id' ;; *) bad 'the error names the unknown rule id' "$out" ;; esac

printf '{"rules":{"comment-provenance":"off"}}' > "$WORK/proj/.no-slop.json"
$HOOK scan "$WORK/proj/x.ts" >/dev/null 2>&1
check 'a valid "off" rule silences the finding' "$?" 0
rm -f "$WORK/proj/.no-slop.json"

# ---------------------------------------------------------------------------
section 'baseline'
# ---------------------------------------------------------------------------
$HOOK baseline "$WORK/proj" >/dev/null 2>&1
$HOOK scan "$WORK/proj/x.ts" >/dev/null 2>&1
check 'a baselined finding stops being reported' "$?" 0
printf '// per your review feedback\n' >> "$WORK/proj/x.ts"
$HOOK scan "$WORK/proj/x.ts" >/dev/null 2>&1
check 'a NEW finding still fires against a baseline' "$?" 1
rm -f "$WORK/proj/.no-slop-baseline.json"

# ---------------------------------------------------------------------------
section 'install.sh / uninstall.sh'
# ---------------------------------------------------------------------------
# A pristine settings.json carrying entries we must not touch. jq-normalized so
# the uninstall round-trip can be asserted byte-for-byte.
cat <<'JSON' | jq . > "$CLAUDE_CONFIG_DIR/settings.json"
{"env":{"PRESERVE_ME":"yes"},"hooks":{"PostToolUse":[{"matcher":"Write","hooks":[{"type":"command","command":"/bin/true"}]}]},"permissions":{"allow":["Bash(ls:*)"]}}
JSON
cp "$CLAUDE_CONFIG_DIR/settings.json" "$WORK/original.json"

"$REPO/install.sh" >/dev/null 2>&1
check 'install run 1 succeeds' "$?" 0

jq -e . "$CLAUDE_CONFIG_DIR/settings.json" >/dev/null 2>&1
check 'merged settings.json is valid JSON' "$?" 0

check 'pre-existing unrelated hook survived' \
  "$(jq -r '[.hooks.PostToolUse[].hooks[] | select(.command == "/bin/true")] | length' "$CLAUDE_CONFIG_DIR/settings.json")" 1
check 'pre-existing env survived' \
  "$(jq -r '.env.PRESERVE_ME' "$CLAUDE_CONFIG_DIR/settings.json")" yes
check 'pre-existing permissions survived' \
  "$(jq -r '.permissions.allow[0]' "$CLAUDE_CONFIG_DIR/settings.json")" 'Bash(ls:*)'
check 'all five hooks registered' \
  "$(jq -r '[.hooks[][].hooks[] | select(._source == "claude-hooks")] | length' "$CLAUDE_CONFIG_DIR/settings.json")" 5

len1="$(jq -cS '.hooks | with_entries(.value |= (map(.hooks|length)|add))' "$CLAUDE_CONFIG_DIR/settings.json")"
"$REPO/install.sh" >/dev/null 2>&1
check 'install run 2 succeeds' "$?" 0
len2="$(jq -cS '.hooks | with_entries(.value |= (map(.hooks|length)|add))' "$CLAUDE_CONFIG_DIR/settings.json")"
check 'install is idempotent (array lengths identical)' "$len2" "$len1"

"$REPO/uninstall.sh" >/dev/null 2>&1
check 'uninstall succeeds' "$?" 0
if cmp -s "$WORK/original.json" "$CLAUDE_CONFIG_DIR/settings.json"; then
  ok 'uninstall restores settings.json byte-for-byte'
else
  bad 'uninstall restores settings.json byte-for-byte' "$(diff "$WORK/original.json" "$CLAUDE_CONFIG_DIR/settings.json" | head -20)"
fi

# ---------------------------------------------------------------------------
section 'self-scan'
# ---------------------------------------------------------------------------
$HOOK scan "$REPO/README.md" --prose >/dev/null 2>&1
check 'the README does not trip its own prose rules' "$?" 0

# ---------------------------------------------------------------------------
printf '\n%s\n' "----------------------------------------"
printf 'tier1: %d passed, %d failed\n' "$pass" "$fail"
rm -rf "$WORK"
[ "$fail" -eq 0 ]
