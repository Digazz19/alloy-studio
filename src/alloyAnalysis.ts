import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Funcionalidades comuns a todos os pontos de entrada da análise (Run, Run All, F5 e testes):
// - as opções de análise, lidas das settings (equivalentes ao menu Options do Analyzer);
// - o message log do Analyzer, num canal de Output "Alloy";
// - o realce do unsat core no editor;
// - o problema Kodkod gravado (Record the Kodkod input/output).

// --- Opções de análise ---

export interface AnalysisOptions {
  solver: string;
  symmetry: number;
  skolemDepth: number;
  noOverflow: boolean;
  unrolls: number;
  decomposeMode: number;
  inferPartialInstance: boolean;
  implicitThis: boolean;
  allowWarnings: boolean;
  recordKodkod: boolean;
  coreMinimization: number;
  coreGranularity: number;
}

export function getAnalysisOptions(): AnalysisOptions {
  const c = vscode.workspace.getConfiguration('alloy');
  return {
    solver: c.get('solver', 'sat4j'),
    symmetry: c.get('symmetry', 20),
    skolemDepth: c.get('skolemDepth', 0),
    noOverflow: c.get('noOverflow', false),
    unrolls: c.get('unrolls', -1),
    decomposeMode: c.get('decomposeMode', 0),
    inferPartialInstance: c.get('inferPartialInstance', false),
    implicitThis: c.get('implicitThis', false),
    allowWarnings: c.get('allowWarnings', false),
    recordKodkod: c.get('recordKodkod', false),
    coreMinimization: c.get('coreMinimization', 2),
    coreGranularity: c.get('coreGranularity', 0)
  };
}

// --- Message log ---

let output: vscode.OutputChannel | undefined;

function getOutput(): vscode.OutputChannel {
  if (!output) output = vscode.window.createOutputChannel('Alloy');
  return output;
}

// Escrever no canal "Alloy" o que o Analyzer escreve no message log (scopes, solver,
// tamanho do problema, tempos, resultado e comparação com o expect) e os warnings.
// reveal: mostrar o canal (sem tirar o foco do editor), como o log sempre visível do Analyzer.
export function reportAnalysis(commandLabel: string, response: any, reveal: boolean = false): void {
  const out = getOutput();
  out.appendLine(`=== ${commandLabel} ===`);
  for (const line of response.log ?? []) out.appendLine('  ' + line);
  if (response.error) out.appendLine('  Error: ' + response.error);
  if (response.unsatCore) {
    out.appendLine('  The unsat core is highlighted in the editor.');
  } else if (response.satisfiable === false && !response.error) {
    out.appendLine(response.coreSupported
      ? '  No unsat core was returned by the solver.'
      : '  (Select the minisat.prover solver to obtain an unsat core.)');
  }
  if (response.kodkod) out.appendLine('  Kodkod input recorded: run "Alloy: Show Kodkod Input" to open it.');
  out.appendLine('');
  if (reveal) out.show(true);
}

// Texto dos warnings, para mostrar quando bloqueiam a execução
export function formatWarnings(response: any): string {
  return (response.warnings ?? [])
    .map((w: any) => `${path.basename(w.file || '')}:${w.line}:${w.col}: ${w.message}`)
    .join('\n');
}

// --- Unsat core ---

const coreDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(255, 80, 80, 0.30)',
  overviewRulerColor: 'rgba(255, 80, 80, 0.8)',
  overviewRulerLane: vscode.OverviewRulerLane.Right
});
const subCoreDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(255, 170, 60, 0.22)'
});

let currentCore: { core: any[]; subCore: any[] } | undefined;

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    try { return fs.realpathSync(p); } catch { return path.resolve(p); }
  };
  return norm(a) === norm(b);
}

// Posições do Alloy: linhas e colunas a partir de 1, fim inclusivo
function toRange(p: any): vscode.Range {
  return new vscode.Range(p.line - 1, Math.max(p.col - 1, 0), p.endLine - 1, p.endCol);
}

function applyCore(editor: vscode.TextEditor): void {
  if (!currentCore) {
    editor.setDecorations(coreDecoration, []);
    editor.setDecorations(subCoreDecoration, []);
    return;
  }
  const file = editor.document.uri.fsPath;
  const hover = new vscode.MarkdownString('Part of the **unsat core**');
  const pick = (positions: any[]) => positions
    .filter(p => p.file && samePath(p.file, file))
    .map(p => ({ range: toRange(p), hoverMessage: hover }));
  editor.setDecorations(coreDecoration, pick(currentCore.core));
  editor.setDecorations(subCoreDecoration, pick(currentCore.subCore));
}

// Realçar o unsat core da resposta (ou limpar o realce anterior, se não houver core)
export function showUnsatCore(response: any): void {
  currentCore = response?.unsatCore;
  vscode.window.visibleTextEditors.forEach(applyCore);
}

export function clearUnsatCore(): void {
  if (!currentCore) return;
  currentCore = undefined;
  vscode.window.visibleTextEditors.forEach(applyCore);
}

// --- Kodkod ---

let lastKodkod: { label: string; source: string } | undefined;

export function storeKodkod(commandLabel: string, response: any): void {
  if (response.kodkod) lastKodkod = { label: commandLabel, source: response.kodkod };
}

// --- Registo ---

export function registerAnalysisFeatures(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    coreDecoration,
    subCoreDecoration,
    { dispose: () => output?.dispose() },
    // O core refere-se a uma versão do modelo: deixa de ser válido quando o modelo muda
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.fsPath.endsWith('.als') && e.contentChanges.length > 0) clearUnsatCore();
    }),
    // Realçar também nos editores que se abrem depois (ex.: um módulo importado)
    vscode.window.onDidChangeVisibleTextEditors(editors => editors.forEach(applyCore)),
    vscode.commands.registerCommand('alloy.clearUnsatCore', () => clearUnsatCore()),
    vscode.commands.registerCommand('alloy.showKodkod', async () => {
      if (!lastKodkod) {
        vscode.window.showInformationMessage(
          'No Kodkod input recorded. Enable the alloy.recordKodkod setting and execute a command.'
        );
        return;
      }
      const doc = await vscode.workspace.openTextDocument({
        content: `// Kodkod input for: ${lastKodkod.label}\n\n${lastKodkod.source}`,
        language: 'java'
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    })
  );
}