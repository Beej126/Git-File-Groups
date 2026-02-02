import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { log } from './logging';

export interface GitFileGroupsData {
  groups: string[];
  assignments: Record<string, string>;
}

export class ProjectStorage {
  private static readonly STORAGE_FILE = '.vscode/git-file-groups.jsonc';

  /**
   * Very small, permissive JSONC comment stripper for allowing // and C-style block comments
   * before parsing JSON. This is deliberately simple (regex-based) but sufficient
   * for lightweight project config files where a full JSONC parser isn't required.
   */
  private stripJsonComments(content: string): string {
    // remove /* ... */ comments
    content = content.replace(/\/\*[\s\S]*?\*\//g, '');
    // remove //... comments
    content = content.replace(/(^|[^:"'])\/\/.*$/gm, (m, g1) => g1 ?? '');
    return content;
  }

  private storagePath: string;

  constructor(private workspaceRoot: string) {
    this.storagePath = path.join(workspaceRoot, ProjectStorage.STORAGE_FILE);
  }

  /**
   * Convert an absolute file path to a project-relative path with forward slashes
   */
  private toRelativePath(absolutePath: string): string {
    const relative = path.relative(this.workspaceRoot, absolutePath);
    return relative.split(path.sep).join('/');
  }

  /**
   * Convert a project-relative path back to an absolute path
   */
  private fromRelativePath(relativePath: string): string {
    const normalized = relativePath.split('/').join(path.sep);
    return path.resolve(this.workspaceRoot, normalized);
  }

  /**
   * Convert assignments to use relative paths for storage
   */
  private normalizeAssignmentsForStorage(assignments: Record<string, string>): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [absolutePath, groupName] of Object.entries(assignments)) {
      const relativePath = this.toRelativePath(absolutePath);
      normalized[relativePath] = groupName;
    }
    return normalized;
  }

  /**
   * Convert stored assignments back to absolute paths for internal use
   */
  private denormalizeAssignmentsFromStorage(assignments: Record<string, string>): Record<string, string> {
    const denormalized: Record<string, string> = {};
    for (const [relativePath, groupName] of Object.entries(assignments)) {
      const absolutePath = this.fromRelativePath(relativePath);
      denormalized[absolutePath] = groupName;
    }
    return denormalized;
  }

  private async ensureStorageDirectory(): Promise<void> {
    const vscodeDir = path.dirname(this.storagePath);
    if (!fs.existsSync(vscodeDir)) {
      await fs.promises.mkdir(vscodeDir, { recursive: true });
    }
  }

  async loadData(): Promise<GitFileGroupsData> {
    try {
      if (!fs.existsSync(this.storagePath)) {
        return { groups: [], assignments: {} };
      }

      const content = await fs.promises.readFile(this.storagePath, 'utf8');
      const stripped = this.stripJsonComments(content);
      const data = JSON.parse(stripped);
      
      const assignments = typeof data.assignments === 'object' ? data.assignments : {};
      
      return {
        groups: Array.isArray(data.groups) ? data.groups : [],
        assignments: this.denormalizeAssignmentsFromStorage(assignments)
      };
    } catch (error) {
      log(`Error loading project data: ${error}`, 'config');
      return { groups: [], assignments: {} };
    }
  }

  async saveData(data: GitFileGroupsData): Promise<void> {
    try {
      await this.ensureStorageDirectory();
      const content = JSON.stringify({
        groups: data.groups,
        assignments: this.normalizeAssignmentsForStorage(data.assignments)
      }, null, 2);
      await fs.promises.writeFile(this.storagePath, content, 'utf8');
    } catch (error) {
      log(`Error saving project data: ${error}`, 'config');
      throw error;
    }
  }

  async migrateFromGlobalState(globalState: vscode.Memento): Promise<boolean> {
    try {
      const legacyGroupsKey = 'git-file-groups.groups';
      const legacyAssignmentsKey = 'git-file-groups.assignments';

      const groups = globalState.get<string[]>(legacyGroupsKey, []);
      const assignments = globalState.get<Record<string, string>>(legacyAssignmentsKey, {});

      if (groups.length === 0 && Object.keys(assignments).length === 0) {
        return false; // No data to migrate
      }

      // Convert absolute paths to relative paths for assignments
      const normalizedAssignments = this.normalizeAssignmentsForStorage(assignments);

      await this.saveData({ groups, assignments: normalizedAssignments });

      // Clear legacy data from global state
      await globalState.update(legacyGroupsKey, undefined);
      await globalState.update(legacyAssignmentsKey, undefined);

      return true;
    } catch (error) {
      log(`Error migrating from global state: ${error}`, 'config');
      return false;
    }
  }

  getStoragePath(): string {
    return this.storagePath;
  }

  /**
   * Load raw config from the storage file (returns parsed JSON or empty object)
   */
  async loadConfig(): Promise<any> {
    try {
      if (!fs.existsSync(this.storagePath)) {
        return {};
      }
      const content = await fs.promises.readFile(this.storagePath, 'utf8');
      const stripped = this.stripJsonComments(content);
      const data = JSON.parse(stripped);
      return data || {};
    } catch (error) {
      log(`Error loading project config: ${error}`, 'config');
      return {};
    }
  }
}
