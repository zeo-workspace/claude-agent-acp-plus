#!/usr/bin/env bash
#
# Preflight checks for a release.
#
# release-please decides what the next version is; this script only verifies the
# repository is in a state where merging the open release PR produces a correct
# release. Merging main needs no review, so these checks are the only thing
# standing between a mistake and a published package — keep them as code rather
# than as a list someone has to remember. See docs/RELEASES.md.
#
# Requires an authenticated GitHub CLI. Nothing else: gh has a jq engine builtin.

set -euo pipefail

PENDING_LABEL="autorelease: pending"

fail() {
  printf 'FAIL  %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok    %s\n' "$1"
}

command -v gh >/dev/null 2>&1 ||
  fail "GitHub CLI (gh) is not installed."
gh auth status >/dev/null 2>&1 ||
  fail "GitHub CLI is not authenticated. Run 'gh auth login'."

repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null) ||
  fail "cannot work out which GitHub repository this is. Run from a checkout."

# A merged release PR that still carries the pending label means release-please
# never tagged it. In that state it refuses to open any new release PR at all,
# so every later release stalls silently until it is recovered by hand.
stuck=$(gh pr list --repo "$repo" --state merged --label "$PENDING_LABEL" \
  --json number --jq 'map("#\(.number)") | join(", ")')
[ -z "$stuck" ] ||
  fail "merged release PR still labelled '$PENDING_LABEL': $stuck.
      release-please is jammed and will not open new release PRs.
      See docs/RELEASES.md, 'Recovering a stalled release'."
pass "no untagged merged release PR"

rows=$(gh pr list --repo "$repo" --state open --label "$PENDING_LABEL" \
  --json number,title,headRefName --jq '.[] | [.number, .headRefName, .title] | @tsv')
count=$(printf '%s\n' "$rows" | grep -c . || true)

if [ "$count" -eq 0 ]; then
  fail "no open release PR.
      Nothing has landed since the last tag that release-please puts in a
      changelog, so there is nothing to release. Land a feat/fix/perf/revert/docs
      change first, or check that the Publish and Release workflow is running."
fi
if [ "$count" -gt 1 ]; then
  fail "$count open release PRs, expected exactly one:
$rows"
fi
IFS=$(printf '\t') read -r pr_number head_ref pr_title <<EOF
$rows
EOF
pass "one open release PR: #$pr_number ($pr_title)"

# release-please reads the version to tag from the PR title, while npm publishes
# whatever package.json says. If those disagree the tag and the published package
# describe different releases, so check all three sources against each other.
# The version is the last field, not everything after 'release': release-please
# writes the component into the title as 'release <component> X.Y.Z' whenever it
# is configured to tag with one.
title_version=${pr_title##* }
case $title_version in
[0-9]*.[0-9]*.[0-9]*) ;;
*) fail "cannot read a version from PR title '$pr_title'." ;;
esac
pkg_version=$(gh api "repos/$repo/contents/package.json?ref=$head_ref" \
  -H "Accept: application/vnd.github.raw" --jq .version)
manifest_version=$(gh api "repos/$repo/contents/.release-please-manifest.json?ref=$head_ref" \
  -H "Accept: application/vnd.github.raw" --jq '."."')

if [ "$title_version" != "$pkg_version" ] || [ "$title_version" != "$manifest_version" ]; then
  fail "version mismatch on #$pr_number:
      PR title                      $title_version
      package.json                  $pkg_version
      .release-please-manifest.json $manifest_version"
fi
pass "version agrees across PR title, package.json and manifest: $title_version"

# The tag comes from the config, not from the PR title. With
# include-component-in-tag left on, release-please tags <component>-vX.Y.Z, which
# breaks the vX.Y.Z scheme the rest of this script and docs/RELEASES.md rely on,
# and makes it rewrite the whole history into the changelog because no tag under
# that scheme exists yet. The compare link it writes into the PR body names the
# tags it is going to use, so check those rather than trusting the config.
compare_tag=$(gh pr view "$pr_number" --repo "$repo" --json body --jq '
  .body | capture("/compare/[^)]*[.][.][.](?<to>[^)\\s]+)").to // ""' 2>/dev/null || true)
case $compare_tag in
"" | "v$title_version") ;;
*) fail "release-please is going to tag '$compare_tag', not 'v$title_version'.
      Every previous release is tagged vX.Y.Z, and the changelog for #$pr_number
      covers the whole history rather than just this release, because no tag
      under that scheme exists. Set 'include-component-in-tag': false in
      release-please-config.json, then let it rewrite the release PR." ;;
esac

if gh release view "v$title_version" --repo "$repo" >/dev/null 2>&1; then
  fail "tag v$title_version already exists. Merging would try to release it twice."
fi
pass "tag v$title_version does not exist yet"

# ── The four checks a release PR never gets ─────────────────────────────────
#
# The `name:` of each job GitHub would have run, which is also the context
# scripts/ci-attest.sh publishes each status under. Written once, here, and
# interpolated into the query below rather than re-typed into it: GitHub keys a
# check by that string, so one character of drift makes the guard look for
# something that does not exist — and nothing anywhere errors when it does.
REQUIRED_CHECKS=(
  "Build"
  "Secret scan (gitleaks)"
  "Dependency scan (OSV-Scanner)"
  "npm audit"
)

# gh's jq engine takes no --arg, so the names have to travel inside the program
# text itself. Quote them into a jq array literal: a name carrying a quote or a
# backslash would otherwise close the string early and leave a program that does
# not parse.
jq_string_array() {
  local out="" item
  for item in "$@"; do
    item=${item//\\/\\\\}
    item=${item//\"/\\\"}
    out="$out,\"$item\""
  done
  printf '[%s]' "${out#,}"
}
required_json=$(jq_string_array "${REQUIRED_CHECKS[@]}")

# A rollup mixes two shapes, and reading only one of them was the defect this
# replaces. A check run — what a workflow produces — carries .name and
# .conclusion; a commit status — what ci-attest.sh publishes — carries .context
# and .state. Matching on .name alone made every published attestation invisible,
# so the guard waved through a PR whose checks it had never actually seen, and
# it examined only one of the four at that.
#
# Only the rollup is consulted, and deliberately so: it reports the checks on the
# pull request's *current* head, and release-please moves that head every time it
# rewrites the PR. Asking for the statuses of a SHA named anywhere else would let
# an attestation made against a superseded commit satisfy the guard (R3.6).
#
# The query answers with one line per check that is missing or not successful,
# and with nothing at all when all four passed — so a single run tells the whole
# story instead of stopping at the first problem. A check outside the four is
# never consulted: CodeQL runs on these PRs through GitHub's default
# code-scanning setup and can fail for reasons this guard does not own.
#
# A job a reusable workflow runs is named "<caller job> / <inner job>" — the
# hosted OSV run is "Dependency scan (OSV-Scanner) / osv-scan" — so an entry
# also answers to its required name followed by " / ". The exact name is taken
# first: it is what ci-attest.sh publishes, and a failed attestation must not be
# outvoted by a hosted run. A name that merely starts the same way does not count.
#
# Read it downwards: take the rollup, walk the four required names, find the
# entry for each, work out its state, and keep only the ones that are not a
# success. $rollup, $want, $entry and $got are jq's variables, not the shell's,
# and the single quotes are what keeps them out of the shell's hands; only
# $required_json is meant to expand, and it does so from outside those quotes.
# shellcheck disable=SC2016
not_passing=$(gh pr view "$pr_number" --repo "$repo" --json statusCheckRollup --jq '
  def outcome: (.conclusion // .state // .status // "PENDING") | tostring | ascii_upcase;
  (.statusCheckRollup // []) as $rollup
  | '"$required_json"'[]
  | . as $want
  | ($rollup | map(select((.name // .context) == $want))
      + map(select((.name // "") | startswith($want + " / ")))
    | first) as $entry
  | (if $entry == null then "MISSING" else ($entry | outcome) end) as $got
  | select($got != "SUCCESS")
  | "\($want) is \($got)"')

if [ -n "$not_passing" ]; then
  # Indent every line into the refusal. `IFS= read -r` keeps the line intact:
  # unlike a tab-separated read, it cannot fold or trim anything away.
  detail=""
  while IFS= read -r problem; do
    [ -n "$problem" ] || continue
    detail="$detail
      $problem"
  done <<<"$not_passing"
  fail "required checks are not passing on #$pr_number:$detail
      pull_request workflows do not run on a release PR, so a check is absent
      rather than red. Run those jobs here and publish the outcome onto the PR
      head:

        npm run release:attest        (scripts/ci-attest.sh)

      See docs/RELEASES.md."
fi
joined=$(printf '%s, ' "${REQUIRED_CHECKS[@]}")
pass "required checks passed: ${joined%, }"

cat <<EOF

Ready to release $title_version.

  gh pr merge $pr_number --squash

Merging tags v$title_version, publishes to npm and updates the agent registry.
EOF
