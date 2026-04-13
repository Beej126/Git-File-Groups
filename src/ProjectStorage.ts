import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { applyEdits, modify, parse, ParseError, printParseErrorCode } from 'jsonc-parser';
import { log } from './logging';

export interface GitFileGroupsData {
  groups: string[];
  assignments: Record<string, string>;
}

class MalformedProjectConfigError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly line: number,
    public readonly column: number,
    message: string
  ) {
    super(message);
    this.name = 'MalformedProjectConfigError';
  }
}

export class ProjectStorage {
  private static readonly STORAGE_FILE = '.vscode/git-file-groups.jsonc';
  private static readonly JSONC_FORMATTING_OPTIONS = {
    insertSpaces: true,
    tabSize: 2,
    insertFinalNewline: true
  };

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
  private lastMalformedConfigMessage: string | undefined;

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
      this.assertValidJsonc(content);
      const stripped = this.stripJsonComments(content);
      const data = JSON.parse(stripped);
      this.lastMalformedConfigMessage = undefined;
      
      const assignments = typeof data.assignments === 'object' ? data.assignments : {};
      
      return {
        groups: Array.isArray(data.groups) ? data.groups : [],
        assignments: this.denormalizeAssignmentsFromStorage(assignments)
      };
    } catch (error) {
      this.reportMalformedConfigIfNeeded(error);
      log(`Error loading project data: ${error}`, 'config');
      return { groups: [], assignments: {} };
    }
  }

  async saveData(data: GitFileGroupsData): Promise<void> {
    try {
      await this.ensureStorageDirectory();
      const normalizedAssignments = this.normalizeAssignmentsForStorage(data.assignments);
      const content = await this.buildUpdatedContent({
        groups: data.groups,
        assignments: normalizedAssignments
      });
      await fs.promises.writeFile(this.storagePath, content, 'utf8');
    } catch (error) {
      log(`Error saving project data: ${error}`, 'config');
      throw error;
    }
  }

  async saveConfigValue(jsonPath: (string | number)[], value: unknown): Promise<void> {
    try {
      await this.ensureStorageDirectory();

      const existingContent = fs.existsSync(this.storagePath)
        ? await fs.promises.readFile(this.storagePath, 'utf8')
        : '{}\n';

      this.assertValidJsonc(existingContent);
      this.lastMalformedConfigMessage = undefined;

      const updatedContent = this.applyJsoncEdit(existingContent, jsonPath, value);
      await fs.promises.writeFile(this.storagePath, updatedContent, 'utf8');
    } catch (error) {
      this.reportMalformedConfigIfNeeded(error);
      log(`Error saving project config value at ${jsonPath.join('.')}: ${error}`, 'config');
      throw error;
    }
  }

  private async buildUpdatedContent(data: { groups: string[]; assignments: Record<string, string> }): Promise<string> {
    if (!fs.existsSync(this.storagePath)) {
      return `${JSON.stringify(data, null, 2)}\n`;
    }

    const existingContent = await fs.promises.readFile(this.storagePath, 'utf8');
    this.assertValidJsonc(existingContent);
    this.lastMalformedConfigMessage = undefined;

    let updatedContent = this.applyJsoncEdit(existingContent, ['groups'], data.groups);
    updatedContent = this.applyJsoncEdit(updatedContent, ['assignments'], data.assignments);
    return updatedContent;
  }

  private applyJsoncEdit(content: string, jsonPath: (string | number)[], value: unknown): string {
    const formattingOptions = {
      ...ProjectStorage.JSONC_FORMATTING_OPTIONS,
      eol: content.includes('\r\n') ? '\r\n' : '\n'
    };
    const edits = modify(content, jsonPath, value, { formattingOptions });
    return applyEdits(content, edits);
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

      await this.saveData({ groups, assignments });

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
      this.assertValidJsonc(content);
      const stripped = this.stripJsonComments(content);
      const data = JSON.parse(stripped);
      this.lastMalformedConfigMessage = undefined;
      return data || {};
    } catch (error) {
      this.reportMalformedConfigIfNeeded(error);
      log(`Error loading project config: ${error}`, 'config');
      return {};
    }
  }

  private assertValidJsonc(content: string): void {
    const parseErrors: ParseError[] = [];
    parse(content, parseErrors, {
      allowEmptyContent: true,
      allowTrailingComma: true,
      disallowComments: false
    });

    if (parseErrors.length === 0) {
      return;
    }

    const firstError = parseErrors[0];
    const position = this.getLineAndColumn(content, firstError.offset);
    const message = `${printParseErrorCode(firstError.error)} at line ${position.line}, column ${position.column}`;
    throw new MalformedProjectConfigError(this.storagePath, position.line, position.column, message);
  }

  private getLineAndColumn(content: string, offset: number): { line: number; column: number } {
    const prefix = content.slice(0, offset);
    const lines = prefix.split(/\r\n|\r|\n/);
    const line = lines.length;
    const column = (lines[lines.length - 1]?.length ?? 0) + 1;
    return { line, column };
  }

  private reportMalformedConfigIfNeeded(error: unknown): void {
    if (!(error instanceof MalformedProjectConfigError)) {
      return;
    }

    const message = `Git File Groups could not read or update its config because it contains malformed JSONC: ${error.filePath} (${error.message})`;
    if (this.lastMalformedConfigMessage === message) {
      return;
    }

    this.lastMalformedConfigMessage = message;
    void vscode.window.showErrorMessage(message, 'Open File').then(async selection => {
      if (selection !== 'Open File') {
        return;
      }

      try {
        const document = await vscode.workspace.openTextDocument(error.filePath);
        await vscode.window.showTextDocument(document, { preview: false });
      } catch (openError) {
        log(`Failed to open malformed config file ${error.filePath}: ${openError}`, 'config');
      }
    });
  }
}
