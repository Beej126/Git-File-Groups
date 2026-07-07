$ErrorActionPreference = 'Stop'

git add -A

# pnpm does not support npm's --force flag on "pnpm version".
# Bump without auto-commit/tag, then create commit + tag explicitly.
pnpm version patch --no-git-tag-version

$newVersion = node -p "require('./package.json').version"
if (-not $newVersion) {
	throw 'Failed to read updated version from package.json'
}

git commit -m "chore(release): v$newVersion"
git tag "v$newVersion"

git push origin HEAD
git push origin "v$newVersion"
