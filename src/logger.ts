import * as util from 'util';
import { createLogger, format, transports } from 'winston';
import * as DailyRotateFile from 'winston-daily-rotate-file';

const colorizer = format.colorize();
export const logger = createLogger({
    format: format.combine(
        format.timestamp({
            alias: 'time',
            format: 'HH:mm:ss.SSS',
        }),
        format.ms(),
        format.prettyPrint({ colorize: true, depth: 2 }),
        format.printf(info => {
            const out: string[] = [];
            out.push(
                colorizer.colorize('debug', `${info.time} `) +
                colorizer.colorize(info.level, `${info.level.substr(0, 4)}:`) +
                ` ${info.message}`,
            );

            if (info.durationMs) {
                out[out.length - 1] += ` ${info.ms}`;
            }

            const splat: any[] = info[<any>Symbol.for('splat')];
            if (Array.isArray(splat)) {
                const dump = splat.length === 1 ? splat.pop() : splat;
                out.push(util.inspect(dump, {
                    colors: true,
                    depth: 3,
                    compact: true,
                    maxArrayLength: 500,
                    breakLength: 180,
                }));
            }

            return out.join('\n');
        }),
    ),
    transports: [
        new transports.Console({
            level: process.env['LOG_LEVEL'] || 'verbose',
        }),
    ],
});

export function setupFileLogger(appName: string) {
    if (process.env['STARC_FILE_LOG_DISABLE'] === '1') return;
    logger.add(new DailyRotateFile({
        level: 'debug',
        filename: `${appName}-%DATE%.log`,
        datePattern: 'YYYY-MM-DD',
        dirname: 'data/logs',
        json: false,
        maxFiles: '60d',
        zippedArchive: true,
        createSymlink: true,
        symlinkName: `${appName}.log`,
    }));
}

export function isPromise(val: any): val is Promise<any> {
    return !!val && typeof val === 'object' && typeof val.then === 'function' && typeof val.catch === 'function';
}

function formatMemoryUsage(mem: NodeJS.MemoryUsage) {
    function toMegabytes(n: number) {
        return (Math.round(n / 1024 / 1024 * 100) / 100).toFixed(1).padEnd(5);
    }
    return `${toMegabytes(mem.rss)}M ${toMegabytes(mem.heapTotal)}M ${toMegabytes(mem.heapUsed)}M`;
}

export interface LogItOptions {
    level: 'error' | 'warn' | 'info' | 'verbose' | 'debug';
    when: 'in' | 'out' | 'both';
    /** @deprecated */
    profiling?: boolean;
    profTime: boolean;
    profMemory: boolean;
    message?: string;
    argsDump?: ((...args: any[]) => any) | boolean;
    resDump?: ((res: any) => any) | boolean;
    scopeDump?: ((scope: any) => any);
}

export function logIt(inputOptions: Partial<LogItOptions> = {}) {
    const lgOpts = Object.assign<LogItOptions, typeof inputOptions>({
        level: 'debug',
        when: 'both',
        profTime: false,
        profMemory: false,
    }, inputOptions);

    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        if (!(<any>logger).isLevelEnabled(lgOpts.level) && lgOpts.level === 'debug') {
            return;
        }

        const fn = <Function>descriptor.value;
        let msgPrefix: string;

        function markDone(fnResult: any, pTimeSnapshot: [number, number]) {
            if (lgOpts.when !== 'both' && lgOpts.when !== 'out') return;

            const diff = process.hrtime(pTimeSnapshot);
            const diffMs = (diff[0] * 1000) + (diff[1] / 1000000);
            const out = [`-${msgPrefix.padEnd(35)} = ${diffMs.toFixed(0).padStart(4)}ms`];
            if (lgOpts.profMemory) {
                out.push(` | ${formatMemoryUsage(process.memoryUsage())}`);
            }

            let metaArgs: any[] = [];
            if (lgOpts.resDump === true) {
                metaArgs = [fnResult];
            }
            else if (typeof lgOpts.resDump === 'function') {
                metaArgs = [lgOpts.resDump(fnResult)];
            }

            logger.log(lgOpts.level, out.join(''), ...metaArgs);
        }

        const proxyFn = function(this: any, ...args: any[]) {
            if (!msgPrefix) {
                msgPrefix = `${this.constructor.name}:${propertyKey}`;
            }

            const pTimeSnapshot = process.hrtime();

            if (lgOpts.when === 'both' || lgOpts.when === 'in') {
                const out: string[] = [` ${msgPrefix.padEnd(35 + 9)}`];
                if (lgOpts.message) {
                    out.push(lgOpts.message);
                }
                else if (lgOpts.profMemory) {
                    out.push(` | ${formatMemoryUsage(process.memoryUsage())}`);
                }

                if (lgOpts.scopeDump) {
                    logger.log(lgOpts.level, out.join(''), lgOpts.scopeDump(this));
                }

                let metaArgs: any[] = [];
                if (lgOpts.argsDump === true) {
                    metaArgs = args;
                }
                else if (typeof lgOpts.argsDump === 'function') {
                    metaArgs = [lgOpts.argsDump(...args)];
                }
                logger.log(lgOpts.level, out.join(''), ...metaArgs);
            }

            let fnResult = fn.apply(this, args);
            if (isPromise(fnResult)) {
                return new Promise((resolve, reject) => {
                    fnResult
                        .then((res: unknown) => {
                            markDone(res, pTimeSnapshot);
                            resolve(res);
                        })
                        .catch((err: Error) => {
                            markDone(err, pTimeSnapshot);
                            reject(err);
                        })
                    ;
                });
            }
            else {
                markDone(fnResult, pTimeSnapshot);
                return fnResult;
            }
        };
        descriptor.value = proxyFn;
    };
}
