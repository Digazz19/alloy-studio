import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';

// Gestão do processo do Alloy Analysis Server e comunicação com ele.
//
// Uma análise a correr no servidor só pode ser interrompida de forma fiável
// terminando o processo: o Kodkod/Pardinus não verifica interrupções durante
// a resolução, e os solvers nativos (MiniSat, Glucose, ...) nem sequer correm
// em Java. O Alloy Analyzer faz o mesmo: cada análise corre num processo
// separado, que o botão Stop destrói (WorkerEngine.stop()).
// Quando uma análise é cancelada, ou excede o tempo limite, o servidor é
// reiniciado, e as sessões que estavam abertas deixam de existir.

export const ALLOY_SERVER_PORT = 5050;

let serverProcess: cp.ChildProcess | undefined;

/** Erro de um pedido interrompido (cancelado pelo utilizador ou por tempo limite). */
export class AnalysisAbortedError extends Error { }

// Arrancar o servidor Java
export function startAlloyServer(quiet: boolean = false): void {
  const serverJarPath = vscode.workspace
    .getConfiguration('alloy')
    .get<string>('serverJarPath', '');

  if (!serverJarPath || !fs.existsSync(serverJarPath)) {
    vscode.window.showWarningMessage(
      'Alloy Server JAR not configured — instance navigation will not be available.'
    );
    return;
  }

  const proc = cp.spawn(
    'java',
    ['-jar', serverJarPath, String(ALLOY_SERVER_PORT)],
    { stdio: 'pipe' }
  );
  serverProcess = proc;

  proc.stdout?.on('data', (data) => {
    console.log('Alloy Server:', data.toString());
  });

  proc.stderr?.on('data', (data) => {
    console.error('Alloy Server error:', data.toString());
  });

  proc.on('error', (err) => {
    vscode.window.showErrorMessage('Error starting Alloy Server: ' + err.message);
  });

  proc.on('exit', () => {
    if (serverProcess === proc) serverProcess = undefined;
  });

  if (!quiet) vscode.window.showInformationMessage('Alloy Analysis Server initialized.');
}

// Terminar o servidor e esperar que o processo saia (para libertar a porta)
export function stopAlloyServer(): Promise<void> {
  const proc = serverProcess;
  serverProcess = undefined;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    const forceKill = setTimeout(() => proc.kill('SIGKILL'), 3000);
    proc.once('exit', () => {
      clearTimeout(forceKill);
      resolve();
    });
    proc.kill();
  });
}

let restarting: Promise<void> | undefined;

// Reiniciar o servidor; vários pedidos interrompidos ao mesmo tempo partilham o mesmo reinício
export function restartAlloyServer(reason?: string): Promise<void> {
  if (!restarting) {
    restarting = (async () => {
      await stopAlloyServer();
      startAlloyServer(true);
      vscode.window.showWarningMessage(
        (reason ? reason + ' ' : '') +
        'The Alloy Analysis Server was restarted; open analysis sessions were closed.'
      );
    })().finally(() => { restarting = undefined; });
  }
  return restarting;
}

// Enviar um pedido ao servidor Java.
// - token: cancelar o pedido (o que termina a análise, reiniciando o servidor);
// - alloy.timeout (segundos, 0 = sem limite): tempo máximo de espera, com o mesmo efeito;
// - se o servidor fechar a ligação sem responder, o pedido falha em vez de ficar pendurado.
export function sendToServer(
  request: object,
  token?: vscode.CancellationToken,
  retries: number = 5,
  delay: number = 1000
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (token?.isCancellationRequested) {
      reject(new AnalysisAbortedError('Request cancelled.'));
      return;
    }

    let settled = false;
    let socket: net.Socket | undefined;
    let timer: NodeJS.Timeout | undefined;
    let cancelSubscription: vscode.Disposable | undefined;

    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cancelSubscription?.dispose();
      socket?.destroy();
      action();
    };

    // Interromper: rejeitar o pedido e terminar a análise, reiniciando o servidor
    const abort = (message: string) => {
      settle(() => reject(new AnalysisAbortedError(message)));
      void restartAlloyServer(message);
    };

    if (token) {
      cancelSubscription = token.onCancellationRequested(() => abort('Analysis cancelled.'));
    }

    const timeoutSeconds = vscode.workspace.getConfiguration('alloy').get<number>('timeout', 0);
    if (timeoutSeconds > 0) {
      timer = setTimeout(
        () => abort(`Analysis exceeded the time limit of ${timeoutSeconds} s.`),
        timeoutSeconds * 1000
      );
    }

    const attempt = (remainingRetries: number) => {
      if (settled) return;
      const s = new net.Socket();
      socket = s;
      let data = '';
      let connected = false;

      s.connect(ALLOY_SERVER_PORT, '127.0.0.1', () => {
        connected = true;
        s.write(JSON.stringify(request) + '\n');
      });

      s.on('data', (chunk) => {
        data += chunk.toString();
        try {
          const response = JSON.parse(data);
          settle(() => resolve(response));
        } catch {
          // ainda a receber dados
        }
      });

      s.on('error', (err) => {
        if (settled) return;
        s.destroy();
        // Só repetir se ainda não estava ligado (ex.: o servidor ainda está a arrancar)
        if (!connected && remainingRetries > 0) {
          setTimeout(() => attempt(remainingRetries - 1), delay);
        } else {
          settle(() => reject(err));
        }
      });

      s.on('close', () => {
        if (!settled && connected) {
          settle(() => reject(new Error('The Alloy Analysis Server closed the connection without responding.')));
        }
      });
    };

    attempt(retries);
  });
}

// Enviar um pedido que pode demorar (execute, next, new*, ...). Se o pedido demorar mais
// do que delayMs, aparece uma notificação de progresso com botão Cancel, que fica até o
// pedido terminar; os pedidos rápidos não mostram nada (a notificação não pisca).
// extraToken permite cancelar também por outra via (ex.: o utilizador parar a sessão de debug).
export function sendWithProgress(
  title: string,
  request: object,
  extraToken?: vscode.CancellationToken,
  delayMs: number = 1000
): Promise<any> {
  const source = new vscode.CancellationTokenSource();
  const subscriptions: vscode.Disposable[] = [];
  let done = false;

  if (extraToken) subscriptions.push(extraToken.onCancellationRequested(() => source.cancel()));

  const pending = sendToServer(request, source.token);

  const timer = setTimeout(() => {
    if (done) return;
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      (_progress, token) => {
        if (!done) subscriptions.push(token.onCancellationRequested(() => source.cancel()));
        // A notificação fecha quando o pedido terminar, com sucesso ou não
        return pending.catch(() => undefined);
      }
    );
  }, delayMs);

  return pending.finally(() => {
    done = true;
    clearTimeout(timer);
    subscriptions.forEach(s => s.dispose());
    source.dispose();
  });
}