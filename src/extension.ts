import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import {
  LanguageClient,
  LanguageClientOptions,
  StreamInfo
} from 'vscode-languageclient/node';
import { AlloyDebugSession } from './alloyDebugAdapter';
import { alloyState } from './alloyState';
import { createAlloyTestController } from './alloyTestProvider';
import {
  sendToServer,
  sendWithProgress,
  startAlloyServer,
  stopAlloyServer,
  restartAlloyServer,
  AnalysisAbortedError
} from './alloyServer';
import {
  getAnalysisOptions,
  reportAnalysis,
  formatWarnings,
  showUnsatCore,
  clearUnsatCore,
  storeKodkod,
  registerAnalysisFeatures
} from './alloyAnalysis';

let client: LanguageClient;

export function activate(context: vscode.ExtensionContext) {

  // Sincronizar grafo com DAP
  let alloyPanel: vscode.WebviewPanel | undefined;

  alloyState.on('instanceChanged', (instance) => {
    if (!alloyPanel || !alloyPanel.visible) {
      alloyPanel = vscode.window.createWebviewPanel(
        'alloyResults',
        `Alloy: ${instance.commandLabel}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );

      alloyPanel.onDidDispose(() => {
        alloyPanel = undefined;
      });

      alloyPanel.webview.onDidReceiveMessage(async (message) => {
        const validActions = ['next', 'previous', 'newConfig', 'newTrace', 'newInit', 'newFork'];

        if (validActions.includes(message.command)) {
          if (vscode.debug.activeDebugSession?.type === 'alloy') {
            await vscode.debug.activeDebugSession.customRequest(message.command, {
              stateIndex: message.stateIndex ?? 0
            });
          } else {
            try {
              const response = await sendWithProgress(`Alloy: ${instance.commandLabel}`, {
                action: message.command,
                sessionId: message.sessionId,
                stateIndex: message.stateIndex ?? 0
              });
              if (response.noMoreInstances) {
                vscode.window.showInformationMessage('There are no more instances available.');
                return;
              }
              if (response.error) {
                vscode.window.showErrorMessage(response.error);
                return;
              }
              alloyState.setInstance({
                ...instance,
                instance: response.instance,
                isTemporal: response.isTemporal,
                traceLength: response.traceLength,
                loopState: response.loopState,
                hasConfigs: response.hasConfigs,
                hasNext: response.hasNext,
                hasPrevious: response.hasPrevious || false,
                sessionId: response.sessionId,
                currentStateIndex: message.command === 'newFork' ? (message.stateIndex ?? 0) : 0,
                subsetSigs: response.subsetSigs ?? []
              });
            } catch (err: any) {
              // Se foi cancelado, o aviso do reinício do servidor já foi mostrado
              if (!(err instanceof AnalysisAbortedError)) {
                vscode.window.showErrorMessage('Error: ' + err.message);
              }
            }
          }
        } else if (message.command === 'showState') {
          if (vscode.debug.activeDebugSession?.type === 'alloy') {
            await vscode.debug.activeDebugSession.customRequest('showState', {
              stateIndex: message.stateIndex
            });
          } else {
            // Use alloyState.getInstance() to avoid stale closure over the
            // original `instance` parameter (which is captured once when the
            // panel is first created and never updated by subsequent
            // instanceChanged events).
            const currentInstance = alloyState.getInstance() ?? instance;
            alloyPanel!.webview.html = getResultsHtml(
              currentInstance,
              currentInstance.commandLabel,
              message.stateIndex
            );
          }
        }
      });
    }

    alloyPanel.webview.html = getResultsHtml(instance, instance.commandLabel, instance.currentStateIndex);
    alloyPanel.reveal(vscode.ViewColumn.Beside, false);
  });

  alloyState.on('instanceCleared', () => {
    alloyPanel?.dispose();
    alloyPanel = undefined;
  });

  // Registar o DAP
  const factory = new AlloyDebugAdapterFactory();
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('alloy', factory)
  );

  // Dynamic debug configurations — Quick Pick ao lançar debug
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('alloy', {
      async resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration
      ): Promise<vscode.DebugConfiguration | undefined> {
        if (config.__skipQuickPick && config.commandIndex !== undefined && config.commandLabel) {
          return config;
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor) return config;

        const text = editor.document.getText();
        const lines = text.split('\n');
        const commands: string[] = [];

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('run') || trimmed.startsWith('check')) {
            commands.push(trimmed);
          }
        }

        if (commands.length === 0) {
          vscode.window.showErrorMessage('No run/check commands found.');
          return undefined;
        }

        const items = [
          ...commands.map((c, i) => ({ label: c, description: `Command ${i}`, index: i })),
          { label: '▶▶ Run All Commands', description: 'Execute all commands', index: -1 }
        ];

        let selectedIndex = 0;
        if (commands.length > 1 || true) {
          const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Choose the command to execute'
          });
          if (!picked) return undefined;
          selectedIndex = picked.index;
        }

        if (selectedIndex === -1) {
          setTimeout(() => {
            vscode.commands.executeCommand('alloy.runAll');
          }, 100);
          return undefined;
        }

        const alloyConfig = vscode.workspace.getConfiguration('alloy');
        config.solver = config.solver || alloyConfig.get('solver', 'sat4j');
        config.symmetry = config.symmetry ?? alloyConfig.get('symmetry', 20);
        config.skolemDepth = config.skolemDepth ?? alloyConfig.get('skolemDepth', 0);
        config.noOverflow = config.noOverflow ?? alloyConfig.get('noOverflow', false);
        config.unrolls = config.unrolls ?? alloyConfig.get('unrolls', -1);

        config.file = editor.document.uri.fsPath;
        config.commandIndex = selectedIndex;
        config.commandLabel = commands[selectedIndex];
        return config;
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('alloy.startDebug', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const filePath = editor.document.uri.fsPath;
      const text = editor.document.getText();
      const lines = text.split('\n');
      const commands: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('run') || trimmed.startsWith('check')) {
          commands.push(trimmed);
        }
      }

      const items = commands.map((c, i) => ({ label: c, description: `Command ${i}`, index: i }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Choose the command to execute'
      });
      if (!picked) return;

      vscode.debug.startDebugging(undefined, {
        type: 'alloy',
        request: 'launch',
        name: `Alloy: ${picked.label}`,
        file: filePath,
        commandIndex: picked.index,
        commandLabel: picked.label
      });
    })
  );

  // Comandos da barra de debug
  const debugCommands = [
    { command: 'alloy.debug.next', action: 'next' },
    { command: 'alloy.debug.previous', action: 'previous' },
    { command: 'alloy.debug.newTrace', action: 'newTrace' },
    { command: 'alloy.debug.newInit', action: 'newInit' },
    { command: 'alloy.debug.newConfig', action: 'newConfig' }
  ];

  for (const { command, action } of debugCommands) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async () => {
        if (vscode.debug.activeDebugSession?.type === 'alloy') {
          await vscode.debug.activeDebugSession.customRequest(action, {
            stateIndex: 0
          });
        }
      })
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('alloy.debug.newFork', async () => {
      if (vscode.debug.activeDebugSession?.type === 'alloy') {
        const currentState = alloyState.getInstance()?.currentStateIndex ?? 0;
        await vscode.debug.activeDebugSession.customRequest('newFork', {
          stateIndex: currentState
        });
      }
    })
  );

  // Stop registado separadamente
  context.subscriptions.push(
    vscode.commands.registerCommand('alloy.debug.stop', async () => {
      await vscode.debug.stopDebugging(vscode.debug.activeDebugSession);
    })
  );

  // Esconder a toolbar nativa quando o debug Alloy começa
  vscode.debug.onDidStartDebugSession((session) => {
    if (session.type === 'alloy') {
      vscode.commands.executeCommand('setContext', 'alloyDebugActive', true);
      vscode.workspace.getConfiguration('debug')
        .update('toolBarLocation', 'hidden', vscode.ConfigurationTarget.Global);
    }
  });

  // Restaurar a toolbar quando o debug Alloy termina
  vscode.debug.onDidTerminateDebugSession((session) => {
    if (session.type === 'alloy') {
      vscode.commands.executeCommand('setContext', 'alloyDebugActive', false);
      vscode.workspace.getConfiguration('debug')
        .update('toolBarLocation', 'floating', vscode.ConfigurationTarget.Global);
    }
  });

  // --- Comando Execute ---
  const executeDisposable = vscode.commands.registerCommand(
    'alloy.executeCommand',
    async (fileUri: any, commandIndex: any) => {

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No .als file open.');
        return;
      }

      const filePath = editor.document.uri.fsPath;

      let targetFile = filePath;
      if (fileUri && typeof fileUri === 'object' && fileUri.path) {
        targetFile = fileUri.path;
      } else if (typeof fileUri === 'string') {
        targetFile = vscode.Uri.parse(fileUri).fsPath;
      }

      const validCommandIndex = typeof commandIndex === 'number' ? commandIndex : -1;

      const text = editor.document.getText();
      const lines = text.split('\n');
      const commands: string[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('run') || trimmed.startsWith('check')) {
          commands.push(trimmed);
        }
      }

      let selectedIndex = validCommandIndex;
      if (selectedIndex === -1 || commands.length > 1) {
        const items = commands.map((c, i) => ({ label: c, description: `Command ${i}`, index: i }));
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Choose command to execute'
        });
        if (!picked) return;
        selectedIndex = Number(picked.index);
      }

      const commandLabel = commands[selectedIndex] ?? 'Result';

      const panel = vscode.window.createWebviewPanel(
        'alloyResults',
        `Alloy: ${commandLabel}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );

      panel.webview.html = getLoadingHtml();

      try {
        clearUnsatCore();
        const response = await sendWithProgress(`Alloy: ${commandLabel}`, {
          action: 'execute',
          file: targetFile,
          commandIndex: selectedIndex,
          ...getAnalysisOptions()
        });

        // Message log, unsat core e Kodkod (como no Analyzer)
        reportAnalysis(commandLabel, response, true);
        storeKodkod(commandLabel, response);
        showUnsatCore(response);

        if (response.error) {
          panel.webview.html = getErrorHtml(
            response.warnings?.length ? `${response.error}\n\n${formatWarnings(response)}` : response.error
          );
          return;
        }

        let lastResponse = response;
        panel.webview.html = getResultsHtml(lastResponse, commandLabel);

        panel.webview.onDidReceiveMessage(async (message) => {
          const validActions = ['next', 'previous', 'newConfig', 'newTrace', 'newInit', 'newFork'];
          if (validActions.includes(message.command)) {
            try {
              const newResponse = await sendWithProgress(`Alloy: ${commandLabel}`, {
                action: message.command,
                sessionId: message.sessionId,
                stateIndex: message.stateIndex ?? 0
              });
              if (newResponse.error) {
                vscode.window.showErrorMessage(newResponse.error);
                return;
              }
              lastResponse = newResponse;
              panel.webview.html = getResultsHtml(lastResponse, commandLabel);
            } catch (err: any) {
              // Se foi cancelado, o aviso do reinício do servidor já foi mostrado
              if (!(err instanceof AnalysisAbortedError)) {
                vscode.window.showErrorMessage('Error: ' + err.message);
              }
            }
          } else if (message.command === 'showState') {
            panel.webview.html = getResultsHtml(lastResponse, commandLabel, message.stateIndex);
          }
        });

      } catch (err: any) {
        panel.webview.html = err instanceof AnalysisAbortedError
          ? getCancelledHtml(err.message)
          : getErrorHtml('Error communicating with the Alloy Server.\n' + err.message);
      }
    }
  );
  context.subscriptions.push(executeDisposable);

  // --- Run All ---
  const runAllDisposable = vscode.commands.registerCommand('alloy.runAll', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No .als file open.');
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const text = editor.document.getText();
    const lines = text.split('\n');
    const commands: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('run') || trimmed.startsWith('check')) {
        commands.push(trimmed);
      }
    }

    if (commands.length === 0) {
      vscode.window.showErrorMessage('No run/check commands found.');
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'alloyResults',
      'Alloy: Run All',
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    panel.webview.html = getLoadingHtml();

    const results: { label: string; response: any; index: number }[] = [];
    clearUnsatCore();

    // Uma única notificação para todos os comandos, mostrada só se o Run All demorar mais
    // de 1 s (para não piscar); Cancel interrompe o comando em curso (reiniciando o
    // servidor) e não executa os seguintes
    const source = new vscode.CancellationTokenSource();
    const token = source.token;
    let currentMessage = '';
    let report: ((message: string) => void) | undefined;
    let finishRunAll: () => void = () => { };
    const runAllDone = new Promise<void>(resolve => { finishRunAll = resolve; });
    const progressTimer = setTimeout(() => {
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Alloy: Run All', cancellable: true },
        (progress, progressToken) => {
          progressToken.onCancellationRequested(() => source.cancel());
          report = (message) => progress.report({ message });
          report(currentMessage);
          return runAllDone;
        }
      );
    }, 1000);

    try {
      for (let i = 0; i < commands.length; i++) {
        if (token.isCancellationRequested) break;
        currentMessage = `${i + 1}/${commands.length}: ${commands[i]}`;
        report?.(currentMessage);
        try {
          const response = await sendToServer({
            action: 'execute',
            file: filePath,
            commandIndex: i,
            ...getAnalysisOptions()
          }, token);
          reportAnalysis(commands[i], response, i === 0);
          storeKodkod(commands[i], response);
          results.push({ label: commands[i], response, index: i });
        } catch (err: any) {
          results.push({
            label: commands[i],
            // Interrompido (Cancel ou tempo limite) não é um erro do modelo
            response: err instanceof AnalysisAbortedError
              ? { stopped: true, message: err.message }
              : { error: err.message },
            index: i
          });
        }
      }
      // Comandos que ficaram por correr depois de um Cancel
      for (let i = results.length; i < commands.length; i++) {
        results.push({ label: commands[i], response: { notRun: true }, index: i });
      }
    } finally {
      clearTimeout(progressTimer);
      finishRunAll();
      source.dispose();
    }

    panel.webview.html = getSummaryHtml(results);
  });
  context.subscriptions.push(runAllDisposable);

  // --- Configure ---
  context.subscriptions.push(
    vscode.commands.registerCommand('alloy.configure', async () => {
      const solver = await vscode.window.showQuickPick(
        ['sat4j', 'sat4j.light', 'sat4j.pmax', 'minisat', 'minisat.prover', 'glucose', 'lingeling.parallel'],
        { placeHolder: 'Choose SAT solver' }
      );
      if (!solver) return;

      const symmetry = await vscode.window.showInputBox({
        prompt: 'Symmetry breaking (default: 20)',
        value: String(vscode.workspace.getConfiguration('alloy').get('symmetry', 20))
      });
      if (symmetry === undefined) return;

      const skolemDepth = await vscode.window.showInputBox({
        prompt: 'Skolem depth (default: 0)',
        value: String(vscode.workspace.getConfiguration('alloy').get('skolemDepth', 0))
      });
      if (skolemDepth === undefined) return;

      const noOverflow = await vscode.window.showQuickPick(
        ['false', 'true'],
        { placeHolder: 'Disable arithmetic overflow?' }
      );
      if (!noOverflow) return;

      const unrolls = await vscode.window.showInputBox({
        prompt: 'Recursion unrolls (-1 = no limit)',
        value: String(vscode.workspace.getConfiguration('alloy').get('unrolls', -1))
      });
      if (unrolls === undefined) return;

      const config = vscode.workspace.getConfiguration('alloy');
      await config.update('solver', solver, vscode.ConfigurationTarget.Global);
      await config.update('symmetry', Number(symmetry), vscode.ConfigurationTarget.Global);
      await config.update('skolemDepth', Number(skolemDepth), vscode.ConfigurationTarget.Global);
      await config.update('noOverflow', noOverflow === 'true', vscode.ConfigurationTarget.Global);
      await config.update('unrolls', Number(unrolls), vscode.ConfigurationTarget.Global);

      // As restantes opções do menu Options do Analyzer estão nas settings (alloy.*)
      const choice = await vscode.window.showInformationMessage(
        `Alloy options saved: solver=${solver}, symmetry=${symmetry}`,
        'All options…'
      );
      if (choice) vscode.commands.executeCommand('workbench.action.openSettings', 'alloy.');
    })
  );

  // --- Show Metamodel ---
  context.subscriptions.push(
    vscode.commands.registerCommand('alloy.showMetamodel', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !editor.document.fileName.endsWith('.als')) {
        vscode.window.showErrorMessage('No .als file open.');
        return;
      }
      // O servidor lê o ficheiro do disco
      if (editor.document.isDirty) await editor.document.save();

      const fileName = editor.document.fileName.split(/[\\/]/).pop();
      const panel = vscode.window.createWebviewPanel(
        'alloyMetamodel',
        `Alloy Metamodel: ${fileName}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );
      panel.webview.html = getLoadingHtml();

      try {
        const response = await sendWithProgress(`Alloy Metamodel: ${fileName}`, {
          action: 'metamodel',
          file: editor.document.uri.fsPath,
          implicitThis: getAnalysisOptions().implicitThis
        });
        if (response.error) {
          panel.webview.html = getErrorHtml(response.error);
          return;
        }
        const groupColors: Record<string, string> = {};
        for (const n of response.nodes) {
          if (!groupColors[n.group]) groupColors[n.group] = paletteColor(Object.keys(groupColors).length);
        }
        panel.webview.html = getResultsHtml({ satisfiable: true }, 'Metamodel', 0, {
          nodes: response.nodes,
          links: response.links,
          groupColors
        });
      } catch (err: any) {
        panel.webview.html = err instanceof AnalysisAbortedError
          ? getCancelledHtml(err.message)
          : getErrorHtml('Error communicating with the Alloy Server.\n' + err.message);
      }
    })
  );

  // --- Restart Analysis Server ---
  // Também permite ao utilizador terminar à força uma análise que não termina
  context.subscriptions.push(
    vscode.commands.registerCommand('alloy.restartServer', () => restartAlloyServer())
  );

  // --- Message log, unsat core e Kodkod ---
  registerAnalysisFeatures(context);

  // --- Testing ---
  createAlloyTestController(context, sendToServer);

  // --- LSP ---
  startLspServer(context);

  // Arrancar o servidor Java
  setTimeout(() => {
    startAlloyServer();
  }, 2000);
  context.subscriptions.push({ dispose: () => { void stopAlloyServer(); } });
}

function startLspServer(context: vscode.ExtensionContext) {

  const alloyJarPath = vscode.workspace
    .getConfiguration('alloy')
    .get<string>('jarPath', '');

  if (!alloyJarPath || !fs.existsSync(alloyJarPath)) {
    vscode.window.showWarningMessage(
      'Alloy JAR not configured — LSP will not be activated.'
    );
    return;
  }

  const serverOptions = () => new Promise<StreamInfo>((resolve, reject) => {
    const server = net.createServer((socket) => {
      resolve({ reader: socket, writer: socket });
      server.close();
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      const port = address.port;

      vscode.window.showInformationMessage(`Alloy LSP connecting on port ${port}...`);

      const lspProcess = cp.spawn(
        'java',
        ['-jar', alloyJarPath, 'lsp', String(port)],
        { stdio: 'pipe' }
      );

      lspProcess.stderr.on('data', (data) => {
        console.error('Alloy LSP stderr:', data.toString());
      });

      lspProcess.on('error', (err) => {
        reject(err);
      });
    });
  });

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'alloy' }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.als')
    },
    middleware: {
      provideCodeLenses: () => [],
      provideDocumentLinks: () => []
    }
  };

  client = new LanguageClient(
    'alloyLsp',
    'Alloy Language Server',
    serverOptions,
    clientOptions
  );

  client.start();

  context.subscriptions.push(client);
}

export function deactivate(): Thenable<void> | undefined {
  void stopAlloyServer();
  if (!client) return undefined;
  return client.stop();
}

// --- HTML helpers ---

function getLoadingHtml(): string {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <style>
      body {
        font-family: var(--vscode-font-family);
        padding: 20px;
        color: var(--vscode-foreground);
        background-color: var(--vscode-editor-background);
      }
    </style>
  </head>
  <body>
    <h2>⏳ Running Alloy analysis...</h2>
    <p>Please wait while the solver processes the model.</p>
  </body>
  </html>`;
}

function getErrorHtml(message: string): string {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <style>
      body {
        font-family: var(--vscode-font-family);
        padding: 20px;
        color: var(--vscode-foreground);
        background-color: var(--vscode-editor-background);
      }
      pre {
        background: #3a0000;
        color: #ff8080;
        padding: 16px;
        border-radius: 6px;
        overflow-x: auto;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <h2>❌ Error</h2>
    <pre>${escapeHtml(message)}</pre>
  </body>
  </html>`;
}

function getCancelledHtml(message: string): string {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <style>
      body {
        font-family: var(--vscode-font-family);
        padding: 20px;
        color: var(--vscode-foreground);
        background-color: var(--vscode-editor-background);
      }
    </style>
  </head>
  <body>
    <h2>⏹ Analysis stopped</h2>
    <p>${escapeHtml(message)}</p>
  </body>
  </html>`;
}

// Grafo já construído (usado pelo Show Metamodel, que não passa pelo parseInstance)
type GraphData = {
  nodes: { id: string; group: string; labels: string[] }[];
  links: { source: string; target: string; label: string }[];
  groupColors: Record<string, string>;
};

// Cores dos grupos: palette fixa e, se houver mais grupos, tons gerados com o ângulo de ouro
const PALETTE = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2',
  '#59a14f', '#edc948', '#b07aa1', '#ff9da7',
  '#9c755f', '#bab0ac', '#86bcb6', '#d4a6c8'
];
function paletteColor(i: number): string {
  return i < PALETTE.length ? PALETTE[i] : `hsl(${Math.round((i * 137.5) % 360)}, 55%, 65%)`;
}

function getResultsHtml(response: any, commandLabel: string, currentState: number = 0, graph?: GraphData): string {
  const instanceText = response.instance || '';
  const sessionId = response.sessionId || '';
  const hasNext = response.hasNext || false;
  const hasPrevious = response.hasPrevious || false;
  const satisfiable = response.satisfiable || false;
  const isTemporal = response.isTemporal || false;
  const traceLength = response.traceLength || 1;
  const loopState = response.loopState ?? -1;
  const hasConfigs = response.hasConfigs || false;

  if (!satisfiable) {
    return `<!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8">
    <style>
      body { font-family: var(--vscode-font-family); padding: 20px;
             color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    </style></head>
    <body>
      <h2>❌ UNSAT</h2>
      <p>No instance found for: <strong>${escapeHtml(commandLabel)}</strong></p>
    </body></html>`;
  }

  const { nodes, links, groupColors } = graph ?? parseInstance(instanceText, currentState, response.subsetSigs || []);
  const nodesJson = JSON.stringify(nodes);
  const linksJson = JSON.stringify(links);
  const colorsJson = JSON.stringify(groupColors);

  let stateNav = '';
  if (isTemporal && traceLength > 1) {
    const stateButtons = [];
    for (let i = 0; i < traceLength; i++) {
      const isLoop = i === loopState;
      const isActive = i === currentState;
      stateButtons.push(
        `<button class="state-btn ${isActive ? 'active' : ''}" onclick="showState(${i})">
          State ${i}${isLoop ? ' ↺' : ''}
        </button>`
      );
    }
    stateNav = `<div id="state-nav">${stateButtons.join('')}</div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      overflow: hidden;
    }
    #toolbar {
      padding: 8px 16px;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      flex-wrap: wrap;
    }
    #legend { display: flex; gap: 12px; flex-wrap: wrap; }
    .legend-item { display: flex; align-items: center; gap: 4px; }
    .legend-dot { width: 10px; height: 10px; border-radius: 50%; }
    #nav-buttons { display: flex; gap: 4px; margin-left: auto; flex-wrap: wrap; }
    #state-nav { display: flex; gap: 4px; padding: 4px 16px;
                 background: var(--vscode-editorGroupHeader-tabsBackground);
                 border-bottom: 1px solid var(--vscode-panel-border); }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 3px 10px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    button.active {
      background: var(--vscode-button-hoverBackground);
      outline: 1px solid var(--vscode-focusBorder);
    }
    #graph { width: 100vw; }
    .node ellipse {
      stroke: #333;
      stroke-width: 2px;
      cursor: grab;
    }
    .node text {
      font-size: 13px;
      font-weight: bold;
      fill: #111;
      pointer-events: none;
      text-anchor: middle;
      dominant-baseline: central;
    }
    .link {
      stroke: #555;
      stroke-opacity: 0.8;
      stroke-width: 1.5px;
      fill: none;
    }
    .link-label {
      font-size: 12px;
      fill: #333;
      font-style: italic;
      pointer-events: none;
    }
  </style>
</head>
<body>
  <div id="toolbar">
    <strong>${graph ? 'Alloy Metamodel' : 'Alloy Instance'}</strong>
    <div id="legend"></div>
    <div id="nav-buttons" ${graph ? 'style="display:none"' : ''}>
      <button id="btn-previous" ${hasPrevious ? '' : 'disabled'} title="Previous instance">◀ Previous</button>
      <button id="btn-next" ${hasNext ? '' : 'disabled'} title="Next instance">Next ▶</button>
      <button id="btn-newTrace" ${hasNext ? '' : 'disabled'} title="New trace">New Trace</button>
      <button id="btn-newInit" ${hasNext ? '' : 'disabled'} title="New initial state">New Init</button>
      <button id="btn-newConfig" ${hasConfigs ? '' : 'disabled'} title="New configuration">New Config</button>
      <button id="btn-newFork" ${isTemporal ? '' : 'disabled'} title="New Fork">New Fork</button>
    </div>
  </div>
  ${stateNav}
  <svg id="graph"></svg>

  <script src="https://d3js.org/d3.v7.min.js"></script>
  <script>
    const vscode = acquireVsCodeApi();
    const sessionId = ${JSON.stringify(sessionId)};
    const instanceText = ${JSON.stringify(instanceText)};
    const isTemporal = ${isTemporal};
    let currentState = ${currentState};
    let nodes = ${nodesJson};
    let links = ${linksJson};
    const groupColors = ${colorsJson};

    const toolbarHeight = document.getElementById('toolbar').offsetHeight +
                          (document.getElementById('state-nav')?.offsetHeight || 0);
    const graphHeight = window.innerHeight - toolbarHeight;
    document.getElementById('graph').style.height = graphHeight + 'px';

    document.getElementById('btn-previous').addEventListener('click', () => {
      vscode.postMessage({ command: 'previous', sessionId });
    });
    document.getElementById('btn-next').addEventListener('click', () => {
      vscode.postMessage({ command: 'next', sessionId });
    });
    document.getElementById('btn-newTrace').addEventListener('click', () => {
      vscode.postMessage({ command: 'newTrace', sessionId });
    });
    document.getElementById('btn-newInit').addEventListener('click', () => {
      vscode.postMessage({ command: 'newInit', sessionId });
    });
    document.getElementById('btn-newConfig').addEventListener('click', () => {
      vscode.postMessage({ command: 'newConfig', sessionId });
    });
    document.getElementById('btn-newFork').addEventListener('click', () => {
      vscode.postMessage({ command: 'newFork', sessionId, stateIndex: currentState });
    });

    function showState(stateIndex) {
      currentState = stateIndex;
      document.querySelectorAll('.state-btn').forEach((btn, i) => {
        btn.classList.toggle('active', i === stateIndex);
      });
      vscode.postMessage({ command: 'showState', stateIndex, instanceText, sessionId });
    }

    const legend = document.getElementById('legend');
    const groups = [...new Set(nodes.map(n => n.group))];
    groups.forEach(g => {
      const item = document.createElement('div');
      item.className = 'legend-item';
      item.innerHTML = \`<div class="legend-dot" style="background:\${groupColors[g]}"></div><span>\${g}</span>\`;
      legend.appendChild(item);
    });

    const svg = d3.select('#graph');
    const width = window.innerWidth;
    const height = graphHeight;
    svg.attr('width', width).attr('height', height)
       .style('background', '#f8f8f8');

    // Node dimensions (ellipse)
    const RX = 38, RY = 22;

    const defs = svg.append('defs');
    defs.append('marker')
      .attr('id', 'arrow')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 10).attr('refY', 0)
      .attr('markerWidth', 7).attr('markerHeight', 7)
      .attr('orient', 'auto')
      .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', '#555');

    // Self-loop marker (slightly offset)
    defs.append('marker')
      .attr('id', 'arrow-self')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 10).attr('refY', 0)
      .attr('markerWidth', 7).attr('markerHeight', 7)
      .attr('orient', 'auto')
      .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', '#555');

    const g = svg.append('g');

    svg.call(d3.zoom().on('zoom', (event) => {
      g.attr('transform', event.transform);
    }));

    const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id).distance(160))
      .force('charge', d3.forceManyBody().strength(-500))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(60))
      .force('x', d3.forceX(width / 2).strength(0.05))
      .force('y', d3.forceY(height / 2).strength(0.05));

    // Separate self-loops from normal links
    const selfLinks = links.filter(l => l.source === l.target || (l.source.id && l.source.id === l.target.id));
    const normalLinks = links.filter(l => !(l.source === l.target || (l.source.id && l.source.id === l.target.id)));

    // Helper: intersection of line from center to point with ellipse boundary
    function ellipseIntersect(cx, cy, px, py) {
      const dx = px - cx, dy = py - cy;
      const d = Math.sqrt(dx*dx + dy*dy);
      if (d === 0) return { x: cx + RX, y: cy };
      const t = 1 / Math.sqrt((dx*dx)/(RX*RX) + (dy*dy)/(RY*RY));
      return { x: cx + dx*t, y: cy + dy*t };
    }

    const link = g.append('g').selectAll('path').data(normalLinks).join('path')
      .attr('class', 'link')
      .attr('marker-end', 'url(#arrow)');

    const linkLabel = g.append('g').selectAll('g').data(normalLinks).join('g');
    linkLabel.append('rect')
      .attr('fill', 'white').attr('rx', 3).attr('ry', 3).attr('opacity', 0.85);
    linkLabel.append('text')
      .attr('class', 'link-label')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .text(d => d.label);

    // Self-loop arcs
    const selfLink = g.append('g').selectAll('path').data(selfLinks).join('path')
      .attr('class', 'link')
      .attr('marker-end', 'url(#arrow-self)');

    const selfLabel = g.append('g').selectAll('g').data(selfLinks).join('g');
    selfLabel.append('rect').attr('fill', 'white').attr('rx', 3).attr('ry', 3).attr('opacity', 0.85);
    selfLabel.append('text')
      .attr('class', 'link-label')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .text(d => d.label);

    const node = g.append('g').selectAll('g').data(nodes).join('g').attr('class', 'node')
      .call(d3.drag()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x; d.fy = d.y;
        })
        .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null; d.fy = null;
        })
      );

    node.append('ellipse')
      .attr('rx', RX).attr('ry', RY)
      .attr('fill', d => groupColors[d.group] || '#76b7b2');
    node.append('text').text(d => d.labels.length ? \`\${d.id} (\${d.labels.join(', ')})\` : d.id);

    simulation.on('tick', () => {
      // Normal links as straight paths with ellipse-boundary endpoints
      link.attr('d', d => {
        const src = ellipseIntersect(d.source.x, d.source.y, d.target.x, d.target.y);
        const tgt = ellipseIntersect(d.target.x, d.target.y, d.source.x, d.source.y);
        return \`M\${src.x},\${src.y} L\${tgt.x},\${tgt.y}\`;
      });

      // Link labels centered on each edge with background rect
      linkLabel.attr('transform', d => {
        const mx = (d.source.x + d.target.x) / 2;
        const my = (d.source.y + d.target.y) / 2;
        return \`translate(\${mx},\${my})\`;
      });
      linkLabel.select('text').each(function() {
        const bbox = this.getBBox();
        d3.select(this.parentNode).select('rect')
          .attr('x', bbox.x - 3).attr('y', bbox.y - 2)
          .attr('width', bbox.width + 6).attr('height', bbox.height + 4);
      });

      // Self-loops as arcs above the node
      selfLink.attr('d', d => {
        const cx = d.source.x, cy = d.source.y;
        const x1 = cx - RX * 0.6, y1 = cy - RY;
        const x2 = cx + RX * 0.6, y2 = cy - RY;
        return \`M\${x1},\${y1} C\${x1},\${cy - RY*3} \${x2},\${cy - RY*3} \${x2},\${y2}\`;
      });

      selfLabel.attr('transform', d => {
        return \`translate(\${d.source.x},\${d.source.y - RY * 3.2})\`;
      });
      selfLabel.select('text').each(function() {
        const bbox = this.getBBox();
        d3.select(this.parentNode).select('rect')
          .attr('x', bbox.x - 3).attr('y', bbox.y - 2)
          .attr('width', bbox.width + 6).attr('height', bbox.height + 4);
      });

      node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
    });
  </script>
</body>
</html>`;
}

function parseInstance(instanceText: string, stateIndex: number = 0, subsetSigs: string[] = []): {
  nodes: { id: string; group: string; labels: string[] }[];
  links: { source: string; target: string; label: string }[];
  groupColors: Record<string, string>;
} {
  const nodes: { id: string; group: string; labels: string[] }[] = [];
  const links: { source: string; target: string; label: string }[] = [];
  const nodeIds = new Set<string>();
  const linkKeys = new Set<string>();
  const groupColors: Record<string, string> = {};
  let colorIndex = 0;
  const nextColor = () => paletteColor(colorIndex++);

  const BUILTIN = /^(univ|Int|seq\/Int|String|none)=/;
  // Átomo da sig interna do util/ordering (ex.: yo/Ord$0), que o Analyzer também esconde
  const isOrdAtom = (atom: string) => /(^|\/)Ord\$\d+$/.test(atom);
  const splitList = (s: string) => s.trim() ? s.split(',').map(x => x.trim()).filter(x => x) : [];
  const displayName = (full: string) => full.startsWith('this/') ? full.slice(5) : full;

  const addNode = (id: string) => {
    if (/^-?\d+$/.test(id) || isOrdAtom(id) || nodeIds.has(id)) return;
    const group = id.replace(/\$\d+$/, '');   // ex.: people/Student$0 -> people/Student
    if (!groupColors[group]) {
      groupColors[group] = nextColor();
    }
    nodes.push({ id, group, labels: [] });
    nodeIds.add(id);
  };

  const addLabel = (atom: string, label: string) => {
    addNode(atom);
    const n = nodes.find(n => n.id === atom);
    if (n && !n.labels.includes(label)) n.labels.push(label);
  };

  // Robust separator: handles variations in dash count (4–12), optional
  // trailing text after the state number, and surrounding whitespace.
  const stateBlocks = instanceText.split(/\s*-{4,}State\s+\d+[^\n-]*-{4,}\s*/i);
  const hasStates = stateBlocks.length > 1;
  const header = hasStates ? stateBlocks[0] : '';
  const targetBlock = hasStates
    ? (stateBlocks[stateIndex + 1] ?? stateBlocks[1])
    : stateBlocks[0];

  const lines = (header + '\n' + targetBlock).split('\n');

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || BUILTIN.test(line)) continue;

    // Skolems unários: skolem $canTakeThesis_s={people/Student$0} -> rótulo no átomo
    const skMatch = line.match(/^skolem\s+(\$[\w']+)=\{(.*)\}$/);
    if (skMatch) {
      for (const tuple of splitList(skMatch[2])) {
        if (!tuple.includes('->')) addLabel(tuple, skMatch[1]);
      }
      continue;
    }

    // Relações: owner<:field={a->b, a->b->c, ...}
    const relMatch = line.match(/^([\w$\/]+)<:([\w$']+)=\{(.*)\}$/);
    if (relMatch) {
      const isOrdField = /(^|\/)Ord$/.test(relMatch[1]);
      const relName = isOrdField ? relMatch[2].toLowerCase() : relMatch[2];
      for (const tuple of splitList(relMatch[3])) {
        let parts = tuple.split('->').map(p => p.trim());
        // util/ordering: descartar o átomo Ord (ex.: Ord$0->Year$0->Year$1 vira Year$0 -> Year$1)
        if (isOrdAtom(parts[0])) parts = parts.slice(1);

        if (parts.length === 1) {          // ex.: First do ordering -> rótulo "first"
          addLabel(parts[0], relName);
          continue;
        }
        const source = parts[0];
        const target = parts[parts.length - 1];
        const middle = parts.slice(1, -1); // relações n-árias: átomos do meio no rótulo
        const label = middle.length ? `${relName} [${middle.join(', ')}]` : relName;
        const key = `${source}|${target}|${label}`;
        if (linkKeys.has(key)) continue;
        linkKeys.add(key);
        addNode(source);
        addNode(target);
        links.push({ source, target, label });
      }
      continue;
    }

    // Sigs: this/Year={...}, people/Student={...}
    const sigMatch = line.match(/^([\w$\/]+)=\{(.*)\}$/);
    if (sigMatch) {
      const full = sigMatch[1];
      if (/(^|\/)Ord$/.test(full)) continue;          // sig interna do util/ordering
      const isSubset = subsetSigs.includes(full);
      for (const atom of splitList(sigMatch[2])) {
        addNode(atom);
        if (isSubset) addLabel(atom, displayName(full));
      }
    }
  }

  return { nodes, links, groupColors };
}

class AlloyDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(
    session: vscode.DebugSession
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterInlineImplementation(new AlloyDebugSession());
  }
}

function getSummaryHtml(results: { label: string; response: any; index: number }[]): string {
  const rows = results.map(r => {
    // Comando interrompido (Cancel ou tempo limite) ou que ficou por correr
    if (r.response.stopped || r.response.notRun) {
      const stopped = !!r.response.stopped;
      return `
      <tr>
        <td>${stopped ? '⏹' : '⏭'}</td>
        <td>${escapeHtml(r.label)}</td>
        <td class="status skipped">${stopped ? 'Stopped' : 'Not run'}</td>
        <td class="first-result">${escapeHtml(stopped ? r.response.message : 'Run All was cancelled before this command')}</td>
      </tr>
    `;
    }

    const sat = r.response.satisfiable;
    const error = r.response.error;
    const isCheck = r.label.trim().startsWith('check');

    // Extrair o expect do label
    const expectMatch = r.label.match(/expect\s+(\d+)/);
    const expectValue = expectMatch ? parseInt(expectMatch[1]) : null;
    const expectSat = expectValue !== null ? expectValue > 0 : null;

    // Determinar se passou ou falhou com base no expect
    let passed: boolean;
    if (error) {
      passed = false;
    } else if (isCheck) {
      const shouldBeSat = expectSat === true;
      passed = shouldBeSat ? sat : !sat;
    } else {
      const shouldBeSat = expectSat !== false; // default é SAT
      passed = shouldBeSat ? sat : !sat;
    }

    const icon = error ? '⚠️' : (passed ? '✅' : '❌');
    const status = error ? 'Error' : (sat ? 'SAT' : 'UNSAT');

    // Extrair primeiro resultado da instância
    let firstResult = '';
    if (!error && r.response.instance) {
      const instanceText = r.response.instance;
      if (sat) {
        const stateBlocks = instanceText.split(/\s*-{4,}State\s+\d+[^\n-]*-{4,}\s*/i);
        const hasStates = stateBlocks.length > 1;
        const header = hasStates ? stateBlocks[0] : '';
        const firstState = hasStates ? stateBlocks[1] : stateBlocks[0];
        const relevantLines = (header + '\n' + firstState).split('\n')
          .filter((line: string) => {
            const l = line.trim();
            // Accepts sigs and fields of any module (this/, people/, ...)
            // excludes predefined lines (univ, Int, seq/Int, String, none)
            return /^[\w$\/]+(<:[\w$']+)?=\{/.test(l) &&
                   !/^(univ|Int|seq\/Int|String|none)=/.test(l);
          })
          .map((line: string) => line.trim())
          .join(', ');
        firstResult = relevantLines || '{}';
        if (isCheck) {
          firstResult = `Counterexample: ${firstResult}`;
        }
      } else if (isCheck) {
        firstResult = 'Property verified within scope';
      } else {
        firstResult = 'No instance found';
      }
    }

    return `
      <tr>
        <td>${icon}</td>
        <td>${escapeHtml(r.label)}</td>
        <td class="status ${passed ? 'sat' : 'unsat'}">${status}</td>
        <td class="first-result">${escapeHtml(firstResult)}</td>
      </tr>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    h2 { margin-bottom: 16px; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th {
      text-align: left;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      color: var(--vscode-foreground);
      opacity: 0.7;
    }
    td {
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      vertical-align: top;
    }
    .status.sat { color: #4ec9b0; }
    .status.unsat { color: #f48771; }
    .status.error { color: #f48771; }
    .status.skipped { opacity: 0.7; }
    .first-result {
      font-size: 11px;
      opacity: 0.8;
      max-width: 400px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <h2>Alloy — Run All Results</h2>
  <table>
    <thead>
      <tr>
        <th></th>
        <th>Command</th>
        <th>Result</th>
        <th>First Instance</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}