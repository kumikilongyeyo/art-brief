#!/usr/bin/env bash
# Local gated deploy to GitHub Pages (gh-pages branch).
# Same gate as ci/github-actions-deploy.yml: any failure stops the deploy and the live site stays as it was.
# Once the GitHub token has the `workflow` scope, move ci/github-actions-deploy.yml back to
# .github/workflows/deploy.yml and switch Pages to "GitHub Actions" — then pushing main deploys by itself.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "✗ Commit your changes first (deploys are tied to a commit)." >&2
  exit 1
fi

echo "▸ validate data";   npm run validate
echo "▸ lint + types";    npm run lint && npx tsc --noEmit
echo "▸ unit tests";      npm test
echo "▸ build";           npm run build
echo "▸ end-to-end";      CI=1 E2E_PORT=4174 npx playwright test

SHA=$(git rev-parse --short HEAD)
REMOTE=$(git remote get-url origin)
NAME=$(git config user.name)
EMAIL=$(git config user.email)
OUT=$(mktemp -d)
cp -R dist/. "$OUT/"
touch "$OUT/.nojekyll"
(
  cd "$OUT"
  git init -q -b gh-pages
  git -c user.name="$NAME" -c user.email="$EMAIL" add -A
  git -c user.name="$NAME" -c user.email="$EMAIL" commit -q -m "Deploy $SHA"
  git push -q -f "$REMOTE" gh-pages
)
rm -rf "$OUT"
git push -q origin HEAD:main
echo "✓ Deployed $SHA → https://kumikilongyeyo.github.io/art-brief/ (Pages takes ~1 min to refresh)"
