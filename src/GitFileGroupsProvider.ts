import * as vscode from 'vscode';
import * as path from 'path';
import { ProjectStorage, GitFileGroupsData } from './ProjectStorage';

// Create output channel for logging
const outputChannel = vscode.window.createOutputChannel('Git File Groups');

function log(message: string) {
  const timestamp = new Date().toISOString();
  const formattedMessage = `[${timestamp}] ${message}`;
  console.log('[git-file-groups]', message);
  outputChannel.appendLine(formattedMessage);
}

interface GitAPI {
  getAPI(version: number): any;
}

export class GitFileGroupsProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  public static readonly UNGROUPED = 'default';
  private onDidChangeTreeDataEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private groups: string[] = [];
  private assignments: Record<string, string> = {};
  private cachedRepositoryRoot: string | undefined;
  private storage: ProjectStorage;
  private treeView: vscode.TreeView<vscode.TreeItem> | undefined;

  private async executeFirstAvailableCommand(commandIds: string[]): Promise<boolean> {
    for (const commandId of commandIds) {
      try {
        await vscode.commands.executeCommand(commandId);
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // If the command is not found, try next. Otherwise log and try next.
        log(`${commandId} failed: ${message}`);
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
          log(`Failed to expand root ${item.label}: ${e instanceof Error ? e.message : String(e)}`);
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
      log(`expandAll discovery candidates: ${candidates.slice(0, 10).join(', ')}`);

      for (const cmd of candidates) {
        try {
          await vscode.commands.executeCommand(cmd);
          log(`expandAll succeeded via ${cmd}`);
          return true;
        } catch {
          // keep trying
        }
      }
    } catch (e) {
      log(`expandAll discovery failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    return false;
  }

  constructor(private workspaceRoot: string, private state: vscode.Memento) {
    log(`GitFileGroupsProvider constructor called with workspaceRoot: ${this.workspaceRoot}`);
    log(`Constructor timestamp: ${new Date().toISOString()}`);
    
    this.storage = new ProjectStorage(workspaceRoot);
    this.initializeStorage().then(() => {
      this.refresh();
    });
  }

  private async initializeStorage(): Promise<void> {
    // Try to migrate from global state first
    const migrated = await this.storage.migrateFromGlobalState(this.state);
    if (migrated) {
      log('Successfully migrated data from global state to project file');
    }
    
    // Load data from project file
    await this.loadData();
  }

  private async loadData(): Promise<void> {
    const data = await this.storage.loadData();
    this.groups = data.groups || [];
    this.assignments = data.assignments || {};
  }

  private async saveData(): Promise<void> {
    await this.storage.saveData({
      groups: this.groups,
      assignments: this.assignments
    });
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  setTreeView(treeView: vscode.TreeView<vscode.TreeItem>): void {
    this.treeView = treeView;
  }

  dispose(): void {
    // Clean up resources
    this.onDidChangeTreeDataEmitter.dispose();
  }

  async toggleExpandCollapse(): Promise<void> {
    log('toggleExpandCollapse called');

    if (!this.treeView) {
      log('No treeView available');
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
        log(`Failed to focus tree view via reveal: ${e}`);
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
    log('toggleExpandCollapse completed');
  }

  async collapseAllGroups(): Promise<void> {
    log('collapseAllGroups called');

    if (!this.treeView) {
      log('No treeView available');
      return;
    }

    // Ensure our tree view is focused, otherwise collapseAll/expandAll may target a different view.
    const rootItems = await this.getChildren(undefined);
    const first = rootItems[0];
    if (first) {
      try {
        await this.treeView.reveal(first, { focus: true, select: false, expand: false });
      } catch (e) {
        log(`Failed to focus tree view via reveal: ${e}`);
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
    log('collapseAllGroups completed');
  }

  refresh(): void {
    log('Refresh method called');
    log('Firing tree data change event');
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
    if (!trimmed || trimmed === GitFileGroupsProvider.UNGROUPED) {
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
    if (!trimmed || trimmed === GitFileGroupsProvider.UNGROUPED) {
      return;
    }

    const gitExtension = vscode.extensions.getExtension<GitAPI>('vscode.git');
    if (!gitExtension) {
      log('Git extension not available for commitGroup');
      return;
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
      log('No repository found for commitGroup');
      return;
    }

    log(`[commitGroup] Repository object keys: ${Object.keys(repository).join(', ')}`);
    log(`[commitGroup] Repository.index: ${repository.index}`);

    // Get all current changes and group files
    const allChanges = await this.loadGitFileEntries();
    const groupFiles = await this.getGroupedFiles();
    const targetUris = new Set(
      (groupFiles.grouped[trimmed] || []).map(f => f.resourceUri)
    );

    log(`[commitGroup] Group: ${trimmed}`);
    log(`[commitGroup] All changes count: ${allChanges.length}`);
    log(`[commitGroup] Target files to stage: ${targetUris.size}`);
    for (const uri of targetUris) {
      log(`[commitGroup] Target URI: ${uri}`);
    }

    // Unstage all changes first using repository.revert
    for (const change of allChanges) {
      log(`[commitGroup] Unstaging: ${change.resourceUri}`);
      try {
        await repository.revert([change.resourceUri.fsPath]);
      } catch (e) {
        log(`Failed to unstage ${change.resourceUri.fsPath}: ${e}`);
      }
    }

    // Stage only files in the target group using repository.add
    const filePathsToStage = Array.from(targetUris).map(uri => uri.fsPath);
    log(`[commitGroup] Staging files: ${filePathsToStage.join(', ')}`);
    try {
      await repository.add(filePathsToStage);
    } catch (e) {
      log(`Failed to stage files: ${e}`);
    }

    // Show input box for commit message and commit directly
    // Prefill the input with the group name so it's the default commit message
    const message = await vscode.window.showInputBox({
      prompt: 'Commit message',
      placeHolder: 'Enter commit message...',
      value: trimmed
    });

    if (!message) {
      // User cancelled - unstage all changes to restore original state
      log(`[commitGroup] User cancelled, unstaging all changes`);
      for (const change of allChanges) {
        log(`[commitGroup] Unstaging (cancel): ${change.resourceUri}`);
        try {
          await repository.revert([change.resourceUri.fsPath]);
        } catch (e) {
          log(`Failed to unstage ${change.resourceUri.fsPath}: ${e}`);
        }
      }
      return; // User cancelled
    }

    try {
      await repository.commit(message);
      log(`[commitGroup] Committed with message: ${message}`);
      // Refresh view after commit so active changes reflect repository state
      this.refresh();
    } catch (error) {
      log(`[commitGroup] Direct commit failed: ${error}`);
    }
  }

  async stageAllChanges(): Promise<void> {
    const gitExtension = vscode.extensions.getExtension<GitAPI>('vscode.git');
    if (!gitExtension) {
      log('Git extension not available for stageAllChanges');
      return;
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
      log('No repository found for stageAllChanges');
      return;
    }

    // Get all current changes and stage them
    const allChanges = await this.loadGitFileEntries();
    const filePathsToStage = allChanges.map(change => change.resourceUri.fsPath);
    log(`[stageAllChanges] Staging all changes: ${filePathsToStage.join(', ')}`);
    try {
      await repository.add(filePathsToStage);
    } catch (e) {
      log(`Failed to stage all changes: ${e}`);
    }
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
    log(`getChildren called with element: ${element ? element.label : 'undefined'}`);
    log(`getChildren timestamp: ${new Date().toISOString()}`);

    if (element instanceof GroupNode) {
      log(`Returning children for GroupNode: ${element.groupName}`);
      const files = await this.getGroupedFiles();
      const groupName = element.groupName;
      const fileEntries = groupName === GitFileGroupsProvider.UNGROUPED
        ? files.ungrouped
        : (files.grouped[groupName] || []);

      return fileEntries.map(entry => new FileNode(entry.fileName, entry.resourceUri));
    }

    log('Getting top-level groups');
    const groups: vscode.TreeItem[] = [];
    const files = await this.getGroupedFiles();

    // Load per-project config (may include "links")
    let config: any = {};
    try {
      config = await this.storage.loadConfig();
    } catch (e) {
      log(`Failed to load project config: ${e}`);
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
              log(`Invalid link regexp '${pattern}': ${reErr}`);
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
        log(`Error resolving links for group ${name}: ${linkErr}`);
      }

      return node;
    };

    groups.push(makeNode(GitFileGroupsProvider.UNGROUPED, files.ungrouped.length));
    for (const groupName of this.groups) {
      const count = (files.grouped[groupName] || []).length;
      groups.push(makeNode(groupName, count));
    }
    return groups;
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
    try {
      const gitExtension = vscode.extensions.getExtension<GitAPI>('vscode.git');
      if (!gitExtension) {
        log('Git extension not found');
        return [];
      }

      if (!gitExtension.isActive) {
        log('Activating Git extension...');
        await gitExtension.activate();
      }

      const api = gitExtension.exports.getAPI(1);

      // Git extension can take a moment to populate repositories after activation.
      for (let attempt = 0; attempt < 5 && (!api.repositories || api.repositories.length === 0); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      log(`Available repositories: ${api.repositories.map((repo: any) => repo.rootUri?.fsPath).join(', ')}`);
      log(`Looking for workspace root: ${this.workspaceRoot}`);

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
        log('No repository found immediately, waiting 500ms and retrying...');
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
        log(`No Git repository found for workspace: ${this.workspaceRoot}`);
        return [];
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
        log(`Error getting status: ${statusError}`);
        changes = [];
      }

      log(`Repository status retrieved, changes count: ${changes.length}`);

      if (changes.length === 0 && repository.state) {
        log(`Repository.state keys: ${Object.keys(repository.state).join(', ')}`);
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
        log(`No entries produced from changes. First change status: ${(changes[0] as any)?.status}`);
      }

      return entries.sort((a, b) => a.fileName.localeCompare(b.fileName));
    } catch (error) {
      log(`Error accessing Git API: ${error}`);
      return [];
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

export class FileNode extends vscode.TreeItem {
  constructor(
    public readonly fileName: string,
    public readonly resourceUri: vscode.Uri
  ) {
    super(fileName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'file';
    this.resourceUri = resourceUri;
    this.command = {
      command: 'git-file-groups.openDiff',
      title: 'Open Diff',
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
    this.contextValue = groupName === GitFileGroupsProvider.UNGROUPED ? 'ungrouped' : 'group';
    // this.description = groupName === GitFileGroupsProvider.UNGROUPED ? 'Files not in any group' : undefined;
  }
}