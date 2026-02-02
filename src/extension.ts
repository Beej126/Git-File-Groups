import * as vscode from 'vscode';
import * as path from 'path';

console.log('[git-file-groups] Loading extension.ts');
import { FileNode, GitFileGroupsProvider, GroupNode } from './GitFileGroupsProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('[git-file-groups] Activating extension...');

    // Helper to initialize extension when a workspace root is available.
    const initializeForWorkspace = (workspaceRoot: string) => {
        console.log('[git-file-groups] Creating GitFileGroupsProvider with workspaceRoot:', workspaceRoot);
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

        console.log('[git-file-groups] Registering Tree Data Provider');
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
            console.log('[git-file-groups] Git extension not available');
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
                        console.log('[git-file-groups] Git repositories ready via onDidChangeState');
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
                console.log('[git-file-groups] Git repositories ready via polling');
                return;
            }
            await new Promise(r => setTimeout(r, 200));
        }
        console.log('[git-file-groups] Git repositories still not ready after polling');
        };

        waitForGitRepositories().then(async () => {
            console.log('[git-file-groups] Refreshing after Git repositories are ready');
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
                            console.log('[git-file-groups] Repository state changed - refreshing');
                            gitFileGroupsProvider.refresh();
                        });
                        context.subscriptions.push(disposable);
                    }

                    // Listen for repositories being opened (in case the repo was added later)
                    if (typeof api.onDidOpenRepository === 'function') {
                        const d2 = api.onDidOpenRepository((r: any) => {
                            const repoPath = r.rootUri?.fsPath;
                            if (repoPath && path.normalize(repoPath).toLowerCase() === path.normalize(gitFileGroupsProvider.getWorkspaceRoot()).toLowerCase()) {
                                console.log('[git-file-groups] Repository opened - refreshing');
                                gitFileGroupsProvider.refresh();
                            }
                        });
                        context.subscriptions.push(d2);
                    }
                }
            } catch (e) {
                console.log('[git-file-groups] Failed to subscribe to Git events', e);
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
            console.log('[git-file-groups] Refresh command triggered');
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
            console.log('[git-file-groups] openLink failed:', e);
            try {
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(url));
            } catch (e2) {
                console.log('[git-file-groups] fallback open failed:', e2);
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
                    console.log('[git-file-groups] Committed with message:', message);
                    // Refresh view after commit so active changes and groups update
                    gitFileGroupsProvider.refresh();
                }
            }
        } catch (error) {
            console.log('[git-file-groups] Direct commit failed:', error);
        }
    });

    let openDiffCommand = vscode.commands.registerCommand('git-file-groups.openDiff', async (arg: vscode.Uri | vscode.TreeItem | undefined) => {
        const resourceUri = arg instanceof vscode.Uri ? arg : arg?.resourceUri;
        console.log('[git-file-groups] Open diff command triggered! Arg:', arg, 'ResourceUri:', resourceUri);

        if (!resourceUri) {
            console.log('[git-file-groups] No resourceUri provided for diff');
            return;
        }

        try {
            await vscode.commands.executeCommand('git.openChange', resourceUri);
            console.log('[git-file-groups] git.openChange succeeded');
        } catch (error) {
            console.log('[git-file-groups] git.openChange failed, falling back to open file:', error);
            try {
                await vscode.window.showTextDocument(resourceUri, {
                    preview: true,
                    viewColumn: vscode.ViewColumn.One
                });
                console.log('[git-file-groups] showTextDocument fallback succeeded');
            } catch (fallbackError) {
                console.log('[git-file-groups] showTextDocument fallback failed:', fallbackError);
            }
        }
    });

    let openFileCommand = vscode.commands.registerCommand('git-file-groups.openFile', async (arg: vscode.Uri | vscode.TreeItem | undefined) => {
        const resourceUri = arg instanceof vscode.Uri ? arg : arg?.resourceUri;
        console.log('[git-file-groups] Open file command triggered! Arg:', arg, 'ResourceUri:', resourceUri);

        if (!resourceUri) {
            console.log('[git-file-groups] No resourceUri provided');
            return;
        }

        console.log('[git-file-groups] Opening file:', resourceUri.fsPath);
        
        try {
            await vscode.window.showTextDocument(resourceUri, {
                preview: false,
                viewColumn: vscode.ViewColumn.One
            });
            console.log('[git-file-groups] showTextDocument succeeded');
        } catch (error) {
            console.log('[git-file-groups] showTextDocument failed, falling back to vscode.open:', error);
            try {
                await vscode.commands.executeCommand('vscode.open', resourceUri, {
                    preview: false,
                    viewColumn: vscode.ViewColumn.One
                });
                console.log('[git-file-groups] vscode.open succeeded');
            } catch (fallbackError) {
        }
    }
});

    let discardChangeCommand = vscode.commands.registerCommand('git-file-groups.discardChange', async (arg: vscode.Uri | vscode.TreeItem | undefined) => {
        const resourceUri = arg instanceof vscode.Uri ? arg : arg instanceof vscode.TreeItem ? arg.resourceUri : undefined;
        if (!resourceUri) {
            return;
        }

        const fileName = resourceUri.fsPath.split(/[\\/]/).pop() || resourceUri.fsPath;
        const confirmed = await vscode.window.showWarningMessage(
            `Discard changes to ${fileName}? This cannot be undone.`,
            { modal: true },
            'Discard'
        );

        if (confirmed !== 'Discard') {
            return;
        }

        try {
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            if (!gitExtension) {
                vscode.window.showErrorMessage('Git extension not available');
                return;
            }
            if (!gitExtension.isActive) {
                await gitExtension.activate();
            }
            const api = gitExtension.exports.getAPI(1);
            const repository = api.repositories.find((repo: any) => {
                const repoPath = repo.rootUri?.fsPath;
                return repoPath && path.normalize(gitFileGroupsProvider.getWorkspaceRoot()).toLowerCase() === path.normalize(repoPath).toLowerCase();
            });
            if (!repository) {
                vscode.window.showErrorMessage('Repository not found for file');
                return;
            }

            // Use repository.revert to discard the change (matches existing usage for unstaging)
            await repository.revert([resourceUri.fsPath]);
            vscode.window.showInformationMessage(`Discarded changes to ${fileName}`);
            gitFileGroupsProvider.refresh();
        } catch (e) {
            console.log('[git-file-groups] Discard change failed:', e);
            vscode.window.showErrorMessage(`Failed to discard changes: ${e}`);
        }
    });

let toggleExpandCollapseCommand = vscode.commands.registerCommand('git-file-groups.toggleExpandCollapse', async () => {
    console.log('[git-file-groups] Toggle command triggered!');
    try {
        await gitFileGroupsProvider.toggleExpandCollapse();
        console.log('[git-file-groups] Toggle command completed');
    } catch (error) {
        console.error('[git-file-groups] Toggle command failed:', error);
    }
});

let collapseAllGroupsCommand = vscode.commands.registerCommand('git-file-groups.collapseAllGroups', async () => {
    console.log('[git-file-groups] Collapse command triggered!');
    try {
        await gitFileGroupsProvider.collapseAllGroups();
        console.log('[git-file-groups] Collapse command completed');
    } catch (error) {
        console.error('[git-file-groups] Collapse command failed:', error);
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
    console.log('[git-file-groups] Deactivating extension...');
}