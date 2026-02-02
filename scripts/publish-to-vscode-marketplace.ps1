
Write-Host 'bump version? (y/N): ' -NoNewline
if ($host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown').Character -in 'y','Y') {
    node ./scripts/bump-version.js
    git add package.json package.jsonc
    $newver = $(node -e "console.log(require('./package.json').version)")
    git commit -m "chore(release): v$newver"
    git tag -a v$newver -m "release"
}
else {
    git add -A
    git commit
}

git push origin HEAD
git push origin --tags

# Use pnpm to run vsce (avoids missing npx on some systems)
# pnpm exec -- vsce login Beej

# Publish using the package.json "publish" script which runs vsce
# To avoid storing the token locally, you can run: `pnpm run publish -- --pat <YOUR_PAT>`
pnpm run publish