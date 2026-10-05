#!/usr/bin/env bash
# The secret scan, run before every push (the repository is public): gitleaks 8.28.0 (its default
# rules) over the full git history and over the working tree, from the local image (never pulled).
# In a git worktree the common git dir is mounted too. Exits non-zero on any finding.
#
#   bash scripts/secret-scan.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${GITLEAKS_IMAGE:-zricethezav/gitleaks:v8.28.0}"
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "secret-scan: $IMAGE is not present locally (never pulled)" >&2; exit 2; }
COMMON_GIT="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)"
OWN_GIT="$(git -C "$ROOT" rev-parse --path-format=absolute --git-dir)"
MOUNTS=(-v "$ROOT:/repo:ro")
if [[ "$OWN_GIT" == "$COMMON_GIT/"* ]]; then
  MOUNTS+=(-v "$COMMON_GIT:/gitcommon:ro" -e "GIT_DIR=/gitcommon/${OWN_GIT#"$COMMON_GIT/"}" -e GIT_WORK_TREE=/repo)
fi
run() {
  docker run --rm "${MOUNTS[@]}" -w /repo --entrypoint sh "$IMAGE" -c \
    'git config --global --add safe.directory "*" >/dev/null 2>&1; gitleaks "$@" --config /repo/.gitleaks.toml --redact --no-banner --log-level warn' sh "$@"
}
echo "secret-scan: git history"
run git /repo
echo "secret-scan: working tree"
run dir /repo
echo "secret-scan: no findings"
