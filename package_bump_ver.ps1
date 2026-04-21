git add -A

# --force allows "dirty" changes to be committed, which is necessary because the version bump will modify the package.json files.
pnpm version patch -m "chore(release): v%s" --force

git push origin HEAD
git push origin --tags
