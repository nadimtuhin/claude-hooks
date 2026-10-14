package main

// Generated from hook.mjs by the port; the pattern text is copied verbatim.

var (
	excludedDirRe  = mustJS(`(?:^|\/)(?:node_modules|dist|build|out|coverage|vendor|generated|\.git|\.next|target)(?:\/|$)|\/tmp\/claude-[^/]+\/.*\/scratchpad\/`, false)
	excludedFileRe = mustJS(`\.min\.[a-z]+$|\.(?:lock|map|snap)$|-lock\.(?:json|ya?ml)$`, false)
	scannableRe    = mustJS(`\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|php|sh|bash|c|h|cc|cpp|hpp|cs|scala|sql|md)$`, false)
	testPathRe     = mustJS(`(?:^|\/)(?:tests?|__tests__|spec|e2e)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:py|go|rb)$|test_[^/]+\.py$`, false)
)

const usageText = `no-slop — a tripwire for mechanical AI slop.

  no-slop write               PostToolUse hook (stdin JSON). Reports; cannot prevent.
  no-slop commit              PreToolUse hook (stdin JSON). Blocks the commit on BLOCK findings.
  no-slop turn                Stop hook (stdin JSON). Advisory prose check.
  no-slop scan <path>...      Scan files or directories.
  no-slop scan --stdin [--commit|--prose|--code]
  no-slop baseline [path]     Snapshot current findings and suppress them from now on.

Flags: --all (no output cap), --severity=warn|block, --no-baseline
`
