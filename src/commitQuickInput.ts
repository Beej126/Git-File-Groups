import * as vscode from 'vscode';

export interface CommitInputResult {
  message: string;
  autoSync: boolean;
}

export async function promptForCommitInput(options?: {
  title?: string;
  value?: string;
  placeHolder?: string;
  autoSync?: boolean;
}): Promise<CommitInputResult | undefined> {
  const input = vscode.window.createInputBox();
  const toggleButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('sync'),
    tooltip: 'Toggle auto-sync after commit'
  };

  let autoSync = options?.autoSync ?? true;

  const updateUi = () => {
    input.title = `${options?.title ?? 'Commit Changes'} • Auto-sync: ${autoSync ? 'On' : 'Off'}`;
    input.prompt = autoSync
      ? 'Enter a commit message. Auto-sync will run after this commit.'
      : 'Enter a commit message. Auto-sync is off for this commit.';
    input.placeholder = options?.placeHolder ?? 'Enter commit message...';
    input.buttons = [toggleButton];
    input.validationMessage = input.value.trim().length === 0 ? 'Commit message is required.' : undefined;
  };

  input.value = options?.value ?? '';
  updateUi();

  return await new Promise<CommitInputResult | undefined>((resolve) => {
    let settled = false;

    const finish = (result: CommitInputResult | undefined) => {
      if (settled) {
        return;
      }

      settled = true;
      disposables.forEach(disposable => disposable.dispose());
      input.dispose();
      resolve(result);
    };

    const disposables: vscode.Disposable[] = [
      input.onDidChangeValue(() => {
        updateUi();
      }),
      input.onDidTriggerButton(() => {
        autoSync = !autoSync;
        updateUi();
      }),
      input.onDidAccept(() => {
        const message = input.value.trim();
        if (!message) {
          updateUi();
          return;
        }

        input.hide();
        finish({ message, autoSync });
      }),
      input.onDidHide(() => {
        finish(undefined);
      })
    ];

    input.show();
  });
}