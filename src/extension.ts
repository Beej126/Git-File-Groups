import * as vscode from 'vscode';
import * as path from 'path';

console.log('[git-file-groups] Loading extension.ts');
import { FileNode, GitFileGroupsProvider, GroupNode } from './GitFileGroupsProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('[git-file-groups] Activating extension...');
    
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showWarningMessage('No workspace folders are open.');
        return;
    }

    // Assuming we want to handle the first workspace folder for now
    const currentWorkspaceFolder = workspaceFolders[0];
    const workspaceRoot = currentWorkspaceFolder.uri.fsPath;

    if (!workspaceRoot) {
        vscode.window.showWarningMessage('Workspace root is not set.');
        return;
    }

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
            if (!target || !(target instanceof GroupNode)) {
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
            await gitFileGroupsProvider.moveFilesToGroup(uris, target.groupName);
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

    waitForGitRepositories().then(() => {
        console.log('[git-file-groups] Refreshing after Git repositories are ready');
        gitFileGroupsProvider.refresh();
    });

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

    let commitWithMessageCommand = vscode.commands.registerCommand('git-file-groups.commitWithMessage', async () => {
        // Show input box for commit message
        const message = await vscode.window.showInputBox({
            prompt: 'Commit message',
            placeHolder: 'Enter commit message...'
        });

        if (!message) {
            return; // User cancelled
        }

        // Stage all current changes (like native Source Control)
        await gitFileGroupsProvider.stageAllChanges();

        // Commit with the provided message using -m flag to avoid editor
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
context.subscriptions.push(commitWithMessageCommand);
context.subscriptions.push(openDiffCommand);
context.subscriptions.push(openFileCommand);
context.subscriptions.push(toggleExpandCollapseCommand);
context.subscriptions.push(collapseAllGroupsCommand);
}

export function deactivate() {
    console.log('[git-file-groups] Deactivating extension...');
}