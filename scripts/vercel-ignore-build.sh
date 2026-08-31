#!/usr/bin/env bash
# Vercel "Ignored Build Step" — skip deployments whose diff is documentation only.
#
# Vercel's contract (inverted from the usual): exit 0 CANCELS the build, exit 1
# lets it proceed. Vercel clones with `git clone --depth=10`, so the base commit
# may be missing from history; every uncertain case falls through to a build.
#
# Base is VERCEL_GIT_PREVIOUS_SHA — the last *successfully deployed* commit on
# this branch (exposed only when an ignore step is set). That is what makes a
# multi-commit push safe: HEAD^ alone would see only the newest commit, so a
# push of "fix editor" + "tweak README" would be judged docs-only and skipped.
# A canceled build is not a successful deployment, so consecutive docs pushes
# keep diffing against the last commit that actually shipped.
set -uo pipefail

# Paths that cannot affect the built artifacts (the Vite editor bundle or the
# bridge container). Anything outside this list forces a build.
DOCS_ONLY=(
  ':(exclude)docs'
  ':(exclude)presentation'
  ':(exclude)README.md'
  ':(exclude)CONTEXT.md'
  ':(exclude)AGENTS.md'
  ':(exclude)CLAUDE.md'
  ':(exclude)LICENSE'
  ':(exclude).claude'
  ':(exclude).agents'
)

build()  { echo "▲ building — $1"; exit 1; }
cancel() { echo "▲ skipped — $1"; exit 0; }

have() { git cat-file -e "$1^{commit}" 2>/dev/null; }

base=""
if [[ -n "${VERCEL_GIT_PREVIOUS_SHA:-}" ]] && have "$VERCEL_GIT_PREVIOUS_SHA"; then
  base="$VERCEL_GIT_PREVIOUS_SHA"
elif have "HEAD^"; then
  base="HEAD^"   # first deployment on this branch, or the base fell out of the shallow clone
else
  build "no comparable base commit in the shallow clone"
fi

if git diff --quiet "$base" HEAD -- . "${DOCS_ONLY[@]}"; then
  cancel "documentation only since ${base:0:12}"
fi
build "code changed since ${base:0:12}"
