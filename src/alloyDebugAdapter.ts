import * as vscode from 'vscode';
import {
  LoggingDebugSession,
  InitializedEvent,
  StoppedEvent,
  TerminatedEvent,
  InvalidatedEvent,
  OutputEvent,
  StackFrame,
  Scope,
  Source,
  Variable,
  Thread
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { alloyState } from './alloyState';
import * as net from 'net';

const ALLOY_SERVER_PORT = 5050;

interface AlloyLaunchArgs extends DebugProtocol.LaunchRequestArguments {
  file: string;
  commandIndex: number;
  commandLabel: string;
  solver?: string;
  symmetry?: number;
  skolemDepth?: number;
  noOverflow?: boolean;
  unrolls?: number;
  decomposeMode?: number;
}

export class AlloyDebugSession extends LoggingDebugSession {

  private sessionId: string = '';
  private currentInstance: any = null;
  private commandLabel: string = '';
  private file: string = '';
  private commandIndex: number = 0;
  private currentStateIndex: number = 0;

  public constructor() {
    super();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
  }

  // Inicialização
  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    args: DebugProtocol.InitializeRequestArguments
  ): void {
    response.body = response.body || {};
    response.body.supportsStepBack = true;
    response.body.supportsRestartRequest = true;
    response.body.supportsTerminateRequest = true;
    response.body.supportsEvaluateForHovers = true;

    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  // Lançar sessão de debug
  protected async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: AlloyLaunchArgs
  ): Promise<void> {
    this.file = args.file;
    this.commandIndex = args.commandIndex;
    this.commandLabel = args.commandLabel;
    this.currentStateIndex = 0;

    if (this.commandIndex === -1) {
      setTimeout(() => {
        vscode.commands.executeCommand('alloy.runAll');
      }, 100);
      this.sendResponse(response);
      this.sendEvent(new TerminatedEvent());
      return;
    }

    try {
      const result = await this.sendToServer({
        action: 'execute',
        file: this.file,
        commandIndex: this.commandIndex,
        solver: args.solver || '',
        symmetry: Number(args.symmetry) ?? 20,
        skolemDepth: Number(args.skolemDepth) ?? 0,
        noOverflow: args.noOverflow === true || String(args.noOverflow) === 'true',
        unrolls: Number(args.unrolls) ?? -1,
        decomposeMode: args.decomposeMode ?? 0
      });

      if (result.error) {
        this.sendErrorResponse(response, 1, result.error);
        return;
      }

      this.sessionId = result.sessionId;
      this.currentInstance = result;

      alloyState.setInstance({
        sessionId: this.sessionId,
        instance: result.instance,
        isTemporal: result.isTemporal,
        traceLength: result.traceLength,
        loopState: result.loopState,
        hasConfigs: result.hasConfigs,
        hasNext: result.hasNext,
        hasPrevious: result.hasPrevious || false,
        satisfiable: result.satisfiable,
        commandLabel: this.commandLabel,
        currentStateIndex: 0
      });

      this.sendResponse(response);
      this.sendEvent(new StoppedEvent('entry', 1));

    } catch (err: any) {
      this.sendErrorResponse(response, 1, err.message);
    }
  }

  // Threads — Alloy tem sempre um thread
  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = {
      threads: [new Thread(1, 'Alloy Analysis')]
    };
    this.sendResponse(response);
  }

  // Stack frames — estados da trace
  protected stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments
  ): void {
    if (!this.currentInstance) {
      response.body = { stackFrames: [], totalFrames: 0 };
      this.sendResponse(response);
      return;
    }

    const traceLength = this.currentInstance.traceLength || 1;
    const loopState = this.currentInstance.loopState || -1;
    const commandLine = this.getCommandLine();
    const frames: StackFrame[] = [];

    // O estado atual fica no topo; por baixo, os estados anteriores (como uma call stack)
    for (let i = this.currentStateIndex; i >= 0; i--) {
      const isLoop = i === loopState;
      frames.push(new StackFrame(
        i,
        `State ${i}${isLoop ? ' ↺' : ''}`,
        new Source(this.file, this.file),
        commandLine
      ));
    }

    response.body = {
      stackFrames: frames,
      totalFrames: frames.length
    };
    this.sendResponse(response);
  }

  private getCommandLine(): number {
    try {
      const fs = require('fs');
      const content = fs.readFileSync(this.file, 'utf8');
      const lines = content.split('\n');
      let commandCount = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('run') || line.startsWith('check')) {
          if (commandCount === this.commandIndex) {
            return i + 1; 
          }
          commandCount++;
        }
      }
    } catch (e) {
      console.error('Error reading file:', e);
    }
    return 1;
  }

  // Scopes — agrupamento de variáveis
  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments
  ): void {
    // Não atualizar currentStateIndex aqui — usar frameId nas variáveis
    response.body = {
      scopes: [
        new Scope('Atoms', args.frameId * 2 + 1, false),
        new Scope('Relations', args.frameId * 2 + 2, false)
      ]
    };
    this.sendResponse(response);
  }

  // Variáveis — átomos e relações do estado atual
  protected variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments
  ): void {
    if (!this.currentInstance) {
      response.body = { variables: [] };
      this.sendResponse(response);
      return;
    }

    const instanceText = this.currentInstance.instance || '';
    // Extrair o frameId do variablesReference
    const frameId = Math.floor((args.variablesReference - 1) / 2);
    const scope = args.variablesReference % 2 === 1 ? 1 : 2; // 1=Atoms, 2=Relations

    const variables = this.parseVariables(instanceText, frameId, scope);
    response.body = { variables };
    this.sendResponse(response);
  }

  // Next — próxima instância (Step Over)
  protected async nextRequest(
    response: DebugProtocol.NextResponse,
    args: DebugProtocol.NextArguments
  ): Promise<void> {
    await this.navigate(this.currentInstance?.isTemporal ? 'newFork' : 'next', response);
  }

  // Step Back — New Init
  protected async stepBackRequest(
    response: DebugProtocol.StepBackResponse,
    args: DebugProtocol.StepBackArguments
  ): Promise<void> {
    await this.navigate('previous', response);
  }

  // Restart — New Trace
  protected async restartRequest(
    response: DebugProtocol.RestartResponse,
    args: DebugProtocol.RestartArguments
  ): Promise<void> {
    await this.navigate('newTrace', response);
  }

  // Continue — New Fork
  protected async continueRequest(
    response: DebugProtocol.ContinueResponse,
    args: DebugProtocol.ContinueArguments
  ): Promise<void> {
    await this.navigate('next', response);
  }

  private async navigate(action: string, response: any): Promise<void> {
    try {
      const result = await this.sendToServer({
        action,
        sessionId: this.sessionId,
        stateIndex: this.currentStateIndex
      });

      if (result.error) {
        this.sendErrorResponse(response, 1, result.error);
        return;
      }

      if (result.noMoreInstances || result.noPreviousInstance) {
        this.sendEvent(new OutputEvent(
          result.noMoreInstances 
            ? 'No more instances available.\n' 
            : 'No previous instance available.\n',
          'console'
        ));
        this.sendResponse(response);
        this.sendEvent(new StoppedEvent('step', 1));
        return;
      }

      this.currentInstance = result;

      if (action === 'newFork') {
        const maxState = (result.traceLength || 1) - 1;
        this.currentStateIndex = Math.min(this.currentStateIndex, maxState);
      } else {
        this.currentStateIndex = 0;
      }

      alloyState.setInstance({
        sessionId: this.sessionId,
        instance: result.instance,
        isTemporal: result.isTemporal,
        traceLength: result.traceLength,
        loopState: result.loopState,
        hasConfigs: result.hasConfigs,
        hasNext: result.hasNext,
        hasPrevious: result.hasPrevious || false,
        satisfiable: result.satisfiable,
        commandLabel: this.commandLabel,
        currentStateIndex: this.currentStateIndex
      });

      this.sendResponse(response);
      this.sendEvent(new StoppedEvent('step', 1));

    } catch (err: any) {
      this.sendErrorResponse(response, 1, err.message);
    }
  }

  protected async customRequest(
    command: string,
    response: DebugProtocol.Response,
    args: any
  ): Promise<void> {
    const validActions = ['next', 'previous', 'newConfig', 'newTrace', 'newInit', 'newFork'];
    
    if (validActions.includes(command)) {
      await this.navigate(command, response);
    } else if (command === 'showState') {
      this.currentStateIndex = args.stateIndex ?? 0;
      alloyState.setInstance({
        sessionId: this.sessionId,
        instance: this.currentInstance.instance,
        isTemporal: this.currentInstance.isTemporal,
        traceLength: this.currentInstance.traceLength,
        loopState: this.currentInstance.loopState,
        hasConfigs: this.currentInstance.hasConfigs,
        hasNext: this.currentInstance.hasNext,
        hasPrevious: this.currentInstance.hasPrevious || false,
        satisfiable: this.currentInstance.satisfiable,
        commandLabel: this.commandLabel,
        currentStateIndex: this.currentStateIndex
      });
      this.sendResponse(response);
      // Emitir stopped com o frame correto
      const stoppedEvent = new StoppedEvent('step', 1);
      (stoppedEvent as any).body.threadId = 1;
      (stoppedEvent as any).body.preserveFocusHint = false;
      this.sendEvent(stoppedEvent);
    }
  }

  // Terminar sessão
  protected async terminateRequest(
    response: DebugProtocol.TerminateResponse,
    args: DebugProtocol.TerminateArguments
  ): Promise<void> {
    await this.sendToServer({
      action: 'close',
      sessionId: this.sessionId
    });
    alloyState.clear();
    this.sendResponse(response);
    this.sendEvent(new TerminatedEvent());
  }

  // Parsear variáveis do texto da instância
  private parseVariables(instanceText: string, stateIndex: number, scope: number): Variable[] {
    // Usar um Map para evitar duplicados: o valor do estado sobrepõe-se ao do cabeçalho
    const variables = new Map<string, Variable>();

    // Dividir em estados
    const stateBlocks = instanceText.split(/\s*-{4,}State\s+\d+[^\n-]*-{4,}\s*/i);
    const hasStates = stateBlocks.length > 1;
    // Cabeçalho: sigs e fields estáticos, comuns a todos os estados
    const header = hasStates ? stateBlocks[0] : '';
    // Bloco do estado pedido; em modelos estruturais, o texto todo
    const stateBlock = hasStates
      ? (stateBlocks[stateIndex + 1] ?? stateBlocks[1])
      : stateBlocks[0];
    const lines = (header + '\n' + stateBlock).split('\n');

    for (const line of lines) {
      if (!line.trim() || line.includes('univ=') || line.includes('Int=') ||
          line.includes('seq/Int=') || line.includes('String=') || line.includes('none=')) {
        continue;
      }

      // Relações: this/Borrows<:person={...}
      const relMatch = line.match(/this\/\w+<:(\w+)=\{(.*)\}/);
      if (relMatch) {
        if (scope === 2) {
          variables.set(relMatch[1], {
            name: relMatch[1],
            value: `{${relMatch[2]}}`,
            variablesReference: 0
          });
        }
        continue;
      }

      // Sigs: this/Person={...}
      const sigMatch = line.match(/this\/(\w+)=\{(.*)\}/);
      if (sigMatch && scope === 1) {
        variables.set(sigMatch[1], {
          name: sigMatch[1],
          value: `{${sigMatch[2]}}`,
          variablesReference: 0
        });
      }
    }

    return Array.from(variables.values());
  }

  protected async evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments
  ): Promise<void> {
    if (!this.sessionId) {
      this.sendErrorResponse(response, 1, 'No active session');
      return;
    }

    // Ignorar expressões vazias
    if (!args.expression || args.expression.trim() === '') {
      response.body = { result: '', variablesReference: 0 };
      this.sendResponse(response);
      return;
    }

    try {
      const result = await this.sendToServer({
        action: 'evaluate',
        sessionId: this.sessionId,
        expression: args.expression.trim(),
        stateIndex: args.frameId ?? this.currentStateIndex
      });

      if (result.error) {
        // hover — falhar silenciosamente sem mostrar erro
        if (args.context === 'hover') {
          response.body = { result: '', variablesReference: 0 };
          this.sendResponse(response);
          return;
        }
        // watch e repl — mostrar erro de forma amigável
        response.body = {
          result: `⚠ ${result.error.replace('Evaluation error: ', '')}`,
          variablesReference: 0
        };
        this.sendResponse(response);
        return;
      }

      // Formatar resultado dependendo do contexto
      let formattedResult = result.result || '{}';

      if (args.context === 'repl') {
        // Debug Console — mostrar com mais detalhes
        formattedResult = `${args.expression} = ${formattedResult}`;
      }

      response.body = {
        result: formattedResult,
        variablesReference: 0,
        type: 'Alloy Expression',
        presentationHint: {
          kind: 'data'
        }
      };

      this.sendResponse(response);

    } catch (err: any) {
      if (args.context === 'hover') {
        response.body = { result: '', variablesReference: 0 };
        this.sendResponse(response);
        return;
      }
      response.body = {
        result: `⚠ ${err.message}`,
        variablesReference: 0
      };
      this.sendResponse(response);
    }
  }

  // Comunicar com o servidor Java
  private sendToServer(request: object): Promise<any> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let data = '';

      socket.connect(ALLOY_SERVER_PORT, '127.0.0.1', () => {
        socket.write(JSON.stringify(request) + '\n');
      });

      socket.on('data', (chunk) => {
        data += chunk.toString();
        try {
          const response = JSON.parse(data);
          socket.destroy();
          resolve(response);
        } catch {
          // ainda a receber dados
        }
      });

      socket.on('error', (err) => {
        reject(err);
      });

      socket.setTimeout(30000, () => {
        socket.destroy();
        reject(new Error('Timeout'));
      });
    });
  }
}