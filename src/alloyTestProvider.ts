import * as vscode from 'vscode';
import * as path from 'path';

export function createAlloyTestController(
  context: vscode.ExtensionContext,
  sendToServer: (request: object, token?: vscode.CancellationToken) => Promise<any>
): vscode.TestController {

  const controller = vscode.tests.createTestController(
    'alloyTestController',
    'Alloy Tests'
  );

  context.subscriptions.push(controller);

  // Perfil de execução
  controller.createRunProfile(
    'Run',
    vscode.TestRunProfileKind.Run,
    async (request, token) => {
      await runTests(request, token);
    },
    true
  );

  // Descobrir testes quando um ficheiro .als é aberto
  vscode.workspace.onDidOpenTextDocument(doc => {
    if (doc.uri.fsPath.endsWith('.als')) {
      discoverTests(doc);
    }
  });

  // Descobrir testes nos ficheiros já abertos
  vscode.workspace.textDocuments.forEach(doc => {
    if (doc.uri.fsPath.endsWith('.als')) {
      discoverTests(doc);
    }
  });

  // Atualizar testes quando o ficheiro muda
  vscode.workspace.onDidChangeTextDocument(event => {
    if (event.document.uri.fsPath.endsWith('.als')) {
      discoverTests(event.document);
    }
  });

  function discoverTests(doc: vscode.TextDocument) {
    const filePath = doc.uri.fsPath;
    const fileName = path.basename(filePath);

    let fileItem = controller.items.get(filePath);
    if (!fileItem) {
      fileItem = controller.createTestItem(filePath, fileName, doc.uri);
      controller.items.add(fileItem);
    }

    fileItem.children.replace([]);

    const lines = doc.getText().split('\n');
    let commandIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('run') || line.startsWith('check')) {
        const id = `${filePath}::${commandIndex}`;
        const testItem = controller.createTestItem(id, line, doc.uri);
        testItem.range = new vscode.Range(i, 0, i, line.length);
        (testItem as any).__commandIndex = commandIndex;
        (testItem as any).__filePath = filePath;
        (testItem as any).__isCheck = line.startsWith('check');
        fileItem!.children.add(testItem);
        commandIndex++;
      }
    }
  }

  // Extrair linhas relevantes da instância (cabeçalho estático + primeiro estado)
  function extractRelevantLines(instanceText: string): string {
    const stateBlocks = instanceText.split(/\s*-{4,}State\s+\d+[^\n-]*-{4,}\s*/i);
    const hasStates = stateBlocks.length > 1;
    const header = hasStates ? stateBlocks[0] : '';
    const firstState = hasStates ? stateBlocks[1] : stateBlocks[0];
    return (header + '\n' + firstState).split('\n')
      .filter((line: string) => {
        const l = line.trim();
        return /^[\w$\/]+(<:[\w$']+)?=\{/.test(l) &&
               !/^(univ|Int|seq\/Int|String|none)=/.test(l);
      })
      .map((line: string) => line.trim())
      .join('\n');
  }

  async function runTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken
  ) {
    const run = controller.createTestRun(request);
    const alloyConfig = vscode.workspace.getConfiguration('alloy');

    const testsToRun: vscode.TestItem[] = [];

    if (request.include) {
      request.include.forEach(item => {
        if (item.children.size > 0) {
          item.children.forEach(child => testsToRun.push(child));
        } else {
          testsToRun.push(item);
        }
      });
    } else {
      controller.items.forEach(fileItem => {
        fileItem.children.forEach(child => testsToRun.push(child));
      });
    }

    for (const testItem of testsToRun) {
      if (token.isCancellationRequested) break;

      run.started(testItem);

      const filePath = (testItem as any).__filePath;
      const commandIndex = (testItem as any).__commandIndex;
      const isCheck = (testItem as any).__isCheck;

      // Extrair o valor do expect do label do comando
      // expect 1 = espera SAT, expect 0 = espera UNSAT
      const expectMatch = testItem.label.match(/expect\s+(\d+)/);
      const expectValue = expectMatch ? parseInt(expectMatch[1]) : null;
      const expectSat = expectValue !== null ? expectValue > 0 : null;

      try {
        const start = Date.now();
        const response = await sendToServer({
          action: 'execute',
          file: filePath,
          commandIndex,
          solver: alloyConfig.get('solver', 'sat4j'),
          symmetry: alloyConfig.get('symmetry', 20),
          skolemDepth: alloyConfig.get('skolemDepth', 0),
          noOverflow: alloyConfig.get('noOverflow', false),
          unrolls: alloyConfig.get('unrolls', -1),
          decomposeMode: 0
        }, token);   // cancelar no Testing panel interrompe a análise em curso
        const duration = Date.now() - start;

        if (response.error) {
          run.failed(testItem, new vscode.TestMessage(response.error), duration);
          run.appendOutput(`❌ ${testItem.label}\r\n`);
          run.appendOutput(`Error: ${response.error}\r\n\r\n`);
          continue;
        }

        const relevantLines = response.instance
          ? extractRelevantLines(response.instance)
          : '';

        if (isCheck) {
          // check: por defeito passa se UNSAT (propriedade verificada)
          // com expect 0: passa se UNSAT
          // com expect 1: passa se SAT (contraexemplo esperado)
          const shouldBeSat = expectSat === true;
          const passed = shouldBeSat ? response.satisfiable : !response.satisfiable;

          if (passed) {
            run.passed(testItem, duration);
            run.appendOutput(`✅ ${testItem.label}\r\n`);
            run.appendOutput(`─────────────────────────────\r\n`);
            if (response.satisfiable) {
              run.appendOutput(`Counterexample found (expected):\r\n`);
              relevantLines.split('\n').forEach((line: string) => {
                if (line.trim()) run.appendOutput(`  ${line.trim()}\r\n`);
              });
            } else {
              run.appendOutput(`Property verified within scope.\r\n`);
            }
            run.appendOutput(`\r\n`);
          } else {
            if (response.satisfiable) {
              const msg = `Counterexample found but expected UNSAT (expect 0):\n\n${relevantLines}`;
              run.failed(testItem, new vscode.TestMessage(msg), duration);
              run.appendOutput(`❌ ${testItem.label}\r\n`);
              run.appendOutput(`─────────────────────────────\r\n`);
              run.appendOutput(`Counterexample found but expected UNSAT:\r\n`);
              relevantLines.split('\n').forEach((line: string) => {
                if (line.trim()) run.appendOutput(`  ${line.trim()}\r\n`);
              });
            } else {
              const msg = `Expected counterexample (expect 1) but property was verified (UNSAT)`;
              run.failed(testItem, new vscode.TestMessage(msg), duration);
              run.appendOutput(`❌ ${testItem.label}\r\n`);
              run.appendOutput(`Expected counterexample but property was verified.\r\n`);
            }
            run.appendOutput(`\r\n`);
          }
        } else {
          // run: por defeito passa se SAT (instância encontrada)
          // com expect 1: passa se SAT
          // com expect 0: passa se UNSAT
          const shouldBeSat = expectSat !== false; // default é SAT
          const passed = shouldBeSat ? response.satisfiable : !response.satisfiable;

          if (passed) {
            run.passed(testItem, duration);
            run.appendOutput(`✅ ${testItem.label}\r\n`);
            run.appendOutput(`─────────────────────────────\r\n`);
            if (response.satisfiable) {
              run.appendOutput(`First instance:\r\n`);
              relevantLines.split('\n').forEach((line: string) => {
                if (line.trim()) run.appendOutput(`  ${line.trim()}\r\n`);
              });
            } else {
              run.appendOutput(`UNSAT (expected).\r\n`);
            }
            run.appendOutput(`\r\n`);
          } else {
            if (response.satisfiable) {
              const msg = `Instance found but expected UNSAT (expect 0):\n\n${relevantLines}`;
              run.failed(testItem, new vscode.TestMessage(msg), duration);
              run.appendOutput(`❌ ${testItem.label}\r\n`);
              run.appendOutput(`Instance found but expected UNSAT.\r\n\r\n`);
            } else {
              run.failed(
                testItem,
                new vscode.TestMessage('No instance found — UNSAT'),
                duration
              );
              run.appendOutput(`❌ ${testItem.label}\r\n`);
              run.appendOutput(`No instance found — UNSAT.\r\n\r\n`);
            }
          }
        }

      } catch (err: any) {
        run.failed(testItem, new vscode.TestMessage(err.message));
        run.appendOutput(`❌ ${testItem.label}\r\n`);
        run.appendOutput(`Error: ${err.message}\r\n\r\n`);
      }
    }

    run.end();
  }

  return controller;
}