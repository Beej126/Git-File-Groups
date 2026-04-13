import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';
import { ProjectStorage, GitFileGroupsData } from './ProjectStorage';
import { promptForCommitInput } from './commitQuickInput';
import { log, setLoggedFeatures } from './logging';

interface GitAPI {
  getAPI(version: number): any;
}

export class GitFileGroupsProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  public static readonly UNGROUPED = 'default';
  public static readonly AUTO_SYNC_TO_REMOTE_SETTING = 'autoSyncToRemoteAfterCommit';
  private onDidChangeTreeDataEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private groups: string[] = [];
  private assignments: Record<string, string> = {};
  private cachedRepositoryRoot: string | undefined;
  private storage: ProjectStorage;
  private treeView: vscode.TreeView<vscode.TreeItem> | undefined;
  private debugLoggingEnabled: boolean = false;
  private loggedFeatures: Set<string> = new Set();
  private syncAssignmentsTimer: ReturnType<typeof setTimeout> | undefined;
  private syncStatusDescription: string | undefined;
  private autoSyncToRemoteEnabled: boolean = true;
  private hasAutoSyncToRemoteSetting: boolean = false;

  private async executeFirstAvailableCommand(commandIds: string[]): Promise<boolean> {
    for (const commandId of commandIds) {
      try {
        await vscode.commands.executeCommand(commandId);
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // If the command is not found, try next. Otherwise log and try next.
        log(`${commandId} failed: ${message}`, 'view');
      }
    }
    return false;
  }

  private async expandRootsByReveal(): Promise<void> {
    if (!this.treeView) {
      return;
    }

    const rootItems = await this.getChildren(undefined);
    for (const item of rootItems) {
      if (item instanceof GroupNode) {
        try {
          await this.treeView.reveal(item, { select: false, focus: false, expand: true });
        } catch (e) {
          log(`Failed to expand root ${item.label}: ${e instanceof Error ? e.message : String(e)}`, 'view');
        }
      }
    }
  }

  private async tryExpandAllByDiscovery(): Promise<boolean> {
    try {
      const all = await vscode.commands.getCommands(true);
      const candidates = all
        .filter(c => c.toLowerCase().includes('expand') && c.toLowerCase().includes('all'))
        .sort((a, b) => a.localeCompare(b));

      // Log a small hint for debugging.
      log(`expandAll discovery candidates: ${candidates.slice(0, 10).join(', ')}`, 'view');

      for (const cmd of candidates) {
        try {
          await vscode.commands.executeCommand(cmd);
          log(`expandAll succeeded via ${cmd}`, 'view');
          return true;
        } catch {
          // keep trying
        }
      }
    } catch (e) {
      log(`expandAll discovery failed: ${e instanceof Error ? e.message : String(e)}`, 'view');
    }

    return false;
  }

  constructor(private workspaceRoot: string, private state: vscode.Memento) {
      log(`GitFileGroupsProvider constructor called with workspaceRoot: ${this.workspaceRoot}`, 'lifecycle');
    log(`Constructor timestamp: ${new Date().toISOString()}`, 'lifecycle');
    
    this.storage = new ProjectStorage(workspaceRoot);
    this.initializeStorage().then(() => {
      this.refresh();
    });
  }

  /**
   * Expose raw project config for extension-level decisions.
   */
  async getRawConfig(): Promise<any> {
    try {
      return await this.storage.loadConfig();
    } catch (e) {
      log(`Failed to load raw config: ${e}`, 'config');
      return {};
    }
  }

  private async initializeStorage(): Promise<void> {
    // Try to migrate from global state first
    const migrated = await this.storage.migrateFromGlobalState(this.state);
    if (migrated) {
      log('Successfully migrated data from global state to project file', 'lifecycle');
    }
    
    // Load data from project file
    await this.loadData();
    await this.syncAssignmentsWithGitStatus();
  }

  private async loadData(): Promise<void> {
    const data = await this.storage.loadData();
    this.groups = data.groups || [];
    this.assignments = data.assignments || {};

    // Load raw config to pick up logged features
    try {
      const cfg = await this.storage.loadConfig();
      const features: string[] | undefined = Array.isArray(cfg.logged_features) ? cfg.logged_features : undefined;
      this.loggedFeatures = new Set((features || []).filter(f => typeof f === 'string' && f.trim().length > 0).map(f => f.trim()));
      setLoggedFeatures(features);
      this.hasAutoSyncToRemoteSetting = typeof cfg[GitFileGroupsProvider.AUTO_SYNC_TO_REMOTE_SETTING] === 'boolean';
      if (this.hasAutoSyncToRemoteSetting) {
        this.autoSyncToRemoteEnabled = cfg[GitFileGroupsProvider.AUTO_SYNC_TO_REMOTE_SETTING];
      }
    } catch (e) {
      // ignore and keep defaults
    }
  }

  getAutoSyncToRemoteEnabled(): boolean {
    return this.autoSyncToRemoteEnabled;
  }

  async setAutoSyncToRemoteEnabled(enabled: boolean): Promise<void> {
    if (this.autoSyncToRemoteEnabled === enabled && this.hasAutoSyncToRemoteSetting) {
      return;
    }

    this.autoSyncToRemoteEnabled = enabled;
    await this.storage.saveConfigValue([GitFileGroupsProvider.AUTO_SYNC_TO_REMOTE_SETTING], enabled);
    this.hasAutoSyncToRemoteSetting = true;
  }

  private async saveData(): Promise<void> {
    await this.storage.saveData({
      groups: this.groups,
      assignments: this.assignments
    });

    if (!this.hasAutoSyncToRemoteSetting) {
      await this.storage.saveConfigValue([GitFileGroupsProvider.AUTO_SYNC_TO_REMOTE_SETTING], this.autoSyncToRemoteEnabled);
      this.hasAutoSyncToRemoteSetting = true;
    }
  }

  async syncAssignmentsAfterGitOperation(targetUris: vscode.Uri[], refreshTree: boolean = false): Promise<boolean> {
    const targetKeys = new Set(
      targetUris
        .map(uri => this.toAssignmentKey(uri))
        .filter((key): key is string => typeof key === 'string' && key.length > 0)
    );

    if (targetKeys.size === 0) {
      return this.syncAssignmentsWithGitStatus(refreshTree);
    }

    let lastResult = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      lastResult = await this.syncAssignmentsWithGitStatus(false);

      const snapshot = await this.loadGitSnapshot();
      if (!snapshot.repositoryAvailable) {
        break;
      }

      const activeKeys = new Set(
        snapshot.entries
          .map(entry => this.toAssignmentKey(entry.resourceUri))
          .filter((key): key is string => typeof key === 'string' && key.length > 0)
      );

      const hasPendingTarget = Array.from(targetKeys).some(key => activeKeys.has(key));
      if (!hasPendingTarget) {
        if (refreshTree) {
          this.refresh();
        }
        return lastResult;
      }

      await this.delay(250);
    }

    if (refreshTree) {
      this.refresh();
    }

    return lastResult;
  }

  async syncAssignmentsWithGitStatus(refreshTree: boolean = false): Promise<boolean> {
    const snapshot = await this.loadGitSnapshot();
    if (!snapshot.repositoryAvailable) {
      log('Skipping assignment sync because repository is not available yet', 'git');
      if (refreshTree) {
        this.refresh();
      }
      return false;
    }

    const activeAssignmentKeys = new Set(
      snapshot.entries
        .map(entry => this.toAssignmentKey(entry.resourceUri))
        .filter((key): key is string => typeof key === 'string' && key.length > 0)
    );

    let removedAssignments = 0;
    for (const key of Object.keys(this.assignments)) {
      if (!activeAssignmentKeys.has(key)) {
        delete this.assignments[key];
        removedAssignments += 1;
      }
    }

    if (removedAssignments > 0) {
      log(`Pruned ${removedAssignments} assignment(s) that no longer have git changes`, 'git');
      await this.saveData();
    }

    if (refreshTree) {
      this.refresh();
    }

    return removedAssignments > 0;
  }

  scheduleSyncAssignmentsWithGitStatus(delayMs: number = 150): void {
    if (this.syncAssignmentsTimer) {
      clearTimeout(this.syncAssignmentsTimer);
    }

    this.syncAssignmentsTimer = setTimeout(() => {
      this.syncAssignmentsTimer = undefined;
      this.syncAssignmentsWithGitStatus(true).catch(error => {
        log(`Scheduled assignment sync failed: ${error}`, 'git');
      });
    }, delayMs);
  }

  private async delay(durationMs: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, durationMs));
  }

  async syncRepositoryToRemote(repository: any): Promise<boolean> {
    if (!repository) {
      return false;
    }

    const attempts: Array<() => Promise<void>> = [];

    if (typeof repository.sync === 'function') {
      attempts.push(async () => {
        await repository.sync();
      });
    }

    if (typeof repository.push === 'function') {
      attempts.push(async () => {
        await repository.push();
      });
    }

    const commandArgs = [repository, repository.rootUri, repository.sourceControl, undefined];
    for (const commandId of ['git.sync', 'git.push']) {
      for (const arg of commandArgs) {
        attempts.push(async () => {
          if (arg === undefined) {
            await vscode.commands.executeCommand(commandId);
            return;
          }

          await vscode.commands.executeCommand(commandId, arg);
        });
      }
    }

    for (const attempt of attempts) {
      try {
        await attempt();
        return true;
      } catch (error) {
        log(`Post-commit git sync attempt failed: ${error}`, 'git');
      }
    }

    return false;
  }

  /**
   * Update internal assignments when a file has been renamed on disk.
   */
  async fileRenamed(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    try {
      const oldKey = this.toAssignmentKey(oldUri);
      const newKey = this.toAssignmentKey(newUri);
      if (!oldKey || !newKey) {
        this.refresh();
        return;
      }

      const assigned = this.assignments[oldKey];
      if (assigned) {
        this.assignments[newKey] = assigned;
        delete this.assignments[oldKey];
        await this.saveData();
      }

      this.refresh();
    } catch (e) {
      log(`fileRenamed failed: ${e}`, 'view');
      this.refresh();
    }
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  setTreeView(treeView: vscode.TreeView<vscode.TreeItem>): void {
    this.treeView = treeView;
    this.treeView.description = this.syncStatusDescription;
  }

  setSyncStatus(ahead: number, behind: number): void {
    this.syncStatusDescription = `Sync: ${ahead}↑ ${behind}↓`;
    if (this.treeView) {
      this.treeView.description = this.syncStatusDescription;
    }
  }

  dispose(): void {
    // Clean up resources
    if (this.syncAssignmentsTimer) {
      clearTimeout(this.syncAssignmentsTimer);
      this.syncAssignmentsTimer = undefined;
    }
    this.onDidChangeTreeDataEmitter.dispose();
  }

  async toggleExpandCollapse(): Promise<void> {
    log('toggleExpandCollapse called', 'view');

    if (!this.treeView) {
      log('No treeView available', 'view');
      return;
    }

    // Ensure our tree view is focused, otherwise collapseAll/expandAll may target a different view.
    // We focus by revealing the first root item.
    const rootItems = await this.getChildren(undefined);
    const first = rootItems[0];
    if (first) {
      try {
        await this.treeView.reveal(first, { focus: true, select: false, expand: false });
      } catch (e) {
        log(`Failed to focus tree view via reveal: ${e}`, 'view');
      }
    }

    const expanded = await this.executeFirstAvailableCommand([
      // VS Code list/tree widgets
      'list.expandAll',
      // Some builds may expose treeview-specific IDs
      'workbench.actions.treeView.expandAll'
    ]);

    // Windsurf seems to have collapseAll but not expandAll; do a safe fallback that only affects
    // our tree view by expanding each root node.
    if (!expanded) {
      await this.expandRootsByReveal();
    }

    // After expanding, show the Collapse button.
    await vscode.commands.executeCommand('setContext', 'gitFileGroups.isExpanded', true);
    log('toggleExpandCollapse completed', 'view');
  }

  async collapseAllGroups(): Promise<void> {
    log('collapseAllGroups called', 'view');

    if (!this.treeView) {
      log('No treeView available', 'view');
      return;
    }

    // Ensure our tree view is focused, otherwise collapseAll/expandAll may target a different view.
    const rootItems = await this.getChildren(undefined);
    const first = rootItems[0];
    if (first) {
      try {
        await this.treeView.reveal(first, { focus: true, select: false, expand: false });
      } catch (e) {
        log(`Failed to focus tree view via reveal: ${e}`, 'view');
      }
    }

    await this.executeFirstAvailableCommand([
      // VS Code list/tree widgets
      'list.collapseAll',
      // Some builds may expose treeview-specific IDs
      'workbench.actions.treeView.collapseAll'
    ]);

    // After collapsing, show the Expand button.
    await vscode.commands.executeCommand('setContext', 'gitFileGroups.isExpanded', false);
    log('collapseAllGroups completed', 'view');
  }

  refresh(): void {
    log('Refresh method called', 'view');
    log('Firing tree data change event', 'view');
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  async addGroup(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }

    if (this.groups.includes(trimmed)) {
      return;
    }

    this.groups = [...this.groups, trimmed].sort((a, b) => a.localeCompare(b));
    await this.saveData();
    this.refresh();
  }

  async renameGroup(oldName: string, newName: string): Promise<void> {
    const trimmedOld = oldName.trim();
    const trimmedNew = newName.trim();
    if (!trimmedOld || !trimmedNew || trimmedOld === GitFileGroupsProvider.UNGROUPED) {
      return;
    }

    const index = this.groups.indexOf(trimmedOld);
    if (index === -1) {
      return;
    }

    // Update groups list
    this.groups[index] = trimmedNew;
    this.groups = [...this.groups].sort((a, b) => a.localeCompare(b));

    // Migrate assignments from old name to new name
    for (const [key, value] of Object.entries(this.assignments)) {
      if (value === trimmedOld) {
        this.assignments[key] = trimmedNew;
      }
    }
    await this.saveData();
    this.refresh();
  }

  async deleteGroup(groupName: string): Promise<void> {
    const trimmed = groupName.trim();
    if (!trimmed) {
      return;
    }

    const index = this.groups.indexOf(trimmed);
    if (index === -1) {
      return;
    }

    // Remove the group
    this.groups.splice(index, 1);

    // Move any assignments back to ungrouped by deleting the assignment entries
    for (const [key, value] of Object.entries(this.assignments)) {
      if (value === trimmed) {
        delete this.assignments[key];
      }
    }

    await this.saveData();
    this.refresh();
  }

  async commitGroup(groupName: string): Promise<void> {
    const trimmed = groupName.trim();

    const gitExtension = vscode.extensions.getExtension<GitAPI>('vscode.git');
    if (!gitExtension) {
      log('Git extension not available for commitGroup', 'git');
      return;
    }
    if (!gitExtension.isActive) {
      await gitExtension.activate();
    }
    const api = gitExtension.exports.getAPI(1);

    const repository = api.repositories.find((repo: any) => {
      const repoPath = repo.rootUri?.fsPath;
      return repoPath && path.normalize(this.workspaceRoot).toLowerCase() === path.normalize(repoPath).toLowerCase();
    });
    if (!repository) {
      log('No repository found for commitGroup', 'git');
      return;
    }

    log(`[commitGroup] Repository object keys: ${Object.keys(repository).join(', ')}`, 'git');
    log(`[commitGroup] Repository.index: ${repository.index}`, 'git');

    const groupFiles = await this.getGroupedFiles();
    const entriesForGroup = trimmed === GitFileGroupsProvider.UNGROUPED
      ? groupFiles.ungrouped
      : (groupFiles.grouped[trimmed] || []);
    const targetUris = new Set(entriesForGroup.map(f => f.resourceUri));

    log(`[commitGroup] Group: ${trimmed}`, 'git');
    log(`[commitGroup] Target files to stage: ${targetUris.size}`, 'git');
    if (targetUris.size === 0) {
      log(`[commitGroup] No files found in group '${trimmed}', aborting commit.`, 'git');
      vscode.window.showInformationMessage(`No files to commit in group '${trimmed}'.`);
      return;
    }

    for (const uri of targetUris) {
      log(`[commitGroup] Target URI: ${uri}`, 'git');
    }

    const stagedChanges = Array.isArray(repository?.state?.indexChanges) ? repository.state.indexChanges : [];
    for (const change of stagedChanges) {
      const changeUri = change.resourceUri ?? change.uri;
      if (!changeUri) {
        continue;
      }

      log(`[commitGroup] Unstaging staged change: ${changeUri}`, 'git');
      try {
        await repository.revert([changeUri.fsPath ?? changeUri]);
        log(`Unstaged staged change: ${changeUri.fsPath ?? String(changeUri)}`, 'git');
      } catch (e1) {
        log(`Unstage with primary resource failed: ${e1}`, 'git');
        try {
          await repository.revert([changeUri]);
          log(`Unstaged staged change via Uri: ${changeUri.fsPath ?? String(changeUri)}`, 'git');
        } catch (e2) {
          log(`Failed to unstage ${changeUri.fsPath ?? String(changeUri)}: ${e2}`, 'git');
        }
      }
    }

    const filePathsToStage = Array.from(targetUris).map(uri => uri.fsPath);
    log(`[commitGroup] Staging files: ${filePathsToStage.join(', ')}`, 'git');
    try {
      await repository.add(filePathsToStage);
    } catch (e) {
      log(`Failed to stage files: ${e}`, 'git');
    }

    const commitInput = await promptForCommitInput({
      title: `Commit Group: ${trimmed}`,
      placeHolder: 'Enter commit message...',
      value: trimmed,
      syncToRemote: this.getAutoSyncToRemoteEnabled(),
      onSyncToRemoteChanged: async (enabled: boolean) => {
        await this.setAutoSyncToRemoteEnabled(enabled);
      }
    });

    if (!commitInput) {
      log(`[commitGroup] User cancelled, restoring staged changes`, 'git');
      for (const change of stagedChanges) {
        const changeUri = change.resourceUri ?? change.uri;
        if (!changeUri) {
          continue;
        }

        try {
          await repository.revert([changeUri.fsPath ?? changeUri]);
        } catch (e) {
          log(`Failed to unstage ${changeUri.fsPath ?? String(changeUri)}: ${e}`, 'git');
        }
      }
      return;
    }

    try {
      await repository.commit(commitInput.message);
      log(`[commitGroup] Committed with message: ${commitInput.message}`, 'git');
      await this.syncAssignmentsAfterGitOperation(Array.from(targetUris), true);

      if (commitInput.syncToRemote) {
        const synced = await this.syncRepositoryToRemote(repository);
        if (!synced) {
          vscode.window.showWarningMessage('Commit completed, but Git sync to the remote did not run successfully.');
        }
      }
    } catch (error) {
      log(`[commitGroup] Direct commit failed: ${error}`, 'git');
    }
  }

  async stageAllChanges(): Promise<vscode.Uri[]> {
    const gitExtension = vscode.extensions.getExtension<GitAPI>('vscode.git');
    if (!gitExtension) {
      log('Git extension not available for stageAllChanges', 'git');
      return [];
    }
    if (!gitExtension.isActive) {
      await gitExtension.activate();
    }
    const api = gitExtension.exports.getAPI(1);

    // Find repository
    const repository = api.repositories.find((repo: any) => {
      const repoPath = repo.rootUri?.fsPath;
      return repoPath && path.normalize(this.workspaceRoot).toLowerCase() === path.normalize(repoPath).toLowerCase();
    });
    if (!repository) {
      log('No repository found for stageAllChanges', 'git');
      return [];
    }

    // Get all current changes and stage them
    const allChanges = await this.loadGitFileEntries();
    const filePathsToStage = allChanges.map(change => change.resourceUri.fsPath);
    log(`[stageAllChanges] Staging all changes: ${filePathsToStage.join(', ')}`, 'git');
    try {
      await repository.add(filePathsToStage);
    } catch (e) {
      log(`Failed to stage all changes: ${e}`, 'git');
    }

    return allChanges.map(change => change.resourceUri);
  }

  async moveFilesToGroup(uris: vscode.Uri[], groupName: string): Promise<void> {
    const target = groupName.trim();
    if (!target) {
      return;
    }

    const isUngrouped = target === GitFileGroupsProvider.UNGROUPED;
    const isKnownGroup = isUngrouped || this.groups.includes(target);
    if (!isKnownGroup) {
      return;
    }

    for (const uri of uris) {
      const key = this.toAssignmentKey(uri);
      if (!key) {
        continue;
      }

      if (isUngrouped) {
        delete this.assignments[key];
      } else {
        this.assignments[key] = target;
      }
    }

    await this.saveData();
    this.refresh();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getParent(element: vscode.TreeItem): vscode.TreeItem | undefined {
    // For GroupNodes, return undefined (they are root level)
    // For FileNodes, return the GroupNode they belong to
    if (element instanceof FileNode) {
      for (const groupName of [GitFileGroupsProvider.UNGROUPED, ...this.groups]) {
        if (!element.resourceUri) {
          continue;
        }

        const key = this.toAssignmentKey(element.resourceUri);
        const assigned = key ? this.assignments[key] : undefined;

        if (groupName === GitFileGroupsProvider.UNGROUPED && !assigned) {
          return new GroupNode(groupName);
        }

        if (assigned === groupName) {
          return new GroupNode(groupName);
        }
      }
    }

    return undefined;
  }

  async getChildren(element?: vscode.TreeItem | undefined): Promise<vscode.TreeItem[]> {
    log(`getChildren called with element: ${element ? element.label : 'undefined'}`, 'view');
    log(`getChildren timestamp: ${new Date().toISOString()}`, 'view');

    if (element instanceof PendingCommitsNode) {
      const commits = await this.loadUnpushedCommits();
      return commits.map(commit => new PendingCommitItem(commit));
    }

    if (element instanceof GroupNode) {
      log(`Returning children for GroupNode: ${element.groupName}`, 'view');
      const files = await this.getGroupedFiles();
      const groupName = element.groupName;
      const fileEntries = groupName === GitFileGroupsProvider.UNGROUPED
        ? files.ungrouped
        : (files.grouped[groupName] || []);

      return fileEntries.map(entry => new FileNode(entry.fileName, entry.resourceUri));
    }

    log('Getting top-level groups', 'view');
    const groups: vscode.TreeItem[] = [];
    const files = await this.getGroupedFiles();
    const unpushedCommits = await this.loadUnpushedCommits();

    // Load per-project config (may include "links")
    let config: any = {};
    try {
      config = await this.storage.loadConfig();
    } catch (e) {
      log(`Failed to load project config: ${e}`, 'config');
      config = {};
    }

    const linkDefinitions: Array<Record<string, string>> = Array.isArray(config.links) ? config.links : [];

    const makeNode = (name: string, count: number) => {
      const node = new GroupNode(name, true, count);

      // show count on the right side (description)
      node.description = count > 0 ? `(${count})` : undefined;

      // Resolve links for this group based on configured link definitions.
      try {
        const urls: string[] = [];
        for (const def of linkDefinitions) {
              for (const [pattern, template] of Object.entries(def || {})) {
            try {
              const re = new RegExp(pattern);
              const m = re.exec(name);
              if (m) {
                let url = template;
                // Replace named groups like $GroupName
                url = url.replace(/\$(\w+)/g, (_: string, gname: string) => {
                  // Try named capture groups first
                  const groups = (m as any).groups as Record<string, string> | undefined;
                  if (groups && gname in groups) {
                    return groups[gname] ?? '';
                  }
                  // Fallback to numeric groups (1-based)
                  const idx = Number(gname);
                  if (!Number.isNaN(idx) && m[idx] !== undefined) {
                    return m[idx] ?? '';
                  }
                  return '';
                });
                urls.push(url);
                }
            } catch (reErr) {
              log(`Invalid link regexp '${pattern}': ${reErr}`, 'config');
            }
          }
        }

        if (urls.length > 0) {
          // Attach first URL as the default click action
          const uri = vscode.Uri.parse(urls[0]);
          node.command = {
            command: 'git-file-groups.openLink',
            title: 'Open Link',
            arguments: [urls[0]]
          } as vscode.Command;

          // Tooltip with all links as Markdown
          const md = new vscode.MarkdownString(urls.map(u => `[${u}](${u})`).join('\n\n'));
          md.isTrusted = true;
          node.tooltip = md;
          node.label = `${name} 🔗`;
        }
      } catch (linkErr) {
        log(`Error resolving links for group ${name}: ${linkErr}`, 'config');
      }

      return node;
    };

    groups.push(new PendingCommitsNode(unpushedCommits.length));
    groups.push(makeNode(GitFileGroupsProvider.UNGROUPED, files.ungrouped.length));
    for (const groupName of this.groups) {
      const count = (files.grouped[groupName] || []).length;
      groups.push(makeNode(groupName, count));
    }
    return groups;
  }

  private async loadUnpushedCommits(): Promise<PendingCommitEntry[]> {
    const gitExtension = vscode.extensions.getExtension<GitAPI>('vscode.git');
    if (!gitExtension) {
      return [];
    }

    if (!gitExtension.isActive) {
      await gitExtension.activate();
    }

    const api = gitExtension.exports.getAPI(1);
    const repository = api.repositories.find((repo: any) => {
      const repoPath = repo.rootUri?.fsPath;
      return repoPath && path.normalize(repoPath).toLowerCase() === path.normalize(this.workspaceRoot).toLowerCase();
    }) ?? api.repositories.find((repo: any) => {
      const repoPath = repo.rootUri?.fsPath;
      return repoPath && path.normalize(this.workspaceRoot).toLowerCase().startsWith(path.normalize(repoPath).toLowerCase());
    });

    const ahead = typeof repository?.state?.HEAD?.ahead === 'number' ? repository.state.HEAD.ahead : 0;
    if (!repository?.rootUri?.fsPath || ahead <= 0) {
      return [];
    }

    this.cachedRepositoryRoot = repository.rootUri.fsPath;

    const output = await this.runGitCommand([
      '-C',
      repository.rootUri.fsPath,
      'log',
      '--format=%H%x09%s',
      '@{upstream}..HEAD'
    ]);

    if (!output) {
      return [];
    }

    return output
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => {
        const [hash, ...messageParts] = line.split('\t');
        const message = messageParts.join('\t').trim();
        return {
          hash,
          shortHash: hash.slice(0, 7),
          message: message || hash,
          repositoryRoot: repository.rootUri.fsPath
        };
      });
  }

  private async runGitCommand(args: string[]): Promise<string | undefined> {
    return await new Promise<string | undefined>((resolve) => {
      const child = spawn('git', args, { shell: false });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on('error', (error: Error) => {
        log(`git command failed to start: ${error}`, 'git');
        resolve(undefined);
      });

      child.on('close', (code: number | null) => {
        if (code === 0) {
          resolve(stdout.trim());
          return;
        }

        log(`git command failed (${code}): ${stderr.trim()}`, 'git');
        resolve(undefined);
      });
    });
  }

  private getGroupLabel(type: number): string {
    switch (type) {
      case 0:
        return 'Untracked';

      case 1:
        return 'Modified';
      case 2:
        return 'Added';
      case 3:
        return 'Deleted';
      default:
        return 'Unknown';
    }
  }

  private toAssignmentKey(uri: vscode.Uri): string | undefined {
    if (!uri) {
      return undefined;
    }

    const fsPath = uri.fsPath;
    if (!fsPath) {
      return undefined;
    }

    return fsPath;
  }

  private async getGroupedFiles(): Promise<{ ungrouped: FileEntry[]; grouped: Record<string, FileEntry[]> }> {
    const entries = await this.loadGitFileEntries();
    const grouped: Record<string, FileEntry[]> = {};
    const ungrouped: FileEntry[] = [];

    for (const groupName of this.groups) {
      grouped[groupName] = [];
    }

    for (const entry of entries) {
      const key = this.toAssignmentKey(entry.resourceUri);
      const assigned = key ? this.assignments[key] : undefined;
      if (assigned && grouped[assigned]) {
        grouped[assigned].push(entry);
      } else {
        ungrouped.push(entry);
      }
    }

    return { ungrouped, grouped };
  }

  private async loadGitFileEntries(): Promise<FileEntry[]> {
    const snapshot = await this.loadGitSnapshot();
    return snapshot.entries;
  }

  private async loadGitSnapshot(): Promise<{ entries: FileEntry[]; repositoryAvailable: boolean }> {
    try {
      const gitExtension = vscode.extensions.getExtension<GitAPI>('vscode.git');
      if (!gitExtension) {
        log('Git extension not found', 'git');
        return { entries: [], repositoryAvailable: false };
      }

      if (!gitExtension.isActive) {
        log('Activating Git extension...', 'git');
        await gitExtension.activate();
      }

      const api = gitExtension.exports.getAPI(1);

      // Git extension can take a moment to populate repositories after activation.
      for (let attempt = 0; attempt < 5 && (!api.repositories || api.repositories.length === 0); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      log(`Available repositories: ${api.repositories.map((repo: any) => repo.rootUri?.fsPath).join(', ')}`, 'git');
      log(`Looking for workspace root: ${this.workspaceRoot}`, 'git');

      const normalizeFsPath = (p: string) => path.normalize(p).toLowerCase();

      let repository = api.repositories.find((repo: any) => normalizeFsPath(repo.rootUri.fsPath) === normalizeFsPath(this.workspaceRoot));

      if (!repository) {
        const foundRepo = api.repositories.find((repo: any) => {
          const repoPath = repo.rootUri.fsPath;
          return path.normalize(this.workspaceRoot).toLowerCase().startsWith(path.normalize(repoPath).toLowerCase());
        });

        if (foundRepo) {
          this.workspaceRoot = foundRepo.rootUri.fsPath;
          repository = foundRepo;
        }
      }

      if (!repository) {
        log('No repository found immediately, waiting 500ms and retrying...', 'git');
        await new Promise(resolve => setTimeout(resolve, 500));
        repository = api.repositories.find((repo: any) => normalizeFsPath(repo.rootUri.fsPath) === normalizeFsPath(this.workspaceRoot))
          ?? api.repositories.find((repo: any) => {
            const repoPath = repo.rootUri.fsPath;
            return path.normalize(this.workspaceRoot).toLowerCase().startsWith(path.normalize(repoPath).toLowerCase());
          });

        if (repository?.rootUri?.fsPath && repository.rootUri.fsPath !== this.workspaceRoot) {
          this.workspaceRoot = repository.rootUri.fsPath;
        }
      }

      if (!repository) {
          log(`No Git repository found for workspace: ${this.workspaceRoot}`, 'git');
        return { entries: [], repositoryAvailable: false };
      }

      this.cachedRepositoryRoot = repository?.rootUri?.fsPath;

      let changes: any[] = [];
      try {
        if (repository.state) {
          const status = repository.state;
          const workingTreeChanges: any[] = status?.workingTreeChanges || [];
          const indexChanges: any[] = status?.indexChanges || [];
          changes = [...workingTreeChanges, ...indexChanges];
        } else if (repository.getStatus) {
          const status = await repository.getStatus();
          changes = status?.workingTreeChanges || [];
        } else if (repository.workingTreeChanges) {
          changes = repository.workingTreeChanges || [];
        }
      } catch (statusError) {
        log(`Error getting status: ${statusError}`, 'git');
        changes = [];
      }

      log(`Repository status retrieved, changes count: ${changes.length}`, 'git');

      if (changes.length === 0 && repository.state) {
        log(`Repository.state keys: ${Object.keys(repository.state).join(', ')}`, 'git');
      }

      const entries: FileEntry[] = [];
      for (const change of changes) {
        // Include all changes in *Ungrouped for now.
        // We'll tighten this once we confirm the Git status values in your environment.

        const { fileName, resourceUri } = this.toFileNameAndUri(change);
        if (!resourceUri) {
          continue;
        }

        entries.push({ fileName, resourceUri });
      }

      if (changes.length > 0 && entries.length === 0) {
        log(`No entries produced from changes. First change status: ${(changes[0] as any)?.status}`, 'git');
      }

      return {
        entries: entries.sort((a, b) => a.fileName.localeCompare(b.fileName)),
        repositoryAvailable: true
      };
    } catch (error) {
      log(`Error accessing Git API: ${error}`, 'git');
      return { entries: [], repositoryAvailable: false };
    }
  }

  private toFileNameAndUri(change: any): { fileName: string; resourceUri: vscode.Uri | undefined } {
    const candidateUri: vscode.Uri | undefined = change.uri ?? change.resourceUri;
    if (candidateUri) {
      const candidateFsPath = candidateUri.fsPath;
      const fileName = (candidateFsPath || candidateUri.path).split(path.sep).pop() || '';

      if (candidateUri.scheme === 'file' && candidateFsPath) {
        return { fileName, resourceUri: candidateUri };
      }

      if (candidateUri.path) {
        const decodedPath = decodeURIComponent(candidateUri.path);
        const normalized = decodedPath.startsWith('/') ? decodedPath.slice(1) : decodedPath;
        return { fileName, resourceUri: vscode.Uri.file(normalized) };
      }

      return { fileName, resourceUri: undefined };
    }

    if (change.path) {
      const rawPath: string = change.path;
      const fileName = rawPath.split(path.sep).pop() || '';
      const fsPath = path.isAbsolute(rawPath)
        ? rawPath
        : (this.cachedRepositoryRoot ? path.join(this.cachedRepositoryRoot, rawPath) : path.join(this.workspaceRoot, rawPath));

      return { fileName, resourceUri: vscode.Uri.file(fsPath) };
    }

    return { fileName: 'Unknown file', resourceUri: undefined };
  }
}

interface FileEntry {
  fileName: string;
  resourceUri: vscode.Uri;
}

interface PendingCommitEntry {
  hash: string;
  shortHash: string;
  message: string;
  repositoryRoot: string;
}

export class FileNode extends vscode.TreeItem {
  constructor(
    public readonly fileName: string,
    public readonly resourceUri: vscode.Uri
  ) {
    super(fileName, vscode.TreeItemCollapsibleState.None);
    this.description = vscode.workspace.asRelativePath(resourceUri, false);
    this.contextValue = 'file';
    this.resourceUri = resourceUri;
    this.command = {
      command: 'git-file-groups.openFile',
      title: 'Open File',
      arguments: [resourceUri]
    };
  }

  get fileUri(): vscode.Uri {
    return this.resourceUri;
  }
}

export class GroupNode extends vscode.TreeItem {
  constructor(
    public readonly groupName: string,
    isExpanded: boolean = true,
    public readonly count?: number
  ) {
    super(groupName, isExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = groupName === GitFileGroupsProvider.UNGROUPED ? 'ungrouped-node' : 'group-node';
    // this.description = groupName === GitFileGroupsProvider.UNGROUPED ? 'Files not in any group' : undefined;
  }
}

export class PendingCommitsNode extends vscode.TreeItem {
  constructor(public readonly count: number) {
    super('* commits not yet pushed', vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'pending-commits-root';
    this.description = `(${count})`;
  }
}

export class PendingCommitItem extends vscode.TreeItem {
  constructor(public readonly commit: PendingCommitEntry) {
    super(commit.message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'pending-commit';
    this.description = commit.shortHash;
    this.tooltip = `${commit.shortHash} ${commit.message}`;
    this.iconPath = new vscode.ThemeIcon('git-commit');
    this.command = {
      command: 'git.viewCommit',
      title: 'View Commit',
      arguments: [vscode.Uri.file(commit.repositoryRoot), commit.hash]
    };
  }
}