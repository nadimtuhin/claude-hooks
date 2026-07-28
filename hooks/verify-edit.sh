#!/usr/bin/env bash
# PostToolUse verify gate for Claude Code.
# Reads hook JSON on stdin, lints ONLY the edited file using locally-available
# fast tools. Surfaces real errors to Claude via exit 2 + stderr. Never blocks
# the agent loop on infra issues: any internal failure -> exit 0.
set -u
IN="$(cat 2>/dev/null)" || exit 0

# Extract file_path from tool_input (jq if present, else python, else bail)
fp=""
if command -v jq >/dev/null 2>&1; then
  fp="$(printf '%s' "$IN" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null)"
fi
if [ -z "$fp" ] && command -v python3 >/dev/null 2>&1; then
  fp="$(printf '%s' "$IN" | python3 -c 'import sys,json;
try:
 d=json.load(sys.stdin); ti=d.get("tool_input",{}); print(ti.get("file_path") or ti.get("path") or "")
except Exception: print("")' 2>/dev/null)"
fi
[ -z "$fp" ] && exit 0
[ -f "$fp" ] || exit 0

# portable timeout wrapper (no-op if neither available)
TO=""
if command -v timeout >/dev/null 2>&1; then TO="timeout 8"
elif command -v gtimeout >/dev/null 2>&1; then TO="gtimeout 8"; fi
run(){ $TO "$@" 2>&1; }

ext="${fp##*.}"
out=""; rc=0
case "$ext" in
  js|jsx|cjs|mjs)
    command -v node >/dev/null 2>&1 && { out="$(run node --check "$fp")"; rc=$?; } ;;
  ts|tsx)
    # tsc whole-project is too slow; rely on eslint if locally configured
    : ;;
  py)
    if command -v ruff >/dev/null 2>&1; then out="$(run ruff check "$fp")"; rc=$?;
    elif command -v python3 >/dev/null 2>&1; then out="$(run python3 -m py_compile "$fp")"; rc=$?; fi ;;
  sh|bash)
    command -v bash >/dev/null 2>&1 && { out="$(run bash -n "$fp")"; rc=$?; }
    if [ $rc -eq 0 ] && command -v shellcheck >/dev/null 2>&1; then out="$(run shellcheck -S error "$fp")"; rc=$?; fi ;;
  rb)
    command -v ruby >/dev/null 2>&1 && { out="$(run ruby -c "$fp")"; rc=$?; } ;;
  json)
    command -v python3 >/dev/null 2>&1 && { out="$(run python3 -m json.tool "$fp")"; rc=$?; out2=""; } ;;
  go)
    command -v gofmt >/dev/null 2>&1 && { bad="$(run gofmt -l "$fp")"; [ -n "$bad" ] && { out="gofmt: $fp not formatted"; rc=1; }; } ;;
  *) exit 0 ;;
esac

# eslint pass for js/ts when a local eslint + config exists (fast, file-scoped)
case "$ext" in
  js|jsx|cjs|mjs|ts|tsx)
    dir="$(dirname "$fp")"
    if command -v npx >/dev/null 2>&1; then
      # only if eslint resolves locally (avoid global install prompts)
      if (cd "$dir" && npx --no-install eslint --version >/dev/null 2>&1); then
        e="$(cd "$dir" && run npx --no-install eslint "$fp")"; erc=$?
        [ $erc -ne 0 ] && { out="${out:+$out
}$e"; rc=$erc; }
      fi
    fi ;;
esac

# rc==124 => timeout; treat as soft pass (don't nag on slow tools)
[ "$rc" = "124" ] && exit 0
if [ "${rc:-0}" -ne 0 ]; then
  printf 'verify-edit: issues in %s\n%s\n' "$fp" "$out" >&2
  exit 2
fi
exit 0
