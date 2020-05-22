import * as util from 'util';
import * as childProc from 'child_process';
import { isPromise, logger } from './logger';

export const sleep = util.promisify(setTimeout);

export async function sleepUnless(ms: number, condCheck: () => boolean, opts: { sleepInterval?: number } = {}) {
    return new Promise((resolve, reject) => {
        opts = Object.assign({
            sleepInterval: 100,
        }, opts);
        let i = 0;
        let tim: NodeJS.Timer = setInterval(() => {
            ++i;
            if (!condCheck()) {
                logger.info(`sleep interval interrupted; curr=${(i * opts.sleepInterval)} target=${ms}`);
            }
            else if ((i * opts.sleepInterval) < ms) {
                return;
            }
            else {
            }
            clearInterval(tim);
            resolve();
        }, opts.sleepInterval);
    });
}

export interface Listener<T> {
    (event: T): any;
}

export interface Disposable {
    dispose(): void;
}

export class TypedEvent<T> {
    private listeners: Listener<T>[] = [];
    private listenersOncer: Listener<T>[] = [];

    on(listener: Listener<T>): Disposable {
        this.listeners.push(listener);
        return {
            dispose: () => this.off(listener)
        };
    }

    once(listener: Listener<T>): void {
        this.listenersOncer.push(listener);
    }

    off(listener: Listener<T>) {
        let callbackIndex = this.listeners.indexOf(listener);
        if (callbackIndex > -1) this.listeners.splice(callbackIndex, 1);
    }

    emit(event: T) {
        this.listeners.forEach((listener) => listener(event));

        this.listenersOncer.forEach((listener) => listener(event));
        this.listenersOncer = [];
    }

    async emitAsync(event: T) {
        const ps: Promise<any>[] = [];
        this.listeners.forEach((listener) => {
            const x = listener(event);
            if (isPromise(x)) {
                ps.push(x);
            }
        });

        this.listenersOncer.forEach((listener) => listener(event));
        this.listenersOncer = [];

        if (ps.length) {
            await Promise.all(ps);
        }
    }

    pipe(te: TypedEvent<T>): Disposable {
        return this.on((e) => te.emit(e));
    }
}

export const execAsync = util.promisify(childProc.exec);

export interface SpawnWaitOptions {
    captureStdout?: boolean;
}

export interface SpawnWaitResult {
    rcode: number;
    stdout?: string;
}

export function spawnWaitExit<T extends childProc.ChildProcess>(proc: T, opts: SpawnWaitOptions = {}): Promise<SpawnWaitResult> {
    const stdout: string[] = [];

    if (opts.captureStdout) {
        proc.stdout.on('data', buff => {
            if (buff instanceof Buffer) {
                stdout.push(buff.toString('utf8'));
            }
        });
    }

    return new Promise((resolve, reject) => {
        proc.once('exit', (code, signal) => {
            resolve({
                rcode: code,
                stdout: stdout.join('')
            });
        });
    });
}

export type Partial<T> = { [P in keyof T]?: T[P] };
