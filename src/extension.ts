import * as vscode from 'vscode';
import * as path from 'path';
import { FileNode, GitFileGroupsProvider, GroupNode } from './GitFileGroupsProvider';
import { log } from './logging';

log('Loading extension.ts', 'lifecycle');

export function activate(context: vscode.ExtensionContext) {
    log('Activating extension...', 'lifecycle');

    // Helper to initialize extension when a workspace root is available.
    const initializeForWorkspace = (workspaceRoot: string) => {
        log(`Creating GitFileGroupsProvider with workspaceRoot: ${workspaceRoot}`, 'lifecycle');
        const gitFileGroupsProvider = new GitFileGroupsProvider(workspaceRoot, context.globalState);

        const dragAndDropController: vscode.TreeDragAndDropController<vscode.TreeItem> = {
        dragMimeTypes: ['application/vnd.code.tree.git-file-groups'],
        dropMimeTypes: ['application/vnd.code.tree.git-file-groups'],
        handleDrag: async (source: readonly vscode.TreeItem[], dataTransfer: vscode.DataTransfer) => {
            const uris: string[] = [];
            for (const item of source) {
                const uri = item instanceof FileNode ? item.fileUri : item.resourceUri;
                if (uri) {
                    uris.push(uri.toString());
                }
            }

            dataTransfer.set(
                'application/vnd.code.tree.git-file-groups',
                new vscode.DataTransferItem(JSON.stringify({ uris }))
            );
        },
        handleDrop: async (target: vscode.TreeItem | undefined, dataTransfer: vscode.DataTransfer) => {
            if (!target) {
                return;
            }

            // Determine the target group: allow dropping onto the group header
            // or anywhere on a file within the group (resolve parent group).
            let targetGroupName: string | undefined;
            if (target instanceof GroupNode) {
                targetGroupName = target.groupName;
            } else if (target instanceof FileNode) {
                const parent = gitFileGroupsProvider.getParent(target);
                if (parent instanceof GroupNode) {
                    targetGroupName = parent.groupName;
                }
            }

            if (!targetGroupName) {
                return;
            }

            const item = dataTransfer.get('application/vnd.code.tree.git-file-groups');
            if (!item) {
                return;
            }

            const raw = await item.asString();
            let parsed: { uris: string[] } | undefined;
            try {
                parsed = JSON.parse(raw);
            } catch {
                parsed = undefined;
            }

            if (!parsed?.uris?.length) {
                return;
            }

            const uris = parsed.uris.map(u => vscode.Uri.parse(u));
            await gitFileGroupsProvider.moveFilesToGroup(uris, targetGroupName);
        }
        };

        log('Registering Tree Data Provider', 'lifecycle');
        const treeView = vscode.window.createTreeView('gitFileGroupsTreeView', {
            treeDataProvider: gitFileGroupsProvider,
            showCollapseAll: false,
            canSelectMany: true,
            dragAndDropController
        });

        gitFileGroupsProvider.setTreeView(treeView);

        // Initialize the context for the toggle button
        vscode.commands.executeCommand('setContext', 'gitFileGroups.isExpanded', true);

        context.subscriptions.push(treeView);
        context.subscriptions.push(gitFileGroupsProvider);

        // Register commands after provider exists
        registerCommands(gitFileGroupsProvider, context);

        // Promise-based wait for Git repositories to be available.
        const waitForGitRepositories = async (): Promise<void> => {
        const gitExtension = vscode.extensions.getExtension('vscode.git');
        if (!gitExtension) {
            log('Git extension not available', 'git');
            return;
        }
        if (!gitExtension.isActive) {
            await gitExtension.activate();
        }
        const api = gitExtension.exports.getAPI(1);

        // Prefer event-driven if available.
        if (api.onDidChangeState) {
            return new Promise<void>((resolve) => {
                const disposable = api.onDidChangeState(() => {
                    if (api.repositories && api.repositories.length > 0) {
                        disposable.dispose();
                        log('Git repositories ready via onDidChangeState', 'git');
                        resolve();
                    }
                });
                // Resolve immediately if already populated.
                    if (api.repositories && api.repositories.length > 0) {
                    disposable.dispose();
                    resolve();
                }
            });
        }

        // Fallback: short-interval polling.
        for (let i = 0; i < 20; i++) {
            if (api.repositories && api.repositories.length > 0) {
                log('Git repositories ready via polling', 'git');
                return;
            }
            await new Promise(r => setTimeout(r, 200));
        }
        log('Git repositories still not ready after polling', 'git');
        };

        waitForGitRepositories().then(async () => {
            log('Refreshing after Git repositories are ready', 'lifecycle');
            gitFileGroupsProvider.refresh();

            // Subscribe to repository state changes so the view updates when files change
            try {
                const gitExtension = vscode.extensions.getExtension('vscode.git');
                if (gitExtension && gitExtension.isActive) {
                    const api = gitExtension.exports.getAPI(1);
                    const repo = api.repositories.find((r: any) => {
                        const repoPath = r.rootUri?.fsPath;
                        return repoPath && path.normalize(repoPath).toLowerCase() === path.normalize(gitFileGroupsProvider.getWorkspaceRoot()).toLowerCase();
                    });

                    if (repo && repo.state && typeof repo.state.onDidChange === 'function') {
                        const disposable = repo.state.onDidChange(() => {
                            log('Repository state changed - refreshing', 'git');
                            gitFileGroupsProvider.refresh();
                        });
                        context.subscriptions.push(disposable);
                    }

                    // Listen for repositories being opened (in case the repo was added later)
                    if (typeof api.onDidOpenRepository === 'function') {
                        const d2 = api.onDidOpenRepository((r: any) => {
                            const repoPath = r.rootUri?.fsPath;
                            if (repoPath && path.normalize(repoPath).toLowerCase() === path.normalize(gitFileGroupsProvider.getWorkspaceRoot()).toLowerCase()) {
                                log('Repository opened - refreshing', 'git');
                                gitFileGroupsProvider.refresh();
                            }
                        });
                        context.subscriptions.push(d2);
                    }
                }
            } catch (e) {
                log(`Failed to subscribe to Git events: ${e}`, 'git');
            }
        });
    };

    // If a workspace is already open, initialize immediately. Otherwise listen for folders.
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const currentWorkspaceFolder = workspaceFolders[0];
        const workspaceRoot = currentWorkspaceFolder.uri.fsPath;
        if (workspaceRoot) {
            initializeForWorkspace(workspaceRoot);
            return;
        }
    }

    // No workspace open — listen for workspace folder additions and initialize then.
    const folderDisposable = vscode.workspace.onDidChangeWorkspaceFolders((e) => {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            return;
        }
        const folder = vscode.workspace.workspaceFolders[0];
        if (folder) {
            initializeForWorkspace(folder.uri.fsPath);
            folderDisposable.dispose();
        }
    });
    context.subscriptions.push(folderDisposable);
}

function registerCommands(gitFileGroupsProvider: any, context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('git-file-groups.refreshGroup', () => {
        if (gitFileGroupsProvider) {
            log('Refresh command triggered', 'view');
            gitFileGroupsProvider.refresh();
        }
    });

    let createGroupCommand = vscode.commands.registerCommand('git-file-groups.createGroup', async () => {
        const name = await vscode.window.showInputBox({
            prompt: 'Create a new group',
            placeHolder: 'Group name'
        });

        if (typeof name !== 'string') {
            return;
        }

        await gitFileGroupsProvider.addGroup(name);
    });

    let renameGroupCommand = vscode.commands.registerCommand('git-file-groups.renameGroup', async (groupNode: GroupNode) => {
        if (!groupNode || !groupNode.groupName) {
            return;
        }

        const oldName = groupNode.groupName;
        const newName = await vscode.window.showInputBox({
            prompt: 'Rename group',
            value: oldName,
            placeHolder: 'New group name'
        });

        if (typeof newName !== 'string' || newName.trim() === oldName) {
            return;
        }

        await gitFileGroupsProvider.renameGroup(oldName, newName);
    });

    let commitGroupCommand = vscode.commands.registerCommand('git-file-groups.commitGroup', async (groupNode: GroupNode) => {
        if (!groupNode || !groupNode.groupName) {
            return;
        }

        await gitFileGroupsProvider.commitGroup(groupNode.groupName);
    });

    let deleteGroupCommand = vscode.commands.registerCommand('git-file-groups.deleteGroup', async (groupNode: GroupNode) => {
        if (!groupNode || !groupNode.groupName) {
            return;
        }

        if (groupNode.groupName === GitFileGroupsProvider.UNGROUPED) {
            return; // Don't allow deleting the default group
        }

        const confirmed = await vscode.window.showWarningMessage(
            `Delete group "${groupNode.groupName}"? This will move its files to ${GitFileGroupsProvider.UNGROUPED}.`,
            { modal: true },
            'Delete'
        );

        if (confirmed === 'Delete') {
            await gitFileGroupsProvider.deleteGroup(groupNode.groupName);
        }
    });

    let openLinkCommand = vscode.commands.registerCommand('git-file-groups.openLink', async (url: string) => {
        if (!url) {
            return;
        }
        try {
            await vscode.env.openExternal(vscode.Uri.parse(url));
        } catch (e) {
            log(`openLink failed: ${e}`, 'view');
            try {
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(url));
            } catch (e2) {
                    log(`fallback open failed: ${e2}`, 'view');
            }
        }
    });

    let commitWithMessageCommand = vscode.commands.registerCommand('git-file-groups.commitWithMessage', async () => {
        const message = await vscode.window.showInputBox({
            prompt: 'Commit message',
            placeHolder: 'Enter commit message...'
        });

        if (!message) {
            return;
        }

        await gitFileGroupsProvider.stageAllChanges();

        try {
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            if (gitExtension && gitExtension.isActive) {
                const api = gitExtension.exports.getAPI(1);
                const repository = api.repositories.find((repo: any) => {
                    const repoPath = repo.rootUri?.fsPath;
                    return repoPath && path.normalize(gitFileGroupsProvider.getWorkspaceRoot()).toLowerCase() === path.normalize(repoPath).toLowerCase();
                });
                if (repository) {
                    await repository.commit(message);
                    log(`Committed with message: ${message}`, 'git');
                    // Refresh view after commit so active changes and groups update
                    gitFileGroupsProvider.refresh();
                }
            }
        } catch (error) {
            log(`Direct commit failed: ${error}`, 'git');
        }
    });

    let openDiffCommand = vscode.commands.registerCommand('git-file-groups.openDiff', async (arg: vscode.Uri | vscode.TreeItem | undefined) => {
        const resourceUri = arg instanceof vscode.Uri ? arg : arg?.resourceUri;
        log(`Open diff command triggered! Arg: ${JSON.stringify(arg)}, ResourceUri: ${resourceUri}`, 'view');

        if (!resourceUri) {
            log('No resourceUri provided for diff', 'view');
            return;
        }

        try {
            await vscode.commands.executeCommand('git.openChange', resourceUri);
            log('git.openChange succeeded', 'view');
        } catch (error) {
            log(`git.openChange failed, falling back to open file: ${error}`, 'view');
            try {
                await vscode.window.showTextDocument(resourceUri, {
                    preview: true,
                    viewColumn: vscode.ViewColumn.One
                });
                log('showTextDocument fallback succeeded', 'view');
            } catch (fallbackError) {
                log(`showTextDocument fallback failed: ${fallbackError}`, 'view');
            }
        }
    });

    let openFileCommand = vscode.commands.registerCommand('git-file-groups.openFile', async (arg: vscode.Uri | vscode.TreeItem | undefined) => {
        const resourceUri = arg instanceof vscode.Uri ? arg : arg?.resourceUri;
        log(`Open file command triggered! Arg: ${JSON.stringify(arg)}, ResourceUri: ${resourceUri}`, 'view');

        if (!resourceUri) {
            log('No resourceUri provided', 'view');
            return;
        }

        log(`Opening file: ${resourceUri.fsPath}`, 'view');
        
        try {
            await vscode.window.showTextDocument(resourceUri, {
                preview: false,
                viewColumn: vscode.ViewColumn.One
            });
            log('showTextDocument succeeded', 'view');
        } catch (error) {
            log(`showTextDocument failed, falling back to vscode.open: ${error}`, 'view');
            try {
                await vscode.commands.executeCommand('vscode.open', resourceUri, {
                    preview: false,
                    viewColumn: vscode.ViewColumn.One
                });
                log('vscode.open succeeded', 'view');
            } catch (fallbackError) {
        }
    }
});

    let discardChangeCommand = vscode.commands.registerCommand('git-file-groups.discardChange', async (arg: vscode.Uri | vscode.TreeItem | undefined) => {
        const resourceUri = arg instanceof vscode.Uri ? arg : arg instanceof vscode.TreeItem ? arg.resourceUri : undefined;
        if (!resourceUri) return;

        const fileName = resourceUri.fsPath.split(/[\\/]/).pop() || resourceUri.fsPath;
        const confirmed = await vscode.window.showWarningMessage(
            `Discard changes to ${fileName}? This cannot be undone.`,
            { modal: true },
            'Discard'
        );
        if (confirmed !== 'Discard') return;

        try {
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            if (!gitExtension) {
                vscode.window.showErrorMessage('Git extension not available');
                return;
            }
            if (!gitExtension.isActive) await gitExtension.activate();
            const api = gitExtension.exports.getAPI(1);
            const repository = api.repositories.find((repo: any) => {
                const repoPath = repo.rootUri?.fsPath;
                return repoPath && path.normalize(repoPath).toLowerCase() === path.normalize(gitFileGroupsProvider.getWorkspaceRoot()).toLowerCase();
            });
            if (!repository) {
                vscode.window.showErrorMessage('Repository not found for file');
                return;
            }

            // Determine whether the change appears untracked
            const state = repository.state;
            const changes = (state?.workingTreeChanges || []).concat(state?.indexChanges || []);
            const match = changes.find((c: any) => {
                const p = c?.resourceUri?.fsPath ?? c?.uri?.fsPath ?? c?.path;
                if (!p) return false;
                try { return path.normalize(p).toLowerCase() === path.normalize(resourceUri.fsPath).toLowerCase(); } catch { return false; }
            });

            let isUntracked = false;
            if (match) {
                try {
                    const repr = JSON.stringify(match).toLowerCase();
                    isUntracked = repr.includes('untracked') || (typeof match.status === 'number' && match.status === 7);
                } catch { isUntracked = false; }
            }

            // Use the Git extension repository API directly with defensive fallbacks.
            const callRepositoryMethodWithFallback = async (methodName: 'clean' | 'revert') => {
                // Try the most-compatible shapes first: filesystem path string, then Uri, then stringified Uri
                const attempts: any[][] = [ [resourceUri.fsPath], [resourceUri], [resourceUri.toString()] ];
                // If we have the matched SourceControlResourceState from earlier, include it as a last-resort attempt
                if (match) {
                    attempts.push([match]);
                }

                for (const args of attempts) {
                    try {
                        const fn = (repository as any)[methodName];
                        if (typeof fn !== 'function') {
                            log(`repository.${methodName} is not a function`, 'git-discard');
                            continue;
                        }
                        const argPreview = args.map(a => (a && (a as any).fsPath) ? (a as any).fsPath : String(a));
                        log(`Attempting repository.${methodName} with args: ${JSON.stringify(argPreview)}`, 'git-discard');
                        // Call the repository method with the single-array argument (resources array)
                        await fn.call(repository, args);
                        log(`repository.${methodName} succeeded with args: ${JSON.stringify(argPreview)}`, 'git-discard');
                        return true;
                    } catch (err: any) {
                        log(`repository.${methodName} failed with args ${JSON.stringify(args)}: ${err && err.message ? err.message : String(err)}`, 'git-discard');
                        // If this is the specific replace-type error, continue to next attempt.
                        continue;
                    }
                }

                // Final fallback: try invoking the git command (CommandCenter) with the matched resource if available
                if (match) {
                    try {
                        const cmd = methodName === 'clean' ? 'git.clean' : 'git.revertChange';
                        log(`Falling back to executeCommand('${cmd}', match)`, 'git-discard');
                        await vscode.commands.executeCommand(cmd, match as any);
                        return true;
                    } catch (err: any) {
                        log(`Fallback command ${methodName} failed: ${err && err.message ? err.message : String(err)}`, 'git-discard');
                    }
                }

                return false;
            };

            if (isUntracked) {
                const ok = await callRepositoryMethodWithFallback('clean');
                if (ok) {
                    vscode.window.showInformationMessage(`Discarded untracked file ${fileName}`);
                } else {
                    vscode.window.showErrorMessage(`Failed to discard untracked file ${fileName}`);
                    return;
                }
            } else {
                const ok = await callRepositoryMethodWithFallback('revert');
                if (ok) {
                    vscode.window.showInformationMessage(`Discarded changes to ${fileName}`);
                } else {
                    vscode.window.showErrorMessage(`Failed to discard changes to ${fileName}`);
                    return;
                }
            }

            gitFileGroupsProvider.refresh();
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to discard changes: ${e}`);
        }
    });

let toggleExpandCollapseCommand = vscode.commands.registerCommand('git-file-groups.toggleExpandCollapse', async () => {
    log('Toggle command triggered!', 'view');
    try {
        await gitFileGroupsProvider.toggleExpandCollapse();
        log('Toggle command completed', 'view');
    } catch (error) {
        log(`Toggle command failed: ${error}`, 'view');
    }
});

let collapseAllGroupsCommand = vscode.commands.registerCommand('git-file-groups.collapseAllGroups', async () => {
    log('Collapse command triggered!', 'view');
    try {
        await gitFileGroupsProvider.collapseAllGroups();
        log('Collapse command completed', 'view');
    } catch (error) {
        log(`Collapse command failed: ${error}`, 'view');
    }
});
    context.subscriptions.push(disposable);
    context.subscriptions.push(createGroupCommand);
    context.subscriptions.push(renameGroupCommand);
    context.subscriptions.push(commitGroupCommand);
    context.subscriptions.push(deleteGroupCommand);
    context.subscriptions.push(openLinkCommand);
    context.subscriptions.push(commitWithMessageCommand);
    context.subscriptions.push(openDiffCommand);
    context.subscriptions.push(openFileCommand);
    context.subscriptions.push(toggleExpandCollapseCommand);
    context.subscriptions.push(collapseAllGroupsCommand);
}

export function deactivate() {
    log('Deactivating extension...', 'lifecycle');
}