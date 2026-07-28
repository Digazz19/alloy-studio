import * as vscode from 'vscode';

export class AlloyCodeLensProvider implements vscode.CodeLensProvider {

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const codeLenses: vscode.CodeLens[] = [];
    const lines = document.getText().split('\n');
    let commandIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('run') || line.startsWith('check')) {
        const range = new vscode.Range(i, 0, i, 0);
        codeLenses.push(new vscode.CodeLens(range, {
        title: '▶ Execute',
        command: 'alloy.executeCommand',
        arguments: [document.uri.toString(), commandIndex]
      }));
        commandIndex++;
      }
    }

    return codeLenses;
  }
}