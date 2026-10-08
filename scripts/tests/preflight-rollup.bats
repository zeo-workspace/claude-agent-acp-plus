#!/usr/bin/env bats
#
# How scripts/release-preflight.sh matches entries in statusCheckRollup (R3.1,
# R3.2, R3.6).
#
# A rollup mixes two shapes. A check run — what a workflow produces — carries
# `.name` and `.conclusion`. A commit status — what the local attestation
# publishes — carries `.context` and `.state`. The guard has to recognise both,
# require all four checks, and read them only from the pull request's current
# head.
#
# `gh` is replaced by a double on PATH that records its calls and answers from
# fixtures; no network call is made and no container is started (R5.3).

setup() {
  # Where the double lives, and the fact that it comes first on PATH, is the
  # harness's business — scripts/tests/harness.bats is where that property is
  # asserted. The double itself stays here: it answers from fixtures by running
  # the script's own --jq program, which stub_bin cannot do.
  # shellcheck source=/dev/null
  source "$BATS_TEST_DIRNAME/helpers/stubs.bash"
  stubs_init
  STUB="$STUB_DIR"

  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/release-preflight.sh"
  FIX="$BATS_TEST_TMPDIR/fixtures"
  GH_LOG="$BATS_TEST_TMPDIR/gh.log"
  mkdir -p "$FIX"
  : >"$GH_LOG"
  export FIX GH_LOG

  write_gh_stub

  fixtures_happy_path
}

write_gh_stub() {
  cat >"$STUB/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"

prog=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
  --jq | -q) prog="${args[i + 1]}" ;;
  esac
done

emit() {
  [ -f "$1" ] || { printf 'fixture missing: %s\n' "$1" >&2; exit 1; }
  if [ -n "$prog" ]; then jq -r "$prog" "$1"; else cat "$1"; fi
}

case "$1" in
auth) exit 0 ;;
repo) emit "$FIX/repo.json" ;;
pr)
  case "$2" in
  list)
    case "$*" in
    *"--state merged"*) emit "$FIX/pr-merged.json" ;;
    *) emit "$FIX/pr-open.json" ;;
    esac
    ;;
  view)
    case "$*" in
    *statusCheckRollup*) emit "$FIX/rollup.json" ;;
    *body*) emit "$FIX/pr-body.json" ;;
    *) emit "$FIX/pr-open.json" ;;
    esac
    ;;
  *) exit 0 ;;
  esac
  ;;
release) exit 1 ;;
api)
  case "$*" in
  *release-please-manifest*) emit "$FIX/manifest.json" ;;
  *package.json*) emit "$FIX/pkg.json" ;;
  *commits/*) emit "$FIX/stale-status.json" ;;
  *statuses/*) emit "$FIX/stale-status.json" ;;
  *) printf '{}\n' ;;
  esac
  ;;
*) exit 0 ;;
esac
SH
  chmod +x "$STUB/gh"
}

fixtures_happy_path() {
  printf '%s\n' '{"nameWithOwner":"acme/widget"}' >"$FIX/repo.json"
  printf '%s\n' '[]' >"$FIX/pr-merged.json"
  printf '%s\n' '[{"number":77,"title":"chore(main): release 0.8.0","headRefName":"release-please--branches--main"}]' >"$FIX/pr-open.json"
  printf '%s\n' '{"version":"0.8.0"}' >"$FIX/pkg.json"
  printf '%s\n' '{".":"0.8.0"}' >"$FIX/manifest.json"
  printf '%s\n' '{"body":"(https://github.com/acme/widget/compare/v0.7.0...v0.8.0)"}' >"$FIX/pr-body.json"
  # An attestation made against a superseded commit. Nothing may read it.
  printf '%s\n' '{"sha":"2222222222222222222222222222222222222222","state":"success","statuses":[{"context":"Build","state":"success"}]}' >"$FIX/stale-status.json"
  rollup "$(status_context Build SUCCESS)" \
    "$(status_context 'Secret scan (gitleaks)' SUCCESS)" \
    "$(status_context 'Dependency scan (OSV-Scanner)' SUCCESS)" \
    "$(status_context 'npm audit' SUCCESS)"
}

check_run() {
  printf '{"__typename":"CheckRun","name":"%s","status":"COMPLETED","conclusion":"%s"}' "$1" "$2"
}

status_context() {
  printf '{"__typename":"StatusContext","context":"%s","state":"%s"}' "$1" "$2"
}

rollup() {
  local joined
  joined=$(printf '%s,' "$@")
  printf '{"statusCheckRollup":[%s]}\n' "${joined%,}" >"$FIX/rollup.json"
}

preflight() {
  (cd "$BATS_TEST_TMPDIR" && bash "$SCRIPT")
}

@test "recognises the four checks when they arrive as commit statuses" {
  run preflight
  [ "$status" -eq 0 ]
  [[ "$output" == *"Ready to release 0.8.0"* ]]
}

@test "recognises a rollup mixing check runs and commit statuses" {
  rollup "$(status_context Build SUCCESS)" \
    "$(check_run 'Secret scan (gitleaks)' SUCCESS)" \
    "$(status_context 'Dependency scan (OSV-Scanner)' SUCCESS)" \
    "$(check_run 'npm audit' SUCCESS)"

  run preflight
  [ "$status" -eq 0 ]
  [[ "$output" == *"Ready to release 0.8.0"* ]]
}

@test "names every missing check rather than stopping at the first" {
  rollup "$(status_context Build SUCCESS)"

  run preflight
  [ "$status" -ne 0 ]
  [[ "$output" == *"Secret scan (gitleaks)"* ]]
  [[ "$output" == *"Dependency scan (OSV-Scanner)"* ]]
  [[ "$output" == *"npm audit"* ]]
}

@test "names every failing check rather than stopping at the first" {
  rollup "$(status_context Build SUCCESS)" \
    "$(status_context 'Secret scan (gitleaks)' FAILURE)" \
    "$(status_context 'Dependency scan (OSV-Scanner)' FAILURE)" \
    "$(status_context 'npm audit' SUCCESS)"

  run preflight
  [ "$status" -ne 0 ]
  [[ "$output" == *"Secret scan (gitleaks)"* ]]
  [[ "$output" == *"Dependency scan (OSV-Scanner)"* ]]
}

@test "a pending check is not treated as a success" {
  rollup "$(status_context Build SUCCESS)" \
    "$(status_context 'Secret scan (gitleaks)' PENDING)" \
    "$(status_context 'Dependency scan (OSV-Scanner)' SUCCESS)" \
    "$(status_context 'npm audit' SUCCESS)"

  run preflight
  [ "$status" -ne 0 ]
  [[ "$output" == *"Secret scan (gitleaks)"* ]]
}

@test "an unrelated failing check does not block the release" {
  rollup "$(status_context Build SUCCESS)" \
    "$(status_context 'Secret scan (gitleaks)' SUCCESS)" \
    "$(status_context 'Dependency scan (OSV-Scanner)' SUCCESS)" \
    "$(status_context 'npm audit' SUCCESS)" \
    "$(check_run 'CodeQL / Analyze (javascript)' FAILURE)"

  run preflight
  [ "$status" -eq 0 ]
  [[ "$output" == *"Ready to release 0.8.0"* ]]
}

@test "reads the checks from the head rollup, never from a superseded commit" {
  run preflight
  [ "$status" -eq 0 ]
  grep -q -- '--json statusCheckRollup' "$GH_LOG"
  # A commit-status query against an explicit SHA could honour an attestation
  # made before release-please rewrote the PR. The rollup already reports the
  # current head; nothing else may be consulted.
  ! grep -qE 'commits/|/statuses/|--json commits' "$GH_LOG"
  ! grep -q '2222222222222222222222222222222222222222' "$GH_LOG"
}

# A job called from a reusable workflow surfaces as "<caller job name> / <inner
# job name>" — Security's OSV job is `uses: osv-scanner-reusable.yml`, so the
# hosted run is "Dependency scan (OSV-Scanner) / osv-scan". Release PRs get
# hosted runs since they are opened with an App token, and the guard read that
# passing scan as MISSING (release 0.25.2, PR #148).

@test "recognises a required check run that a reusable workflow suffixed" {
  rollup "$(check_run Build SUCCESS)" \
    "$(check_run 'Secret scan (gitleaks)' SUCCESS)" \
    "$(check_run 'Dependency scan (OSV-Scanner) / osv-scan' SUCCESS)" \
    "$(check_run 'npm audit' SUCCESS)"

  run preflight
  [ "$status" -eq 0 ]
  [[ "$output" == *"Ready to release 0.8.0"* ]]
}

@test "a failing suffixed run is reported, not passed" {
  rollup "$(check_run Build SUCCESS)" \
    "$(check_run 'Secret scan (gitleaks)' SUCCESS)" \
    "$(check_run 'Dependency scan (OSV-Scanner) / osv-scan' FAILURE)" \
    "$(check_run 'npm audit' SUCCESS)"

  run preflight
  [ "$status" -ne 0 ]
  [[ "$output" == *"Dependency scan (OSV-Scanner) is FAILURE"* ]]
}

@test "a name that only starts like a required one does not stand in for it" {
  rollup "$(check_run Build SUCCESS)" \
    "$(check_run 'Secret scan (gitleaks)' SUCCESS)" \
    "$(check_run 'Dependency scan (OSV-Scanner)-fork / osv-scan' SUCCESS)" \
    "$(check_run 'Dependency scan (OSV-Scanner) mirror' SUCCESS)" \
    "$(check_run 'npm audit' SUCCESS)"

  run preflight
  [ "$status" -ne 0 ]
  [[ "$output" == *"Dependency scan (OSV-Scanner) is MISSING"* ]]
}

@test "an exact entry wins over a suffixed one: a failed attestation still blocks" {
  rollup "$(check_run Build SUCCESS)" \
    "$(check_run 'Secret scan (gitleaks)' SUCCESS)" \
    "$(check_run 'Dependency scan (OSV-Scanner) / osv-scan' SUCCESS)" \
    "$(status_context 'Dependency scan (OSV-Scanner)' FAILURE)" \
    "$(check_run 'npm audit' SUCCESS)"

  run preflight
  [ "$status" -ne 0 ]
  [[ "$output" == *"Dependency scan (OSV-Scanner) is FAILURE"* ]]
}
