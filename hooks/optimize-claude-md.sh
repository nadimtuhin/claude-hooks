#!/bin/bash

# Monitor CLAUDE.md line count across any project.
# Archives and suggests optimization if >400 lines.
# Triggered after CLAUDE.md edits via PostToolUse hook.

CLAUDE_MD="./CLAUDE.md"
ARCHIVE_DIR=".claude/archive"
THRESHOLD=400
MAX_ARCHIVES=5

if [[ ! -f "$CLAUDE_MD" ]]; then
  exit 0
fi

LINE_COUNT=$(wc -l < "$CLAUDE_MD")

if [[ $LINE_COUNT -gt $THRESHOLD ]]; then
  echo "[CLAUDE.md] ⚠️  Line count: $LINE_COUNT (threshold: $THRESHOLD)" >&2

  # Create archive dir (fail hard if can't create)
  if ! mkdir -p "$ARCHIVE_DIR" 2>/dev/null; then
    echo "[CLAUDE.md] ✗ Failed to create $ARCHIVE_DIR" >&2
    exit 1
  fi

  # Archive current version with timestamp
  TIMESTAMP=$(date +%Y%m%d_%H%M%S)
  ARCHIVE_FILE="$ARCHIVE_DIR/CLAUDE.md.${TIMESTAMP}.bak"

  if ! cp "$CLAUDE_MD" "$ARCHIVE_FILE" 2>/dev/null; then
    echo "[CLAUDE.md] ✗ Failed to archive to $ARCHIVE_FILE" >&2
    exit 1
  fi

  echo "[CLAUDE.md] ✓ Archived to $ARCHIVE_FILE" >&2

  # Cleanup old archives (keep only 5 latest)
  ARCHIVE_COUNT=$(ls -1 "$ARCHIVE_DIR/CLAUDE.md."* 2>/dev/null | wc -l)
  if [[ $ARCHIVE_COUNT -gt $MAX_ARCHIVES ]]; then
    find "$ARCHIVE_DIR" -maxdepth 1 -name 'CLAUDE.md.*' -print0 | sort -rz | tail -n +$((MAX_ARCHIVES + 1)) -z | xargs -0 rm -f
    echo "[CLAUDE.md] ✓ Cleaned old archives (kept $MAX_ARCHIVES versions)" >&2
  fi

  # Suggest optimizations
  echo "" >&2
  echo "[CLAUDE.md] Optimization suggestions:" >&2
  echo "  1. Move 'Deprioritized' section → separate DEPRIORITIZED.md" >&2
  echo "  2. Move 'Operations' → separate OPERATIONS.md" >&2
  echo "  3. Move 'Workspace Packages' → separate PACKAGES.md" >&2
  echo "  4. Consolidate patterns → PATTERNS.md" >&2
  echo "" >&2
else
  # Monitor OK
  echo "[CLAUDE.md] ✓ Monitor OK ($LINE_COUNT lines)" >&2
fi

exit 0
