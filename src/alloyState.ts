import { EventEmitter } from 'events';

export interface AlloyInstance {
  sessionId: string;
  instance: string;
  isTemporal: boolean;
  traceLength: number;
  loopState: number;
  hasConfigs: boolean;
  hasNext: boolean;
  hasPrevious: boolean;
  satisfiable: boolean;
  commandLabel: string;
  currentStateIndex: number;
}

class AlloyStateManager extends EventEmitter {
  private currentInstance: AlloyInstance | undefined;
  private runAllResults: { label: string; response: any; index: number }[] = [];
  private runAllFile: string = '';
  private runAllFromDebug: boolean = false;
  private pendingRunAllFromDebug: boolean = false;

  setInstance(instance: AlloyInstance) {
    this.currentInstance = instance;
    this.emit('instanceChanged', instance);
  }

  getInstance(): AlloyInstance | undefined {
    return this.currentInstance;
  }

  setRunAllResults(results: { label: string; response: any; index: number }[], file: string, fromDebug: boolean = false) {
    this.runAllResults = results;
    this.runAllFile = file;
    this.runAllFromDebug = fromDebug;
    this.emit('runAllResultsChanged', results, file);
  }

  isRunAllFromDebug(): boolean {
    return this.runAllFromDebug;
  }

  setPendingRunAllFromDebug(value: boolean) {
    this.pendingRunAllFromDebug = value;
  }

  getPendingRunAllFromDebug(): boolean {
    return this.pendingRunAllFromDebug;
  }

  getRunAllResults(): { results: { label: string; response: any; index: number }[]; file: string } {
    return { results: this.runAllResults, file: this.runAllFile };
  }

  clearRunAllResults() {
    this.runAllResults = [];
    this.runAllFile = '';
  }

  clear() {
    this.currentInstance = undefined;
    this.emit('instanceCleared');
  }
}

export const alloyState = new AlloyStateManager();