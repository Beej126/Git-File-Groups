import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';
import { promptForCommitInput } from './commitQuickInput';
import { FileNode, GitFileGroupsProvider, GroupNode } from './GitFileGroupsProvider';
import { log } from './logging';

log('Loading extension.ts', 'lifecycle');

export function activate(context: vscode.ExtensionContext) {
    log('Activating extension...', 'lifecycle');
    let gitFileGroupsProvider: GitFileGroupsProvider | undefined;
    let workspaceInitializationTimer: ReturnType<typeof setTimeout> | undefined;

    registerCommands(() => gitFileGroupsProvider, context);

    // Helper to initialize extension when a workspace root is available.
    const initializeForWorkspace = (workspaceRoot: string) => {
        if (gitFileGroupsProvider) {
            return;
        }

        log(`Creating GitFileGroupsProvider with workspaceRoot: ${workspaceRoot}`, 'lifecycle');
        try {
            gitFileGroupsProvider = new GitFileGroupsProvider(workspaceRoot, context.globalState);
            const updateSyncHeader = (repository: any | undefined) => {
                const ahead = typeof repository?.state?.HEAD?.ahead === 'number' ? repository.state.HEAD.ahead : 0;
                const behind = typeof repository?.state?.HEAD?.behind === 'number' ? repository.state.HEAD.behind : 0;
                gitFileGroupsProvider?.setSyncStatus(ahead, behind);
            };
            const scheduleAssignmentSync = (reason: string) => {
                log(`${reason} - scheduling assignment sync`, 'git');
                gitFileGroupsProvider?.scheduleSyncAssignmentsWithGitStatus();
            };

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
                    if (!target || !gitFileGroupsProvider) {
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
            updateSyncHeader(undefined);

            // Initialize the context for the toggle button
            vscode.commands.executeCommand('setContext', 'gitFileGroups.isExpanded', true);

            context.subscriptions.push(treeView);
            context.subscriptions.push(gitFileGroupsProvider);

            const documentChangeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
                if (!gitFileGroupsProvider || event.contentChanges.length === 0) {
                    return;
                }

                const documentUri = event.document.uri;
                if (documentUri.scheme !== 'file') {
                    return;
                }

                const workspaceRootNormalized = path.normalize(gitFileGroupsProvider.getWorkspaceRoot()).toLowerCase();
                const documentPathNormalized = path.normalize(documentUri.fsPath).toLowerCase();
                if (!documentPathNormalized.startsWith(workspaceRootNormalized)) {
                    return;
                }

                void gitFileGroupsProvider.assignDefaultGroupToEditedFiles([documentUri], true).catch(error => {
                    log(`Default-group assignment after document edit failed: ${error}`, 'git');
                });
            });
            context.subscriptions.push(documentChangeDisposable);

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
                const provider = gitFileGroupsProvider;
                if (!provider) {
                    return;
                }

                log('Git repositories are ready - synchronizing assignments', 'lifecycle');
                await provider.syncAssignmentsWithGitStatus(true);

                // Subscribe to repository state changes so the view updates when files change
                try {
                    const gitExtension = vscode.extensions.getExtension('vscode.git');
                    if (gitExtension && gitExtension.isActive) {
                        const api = gitExtension.exports.getAPI(1);
                        const repo = api.repositories.find((r: any) => {
                            const repoPath = r.rootUri?.fsPath;
                            return repoPath && path.normalize(repoPath).toLowerCase() === path.normalize(provider.getWorkspaceRoot()).toLowerCase();
                        });

                        updateSyncHeader(repo);

                        if (repo && repo.state && typeof repo.state.onDidChange === 'function') {
                            const disposable = repo.state.onDidChange(() => {
                                updateSyncHeader(repo);
                                scheduleAssignmentSync('Repository state changed');
                            });
                            context.subscriptions.push(disposable);
                        }

                        // Listen for repositories being opened (in case the repo was added later)
                        if (typeof api.onDidOpenRepository === 'function') {
                            const d2 = api.onDidOpenRepository((r: any) => {
                                const repoPath = r.rootUri?.fsPath;
                                if (repoPath && path.normalize(repoPath).toLowerCase() === path.normalize(provider.getWorkspaceRoot()).toLowerCase()) {
                                    updateSyncHeader(r);
                                    scheduleAssignmentSync('Repository opened');
                                }
                            });
                            context.subscriptions.push(d2);
                        }
                    }
                } catch (e) {
                    log(`Failed to subscribe to Git events: ${e}`, 'git');
                }
            });
        } catch (error) {
            gitFileGroupsProvider = undefined;
            log(`Failed to initialize Git File Groups for workspace ${workspaceRoot}: ${error}`, 'lifecycle');
            void vscode.window.showErrorMessage('Git File Groups failed to initialize. Check the extension output for details.');
        }
    };

    const tryInitializeFromCurrentWorkspace = (): boolean => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        const workspaceRoot = folder?.uri.fsPath;
        if (!workspaceRoot) {
            return false;
        }

        if (workspaceInitializationTimer) {
            clearTimeout(workspaceInitializationTimer);
            workspaceInitializationTimer = undefined;
        }

        initializeForWorkspace(workspaceRoot);
        return true;
    };

    const scheduleWorkspaceInitializationRetry = (attempt: number = 0) => {
        if (gitFileGroupsProvider || workspaceInitializationTimer || attempt >= 20) {
            return;
        }

        workspaceInitializationTimer = setTimeout(() => {
            workspaceInitializationTimer = undefined;

            if (!tryInitializeFromCurrentWorkspace()) {
                scheduleWorkspaceInitializationRetry(attempt + 1);
            }
        }, 250);
    };

    // If a workspace is already open, initialize immediately. Otherwise listen for folders.
    if (tryInitializeFromCurrentWorkspace()) {
        return;
    }

    scheduleWorkspaceInitializationRetry();

    // No workspace open — listen for workspace folder additions and initialize then.
    const folderDisposable = vscode.workspace.onDidChangeWorkspaceFolders((e) => {
        if (gitFileGroupsProvider || !vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            return;
        }

        if (tryInitializeFromCurrentWorkspace()) {
            folderDisposable.dispose();
        }
    });
    context.subscriptions.push(folderDisposable);
    context.subscriptions.push(new vscode.Disposable(() => {
        if (workspaceInitializationTimer) {
            clearTimeout(workspaceInitializationTimer);
            workspaceInitializationTimer = undefined;
        }
    }));
}

function registerCommands(getProvider: () => GitFileGroupsProvider | undefined, context: vscode.ExtensionContext) {
    const runWithProvider = async <T>(action: (provider: GitFileGroupsProvider) => Promise<T> | T): Promise<T | undefined> => {
        const gitFileGroupsProvider = getProvider();
        if (!gitFileGroupsProvider) {
            log('Command invoked before provider initialization completed', 'lifecycle');
            void vscode.window.showWarningMessage('Git File Groups is still initializing. Try again in a moment.');
            return undefined;
        }

        return action(gitFileGroupsProvider);
    };

    let disposable = vscode.commands.registerCommand('git-file-groups.refreshGroup', () => {
        return runWithProvider((gitFileGroupsProvider) => {
            log('Refresh command triggered', 'view');
            gitFileGroupsProvider.refresh();
        });
    });

    let createGroupCommand = vscode.commands.registerCommand('git-file-groups.createGroup', async () => {
        return runWithProvider(async (gitFileGroupsProvider) => {
        const name = await vscode.window.showInputBox({
            prompt: 'Create a new group',
            placeHolder: 'Group name'
        });

        if (typeof name !== 'string') {
            return;
        }

        await gitFileGroupsProvider.addGroup(name);
        });
    });

    let renameGroupCommand = vscode.commands.registerCommand('git-file-groups.renameGroup', async (groupNode: GroupNode) => {
        return runWithProvider(async (gitFileGroupsProvider) => {
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
    });

    let commitGroupCommand = vscode.commands.registerCommand('git-file-groups.commitGroup', async (groupNode: GroupNode) => {
        return runWithProvider(async (gitFileGroupsProvider) => {
        log(`commitGroup command invoked. Arg present: ${!!groupNode}`, 'view');
        if (!groupNode || !groupNode.groupName) {
            log('commitGroup called with invalid or missing groupNode', 'view');
            return;
        }

        try {
            await gitFileGroupsProvider.commitGroup(groupNode.groupName);
        } catch (err) {
            log(`commitGroup handler failed: ${err}`, 'view');
        }
        });
    });

    let deleteGroupCommand = vscode.commands.registerCommand('git-file-groups.deleteGroup', async (groupNode: GroupNode) => {
        return runWithProvider(async (gitFileGroupsProvider) => {
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
    });

    let setDefaultGroupCommand = vscode.commands.registerCommand('git-file-groups.setDefaultGroup', async (groupNode: GroupNode) => {
        return runWithProvider(async (gitFileGroupsProvider) => {
        if (!groupNode || !groupNode.groupName) {
            return;
        }

        await gitFileGroupsProvider.setDefaultGroup(groupNode.groupName);
        });
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
        return runWithProvider(async (gitFileGroupsProvider) => {
        const commitInput = await promptForCommitInput({
            title: 'Commit Changes',
            placeHolder: 'Enter commit message...',
            syncToRemote: gitFileGroupsProvider.getautoSyncEnabled(),
            onSyncToRemoteChanged: async (enabled: boolean) => {
                await gitFileGroupsProvider.setautoSyncEnabled(enabled);
            }
        });

        if (!commitInput) {
            return;
        }

        const stagedUris = await gitFileGroupsProvider.stageAllChanges();

        try {
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            if (gitExtension && gitExtension.isActive) {
                const api = gitExtension.exports.getAPI(1);
                const repository = api.repositories.find((repo: any) => {
                    const repoPath = repo.rootUri?.fsPath;
                    return repoPath && path.normalize(gitFileGroupsProvider.getWorkspaceRoot()).toLowerCase() === path.normalize(repoPath).toLowerCase();
                });
                if (repository) {
                    await repository.commit(commitInput.message);
                    log(`Committed with message: ${commitInput.message}`, 'git');
                    await gitFileGroupsProvider.syncAssignmentsAfterGitOperation(stagedUris, true);

                    if (commitInput.syncToRemote) {
                        const synced = await gitFileGroupsProvider.syncRepositoryToRemote(repository);
                        if (!synced) {
                            vscode.window.showWarningMessage('Commit completed, but Git sync to the remote did not run successfully.');
                        }
                    }
                }
            }
        } catch (error) {
            log(`Direct commit failed: ${error}`, 'git');
        }
        });
    });

    let syncRepositoryCommand = vscode.commands.registerCommand('git-file-groups.syncRepository', async () => {
        return runWithProvider(async (gitFileGroupsProvider) => {
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
                vscode.window.showErrorMessage('Repository not found for workspace');
                return;
            }

            const synced = await gitFileGroupsProvider.syncRepositoryToRemote(repository);
            if (!synced) {
                vscode.window.showWarningMessage('Git sync to the remote did not run successfully.');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to sync repository: ${error}`);
        }
        });
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

    let renameFileCommand = vscode.commands.registerCommand('git-file-groups.renameFile', async (arg: vscode.Uri | vscode.TreeItem | undefined) => {
        return runWithProvider(async (gitFileGroupsProvider) => {
        const resourceUri = arg instanceof vscode.Uri ? arg : arg instanceof vscode.TreeItem ? arg.resourceUri : undefined;
        if (!resourceUri) return;

        const oldFs = resourceUri.fsPath;
        const oldName = path.basename(oldFs);
        const newName = await vscode.window.showInputBox({
            prompt: 'Rename file',
            value: oldName,
            placeHolder: 'New file name'
        });

        if (typeof newName !== 'string' || newName.trim().length === 0 || newName === oldName) {
            return;
        }

        const newFs = path.join(path.dirname(oldFs), newName);
        const newUri = vscode.Uri.file(newFs);

        try {
            await vscode.workspace.fs.rename(resourceUri, newUri, { overwrite: false });
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to rename file: ${err && err.message ? err.message : String(err)}`);
            return;
        }

        try {
            if (gitFileGroupsProvider && typeof gitFileGroupsProvider.fileRenamed === 'function') {
                await gitFileGroupsProvider.fileRenamed(resourceUri, newUri);
            }
        } catch (e) {
            // ignore provider update errors but refresh view
            try { gitFileGroupsProvider.refresh(); } catch { }
        }
        });
    });

    let discardChangeCommand = vscode.commands.registerCommand('git-file-groups.discardChange', async (arg: vscode.Uri | vscode.TreeItem | undefined) => {
        return runWithProvider(async (gitFileGroupsProvider) => {
        const resourceUri = arg instanceof vscode.Uri ? arg : arg instanceof vscode.TreeItem ? arg.resourceUri : undefined;
        if (!resourceUri) return;

        const fileName = resourceUri.fsPath.split(/[\/]/).pop() || resourceUri.fsPath;
        log(`[discardChange] command invoked for ${resourceUri.fsPath}`, 'git-discard');
        vscode.window.setStatusBarMessage(`Git File Groups: discard requested for ${fileName}`, 2500);
        const confirmed = await vscode.window.showWarningMessage(
            `Discard changes to ${fileName}? This cannot be undone.`,
            { modal: true },
            'Discard'
        );
        if (confirmed !== 'Discard') return;

        log(`[discardChange] confirmed for ${resourceUri.fsPath}`, 'git-discard');
        vscode.window.setStatusBarMessage(`Git File Groups: confirmed discard for ${fileName}`, 2500);

        try {
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            if (!gitExtension) {
                log('[discardChange] vscode.git extension not found', 'git-discard');
                vscode.window.showErrorMessage('Git extension not available');
                return;
            }
            log(`[discardChange] vscode.git extension found; active=${gitExtension.isActive}`, 'git-discard');
            if (!gitExtension.isActive) {
                log('[discardChange] activating vscode.git extension', 'git-discard');
                vscode.window.setStatusBarMessage('Git File Groups: activating Git extension...', 2500);
                await gitExtension.activate();
            }
            const api = gitExtension.exports.getAPI(1);
            log(`[discardChange] Git API repositories: ${api.repositories?.length ?? 0}`, 'git-discard');
            const repository = api.repositories.find((repo: any) => {
                const repoPath = repo.rootUri?.fsPath;
                return repoPath && path.normalize(repoPath).toLowerCase() === path.normalize(gitFileGroupsProvider.getWorkspaceRoot()).toLowerCase();
            });
            if (!repository) {
                log('[discardChange] repository not found for workspace root', 'git-discard');
                vscode.window.showErrorMessage('Repository not found for file');
                return;
            }

            log(`[discardChange] repository found at ${repository.rootUri?.fsPath}`, 'git-discard');
            vscode.window.setStatusBarMessage(`Git File Groups: running discard for ${fileName}`, 2500);

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
                log(`[discardChange] trying repository.${methodName} fallbacks`, 'git-discard');
                // Try the most-compatible shapes first: filesystem path string, then Uri, then a stringified Uri.
                const attempts: any[][] = [[resourceUri.fsPath], [resourceUri], [resourceUri.toString()]];
                if (match) {
                    attempts.unshift([match]);
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

                try {
                    const cmd = methodName === 'clean' ? 'git.clean' : 'git.revertChange';
                    log(`Falling back to executeCommand('${cmd}', resourceUri)`, 'git-discard');
                    await vscode.commands.executeCommand(cmd, resourceUri);
                    return true;
                } catch (err: any) {
                    log(`Fallback command ${methodName} with resourceUri failed: ${err && err.message ? err.message : String(err)}`, 'git-discard');
                }

                return false;
            };

            const runGitRestore = async () => {
                log('[discardChange] falling back to direct git restore', 'git-discard');
                const workspaceRoot = gitFileGroupsProvider.getWorkspaceRoot();
                const args = ['-C', workspaceRoot, 'restore', '--source=HEAD', '--staged', '--worktree', resourceUri.fsPath];
                return await new Promise<boolean>((resolve) => {
                    const child = spawn('git', args, { shell: false });
                    let stderr = '';

                    child.stderr.on('data', (chunk) => {
                        stderr += chunk.toString();
                    });

                    child.on('error', (err) => {
                        log(`git restore spawn failed: ${err instanceof Error ? err.message : String(err)}`, 'git-discard');
                        resolve(false);
                    });

                    child.on('close', (code) => {
                        if (code === 0) {
                            log(`git restore succeeded for ${resourceUri.fsPath}`, 'git-discard');
                            vscode.window.setStatusBarMessage(`Git File Groups: discard completed for ${fileName}`, 2500);
                            resolve(true);
                        } else {
                            log(`git restore failed for ${resourceUri.fsPath} (code ${code}): ${stderr.trim()}`, 'git-discard');
                            resolve(false);
                        }
                    });
                });
            };

            if (isUntracked) {
                log(`[discardChange] file appears untracked: ${resourceUri.fsPath}`, 'git-discard');
                const ok = await callRepositoryMethodWithFallback('clean');
                if (ok) {
                    vscode.window.showInformationMessage(`Discarded untracked file ${fileName}`);
                } else {
                    vscode.window.showErrorMessage(`Failed to discard untracked file ${fileName}`);
                    return;
                }
            } else {
                log(`[discardChange] file appears tracked/modified: ${resourceUri.fsPath}`, 'git-discard');
                const ok = await runGitRestore() || await callRepositoryMethodWithFallback('revert');
                if (ok) {
                    vscode.window.showInformationMessage(`Discarded changes to ${fileName}`);
                } else {
                    vscode.window.showErrorMessage(`Failed to discard changes to ${fileName}`);
                    return;
                }
            }

            await gitFileGroupsProvider.syncAssignmentsAfterGitOperation([resourceUri], true);
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to discard changes: ${e}`);
        }
        });
    });

    let toggleExpandCollapseCommand = vscode.commands.registerCommand('git-file-groups.toggleExpandCollapse', async () => {
        return runWithProvider(async (gitFileGroupsProvider) => {
            log('Toggle command triggered!', 'view');
            try {
                await gitFileGroupsProvider.toggleExpandCollapse();
                log('Toggle command completed', 'view');
            } catch (error) {
                log(`Toggle command failed: ${error}`, 'view');
            }
        });
    });

    let collapseAllGroupsCommand = vscode.commands.registerCommand('git-file-groups.collapseAllGroups', async () => {
        return runWithProvider(async (gitFileGroupsProvider) => {
            log('Collapse command triggered!', 'view');
            try {
                await gitFileGroupsProvider.collapseAllGroups();
                log('Collapse command completed', 'view');
            } catch (error) {
                log(`Collapse command failed: ${error}`, 'view');
            }
        });
    });
    
    let copyRelativePathCommand = vscode.commands.registerCommand('git-file-groups.copyRelativePath', async (arg: vscode.Uri | vscode.TreeItem | undefined) => {
        const resourceUri = arg instanceof vscode.Uri ? arg : arg instanceof vscode.TreeItem ? (arg as any).resourceUri : undefined;
        if (!resourceUri) {
            vscode.window.showErrorMessage('No file selected to copy relative path.');
            return;
        }

        const relativePath = vscode.workspace.asRelativePath(resourceUri);
        try {
            await vscode.env.clipboard.writeText(relativePath);
            vscode.window.showInformationMessage(`Copied relative path: ${relativePath}`);
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to copy relative path: ${e}`);
        }
    });

    let revealInExplorerCommand = vscode.commands.registerCommand('git-file-groups.revealInExplorer', async (arg: vscode.Uri | vscode.TreeItem | undefined) => {
        const resourceUri = arg instanceof vscode.Uri ? arg : arg instanceof vscode.TreeItem ? (arg as any).resourceUri : undefined;
        if (!resourceUri) {
            vscode.window.showErrorMessage('No file selected to reveal.');
            return;
        }

        // Prefer revealing in VS Code's Explorer view
        try {
            await vscode.commands.executeCommand('revealInExplorer', resourceUri);
            return;
        } catch {}

        // Fallback: open the file and show active file in Explorer
        try {
            await vscode.window.showTextDocument(resourceUri, { preview: true, viewColumn: vscode.ViewColumn.One });
            await vscode.commands.executeCommand('workbench.files.action.showActiveFileInExplorer');
            return;
        } catch {}

        // Last-resort: reveal in the OS file manager
        try {
            await vscode.commands.executeCommand('revealFileInOS', resourceUri);
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to reveal file in Explorer: ${e}`);
        }
    });
    context.subscriptions.push(disposable);
    context.subscriptions.push(createGroupCommand);
    context.subscriptions.push(renameGroupCommand);
    context.subscriptions.push(renameFileCommand);
    context.subscriptions.push(commitGroupCommand);
    context.subscriptions.push(deleteGroupCommand);
    context.subscriptions.push(setDefaultGroupCommand);
    context.subscriptions.push(openLinkCommand);
    context.subscriptions.push(commitWithMessageCommand);
    context.subscriptions.push(syncRepositoryCommand);
    context.subscriptions.push(openDiffCommand);
    context.subscriptions.push(openFileCommand);
    context.subscriptions.push(toggleExpandCollapseCommand);
    context.subscriptions.push(collapseAllGroupsCommand);
    context.subscriptions.push(copyRelativePathCommand);
    context.subscriptions.push(revealInExplorerCommand);
}

export function deactivate() {
    log('Deactivating extension...', 'lifecycle');
}