import * as util from 'util';
import * as childProc from 'child_process';
import * as pRetry from 'p-retry';
import * as orm from 'typeorm';
import { isPromise, logger } from './logger';
import { AxiosError } from 'axios';

export const sleep = util.promisify(setTimeout);

export async function sleepUnless(ms: number, condCheck: () => boolean, inopts: { sleepInterval?: number } = {}) {
    return new Promise((resolve, reject) => {
        const opts: { sleepInterval: number } = Object.assign({
            sleepInterval: 100,
        }, inopts);
        let i = 0;
        // Type 'number' is not assignable to type 'Timeout'
        // (due to DOM typings in tsconfig)
        // @ts-ignore
        let tim: NodeJS.Timeout = setInterval(() => {
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
    rcode: number | null;
    signal: NodeJS.Signals | null;
    stdout?: string;
    stderr?: string;
}

export function spawnWaitExit<T extends childProc.ChildProcess>(proc: T, opts: SpawnWaitOptions = {}): Promise<SpawnWaitResult<T>> {
    const stdout: string[] = [];
    const stderr: string[] = [];

    if (opts.captureStdout) {
        proc.stdout!.on('data', buff => {
            if (buff instanceof Buffer) {
                stdout.push(buff.toString('utf8'));
            }
        });
    }
    if (opts.captureStderr) {
        proc.stderr!.on('data', buff => {
            if (buff instanceof Buffer) {
                stderr.push(buff.toString('utf8'));
            }
        });
    }

    return new Promise((resolve, reject) => {
        proc.once('exit', async (code, signal) => {
            if (opts.captureStdout && !proc.stdout!.destroyed) {
                await new Promise(resolve => { proc.stdout!.once('close', resolve); });
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

export function setupProcessTerminator(handler: () => void) {
    function terminationProxy(sig: NodeJS.Signals) {
        logger.info(`${sig} received`);
        handler();
        process.once('SIGINT', function () {
            logger.warn(`${sig} received for the second time, forcing shutdown..`);
            process.exit(1);
        });
    }

    process.once('SIGTERM', terminationProxy);
    process.once('SIGINT', terminationProxy);
}

export async function systemdNotifyReady() {
    logger.verbose(`systemd-notify call`);
    const r = await execAsync('systemd-notify --ready');
    logger.debug(`systemd-notify result`, r);
}

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

export function deepCopy(a: any) {
    return JSON.parse(JSON.stringify(a));
}

//
// axios stuff
//

export function isAxiosError(err: any): err is AxiosError {
    return err instanceof Error && (err as AxiosError).isAxiosError === true;
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
