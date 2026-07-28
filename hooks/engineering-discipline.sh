#!/usr/bin/env bash
# Standing engineering directives — injected only on build/plan prompts (token-thrifty; silent otherwise).
# Keyword-gated against the payload with path-bearing fields (cwd, transcript_path) stripped first,
# so a keyword in a directory name (e.g. ~/design-system) can't false-trigger on every prompt.
# What remains is the prompt + ids — a match means the verb is in the user's prompt. No JSON parser dependency.
input="$(LC_ALL=C sed -E 's/"(transcript_path|cwd)"[[:space:]]*:[[:space:]]*"[^"]*"//g')"
if printf '%s' "$input" | LC_ALL=C grep -qiE '\b(implement|build|refactor|plan|feature|fix|add|migrat[a-z]*|design|tdd|task)\b'; then
  cat <<'DIRECTIVES'
<engineering-discipline>
- PLAN first, hunting known AND unknown unknowns before writing code. For substantial or behavior-touching work, adversarially critique the plan/diff with a critic subagent, matched to the risk: a sonnet critic at low/standard effort for most changes, opus at higher effort for architecture or subtle-correctness work, and the costly fable/codex critics only for the highest-risk or shippable work. Skip the critic pass on trivial or mechanical edits.
- TDD: write the failing test first, confirm it fails for the right reason, then the minimal green.
- Pure functions; push I/O, state mutation, and side effects to the edges.
- Craft the developer experience: APIs and CLIs should be a joy to use — clear names, sensible defaults, helpful errors, and the ecosystem's own idioms and conventions (least-surprise), so calling your code feels natural, even fun.
- No god classes or functions: one responsibility each, keep them small; split anything that sprawls.
- Cost-aware delegation: sonnet for mechanical/low-risk work, opus for architecture/deep debugging; set reasoning effort to the minimum that fits the task.
- Structure every plan as FILE-DISJOINT units so multiple subagents can execute in parallel with no collision.
- Comment budget: a comment must document a TRAP (something that silently does the wrong thing if changed) or a non-obvious WHY. A comment that restates the code gets deleted. Calibrate to the density of the repo you are in, not to a general style — read a neighbouring file and match it.
- Reuse before you write: if a function is reasonably reusable, reuse it. Before adding a helper, `git grep` for one that already does the job — by name AND by a distinctive line of its body, since the copy you are about to make may exist under a different name with renamed parameters. Extend the existing one rather than adding a near-twin, and say which one you checked.
- When one commit adds two files in the same directory, diff them against each other before finishing. The general reuse rule above did not stop `formatDose` being written twice inside a single commit; this check would have.
- When you add a field to a mock or context object literal, grep for every sibling file with the same literal and update its TYPE in the same edit. A literal and its type are two sources of truth for one shape, and typecheck stays green while they disagree.
- Before any push, write a short "what this diff assumes" note from a read of the FINAL diff: the invariants it relies on and what would break them. The test is whether it can be written at all — if it cannot, the code is not understood yet and is not ready to ship.
- Verify a "no callers anywhere" claim in EVERY worktree/branch of the stack, not just the one you are in. A grep scoped to one worktree that gets generalised to "the repo" is how a still-used helper gets deleted.
</engineering-discipline>
DIRECTIVES
fi
exit 0
