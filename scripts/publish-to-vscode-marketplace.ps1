node ./scripts/bump-version.js
git add package.json package.jsonc
$newver = $(node -e "console.log(require('./package.json').version)")
git commit -m "chore(release): v$newver"
git tag -a v$newver -m "release"

git push origin HEAD
git push origin --tags

npx vsce login Beej
pnpm run publish