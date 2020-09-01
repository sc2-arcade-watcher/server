import * as path from 'path';
import * as fs from 'fs-extra';
import { execAsync } from '../helpers';
import { logger, logIt } from '../logger';

const feedStorageDir = 'data/lbstream';

export interface RunnerSessionFeedState {
    timestamp: number;
    lastUpdateAt: number;
    size: number;
}

export class RunnerFeedCtrl {
    protected currStream?: fs.WriteStream;
    protected initialOffset = 0;

    constructor (public readonly runnerName: string) {
    }

    get storageDir() {
        return `${feedStorageDir}/${this.runnerName}`;
    }

    @logIt()
    async fetchCurrentSessionInfo(): Promise<RunnerSessionFeedState> {
        if (!(await fs.pathExists(this.storageDir))) return;
        const result = await execAsync(`fd -t f . "${this.storageDir}/" -x echo "{/.} {}" | sort -h | cut -d " " -f 2-`);
        const flist = result.stdout.trimRight().split('\n');
        if (!flist.length || flist[0] === '') return;

        const sessTimestamp = Number(flist[flist.length - 1].match(/(\d+)$/)[1]);
        const fstat = await fs.stat(flist[flist.length - 1]);

        return {
            timestamp: sessTimestamp,
            lastUpdateAt: Number((fstat.mtime.getTime() / 1000).toFixed(0)),
            size: fstat.size,
        };
    }

    protected openWriteStream(sessTimestamp: number, offset: number) {
        const fname = path.join(feedStorageDir, this.runnerName, sessTimestamp.toString());
        if (fs.pathExistsSync(fname)) {
            const sInfo = fs.statSync(fname);
            if (sInfo.size !== offset) {
                throw new Error(`Provided offset past the size of file, size=${sInfo.size} offset=${offset}`);
            }
            this.initialOffset = offset;
            return fs.createWriteStream(fname, {
                encoding: 'utf8',
                flags: 'r+',
                start: offset,
                autoClose: true,
            });
        }
        else {
            this.initialOffset = 0;
            return fs.createWriteStream(fname, {
                encoding: 'utf8',
                flags: 'w',
                autoClose: true,
            });
        }
    }

    get activeSession(): number {
        return this.currStream ? Number(path.basename(this.currStream.path as string)) : void 0;
    }

    beginSession(sessionTimestamp: number, sessionOfset: number) {
        if (this.currStream && Number(path.basename(this.currStream.path as string)) === sessionTimestamp) {
            logger.debug(`reusing same stream instance, path="${this.currStream.path}" written="${this.currStream.bytesWritten}"`);
        }
        else {
            if (this.currStream) {
                this.endSession();
                this.currStream = void 0;
            }

            fs.ensureDirSync(this.storageDir);
            this.currStream = this.openWriteStream(sessionTimestamp, sessionOfset);
            this.currStream.on('error', (err: Error) => {
                throw err;
            });
            this.currStream.on('finish', () => {
                logger.verbose(`sessWriteStream finish offset=${sessionOfset} session="${sessionTimestamp}"`);
            });
            this.currStream.on('close', () => {
                logger.verbose(`sessWriteStream close offset=${sessionOfset} session="${sessionTimestamp}"`);
            });
        }
    }

    async endSession() {
        if (this.currStream) {
            const myInitialOffset = this.initialOffset;
            const myStream = this.currStream;
            logger.verbose(`Closing stream, path=${myStream.path}`);
            return new Promise((resolve, reject) => {
                this.currStream.end(() => {
                    logger.verbose(`Closed stream, path=${myStream.path} written=${myStream.bytesWritten} total=${myInitialOffset + myStream.bytesWritten}`);
                    resolve();
                });
                this.currStream = void 0;
            });
        }
    }

    write(chunk: string) {
        return this.currStream.write(chunk, 'utf8');
    }
}
