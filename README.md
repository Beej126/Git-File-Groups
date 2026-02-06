## [VSCode Marketplace link](https://marketplace.visualstudio.com/items?itemName=Beej.git-file-groups)

# Git File Groups (for VSCode)

A tool for bundling changed files into named groups.

Intended as a lightweight mechanism for organizing work in progress.

Not intended for industrial grade project work where pull-requests and branches are the obvious choices.


## Features

- Sits as an additional panel in the Source Control view alongside Changes, Branches, etc
- Groups can be created, renamed, deleted and files drag/dropped
- File Diff, Open & Revert just like main 'Changes' panel
- **File Rename** 🚀 - i know it's a bit silly but it always annoys me that i can't rename in the git changes panel... have to click out the explorer view to do that, well NO MORE! 😄
- External links - regexp patterns in the group title can be linked to external tools (azure devops, etc) - see $/.vscode/git-file-groups.json
- Each group commit button auto stages ONLY that group's files and initiates standard commit flow
- Group title is the default commit message

## [MIT License](LICENSE.txt)
