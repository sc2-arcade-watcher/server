import * as util from 'util';
import * as childProc from 'child_process';
import * as pRetry from 'p-retry';
import * as orm from 'typeorm';
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
    captureStderr?: boolean;
}

export interface SpawnWaitResult<T> {
    proc: T;
    rcode: number;
    signal: NodeJS.Signals;
    stdout?: string;
    stderr?: string;
}

export function spawnWaitExit<T extends childProc.ChildProcess>(proc: T, opts: SpawnWaitOptions = {}): Promise<SpawnWaitResult<T>> {
    const stdout: string[] = [];
    const stderr: string[] = [];

    if (opts.captureStdout) {
        proc.stdout.on('data', buff => {
            if (buff instanceof Buffer) {
                stdout.push(buff.toString('utf8'));
            }
        });
    }
    if (opts.captureStderr) {
        proc.stderr.on('data', buff => {
            if (buff instanceof Buffer) {
                stderr.push(buff.toString('utf8'));
            }
        });
    }

    return new Promise((resolve, reject) => {
        proc.once('exit', async (code, signal) => {
            if (opts.captureStdout && !proc.stdout.destroyed) {
                await new Promise(resolve => {
                    proc.stdout.once('close', () => resolve());
                });
            }

            resolve({
                proc,
                rcode: code,
                signal,
                stdout: opts.captureStdout ? stdout.join('') : void 0,
                stderr: opts.captureStderr ? stderr.join('') : void 0,
            });
        });
    });
}

export type Partial<T> = { [P in keyof T]?: T[P] };

export function retry(options?: pRetry.Options) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const fn = <Function>descriptor.value;

        descriptor.value = function(this: any, ...args: any[]) {
            return pRetry(input => fn.apply(this, args), options);
        };
    };
}

export function atob(value: string): string {
    return Buffer.from(value, 'base64').toString();
}

export function btoa(value: string): string {
    return Buffer.from(value).toString('base64');
}

//
// ORM stuff
//

export function isErrDuplicateEntry(err: Error) {
    if (!(err instanceof orm.QueryFailedError)) return;
    return (<any>err).code === 'ER_DUP_ENTRY';
}

export function throwErrIfNotDuplicateEntry(err: Error) {
    if (isErrDuplicateEntry(err)) return;
    throw err;
}
