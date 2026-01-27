import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand('git-file-groups.helloWorld', () => {
    vscode.window.showInformationMessage('Hello World from git-file-groups!');
  });

  context.subscriptions.push(disposable);

  const sidebarProvider = new SidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('git-file-groups.openSidebar', () => {
      const panel = vscode.window.createWebviewPanel(
        'gitFileGroupsSidebar',
        'Git File Groups Sidebar',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          localResourceRoots: [context.extensionUri]
        }
      );
      panel.webview.html = sidebarProvider._getHtmlForWebview(panel.webview);
    })
  );
}

export function deactivate() {}

class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'gitFileGroupsSidebar';

  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext<unknown>, token: vscode.CancellationToken): void | Thenable<void> {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
  }

  public _getHtmlForWebview(webview: vscode.Webview): string {
    const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css'));
    const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css'));

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Git File Groups Sidebar (GfG)</title>
  <link href="${styleResetUri}" rel="stylesheet">
  <link href="${styleMainUri}" rel="stylesheet">
</head>
<body>
  <h1>Welcome to Git File Groups Sidebar (GfG)</h1>
  <p>This is where you can manage your file groups.</p>
</body>
</html>`;
  }
}