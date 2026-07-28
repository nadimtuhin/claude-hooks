#!/usr/bin/env bash
# Remove this checkout's hooks from ~/.claude/settings.json.
#
# Only entries tagged _source="claude-hooks" whose command points into THIS
# checkout are removed. Hand-edited copies and other checkouts are left alone.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$REPO_DIR/hooks"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"
TAG="claude-hooks"

die() { printf 'uninstall: %s\n' "$*" >&2; exit 1; }

command -v jq >/dev/null 2>&1 || die 'jq is required'
[ -f "$SETTINGS" ] || { echo "  nothing to do — $SETTINGS does not exist"; exit 0; }
jq -e . "$SETTINGS" >/dev/null 2>&1 || die "$SETTINGS is not valid JSON"

before="$(jq --arg tag "$TAG" --arg dir "$HOOKS_DIR" \
  '[ (.hooks // {})[]?[]?.hooks[]? | select((._source // "") == $tag and ((.command // "") | contains($dir))) ] | length' "$SETTINGS")"
if [ "$before" = "0" ]; then
  echo "  nothing to remove — no entries from $HOOKS_DIR are registered"
  exit 0
fi

backup="$SETTINGS.bak.$(date +%Y%m%d-%H%M%S)"
cp "$SETTINGS" "$backup"
echo "  backed up -> $backup"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# Prune our entries, then drop matcher groups and events left empty — so the
# file returns to exactly the shape it had before install.
jq --arg tag "$TAG" --arg dir "$HOOKS_DIR" '
  .hooks //= {}
  | .hooks |= with_entries(
      .value |= (
        map(.hooks |= map(select((._source // "") != $tag or ((.command // "") | contains($dir) | not))))
        | map(select((.hooks | length) > 0))
      ))
  | .hooks |= with_entries(select((.value | length) > 0))
  | if (.hooks | length) == 0 then del(.hooks) else . end
' "$SETTINGS" > "$tmp"

jq -e . "$tmp" >/dev/null || die 'produced invalid JSON; settings.json untouched'

after="$(jq --arg tag "$TAG" --arg dir "$HOOKS_DIR" \
  '[ (.hooks // {})[]?[]?.hooks[]? | select((._source // "") == $tag and ((.command // "") | contains($dir))) ] | length' "$tmp")"
[ "$after" = "0" ] || die "expected 0 remaining entries, found $after"

mv "$tmp" "$SETTINGS"
trap - EXIT
echo "  removed $before hook entr(ies) from $SETTINGS"
