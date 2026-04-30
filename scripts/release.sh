#!/usr/bin/env bash
set -e

TYPE=${1:-patch}  # patch | minor | major

npm version "$TYPE" --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")

git add package.json package-lock.json
git commit -m "chore(release): v${VERSION}"
git tag "v${VERSION}"
git push origin main --tags

echo "Released v${VERSION}"
