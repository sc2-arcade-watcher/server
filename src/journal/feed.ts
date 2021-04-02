import * as path from 'path';
import * as fs from 'fs-extra';
import { spawn, ChildProcessByStdio } from 'child_process';
import { spawnWaitExit } from '../helpers';
import { Readable, Writable } from 'stream';
import { logger } from '../logger';

export interface JournalFeedCursor {
    session: number;
    offset: number;
}

export interface JournalFeedOptios {
    initCursor?: JournalFeedCursor;
    // TODO:implement endCursor
    // endCursor?: JournalFeedCursor;
    timeout?: number;
    follow?: boolean;
}

export class JournalFeed {
    cursor: JournalFeedCursor;
    // protected rs: Readable;
    protected rs: fs.ReadStream;
    protected chunkBuff: Buffer;
    protected chunkPos: number;
    /** remaining (and incomplete) data from previous chunk  */
    protected rbuff: Buffer;
    protected dataTimeout: NodeJS.Timer;
    protected tailProc: ChildProcessByStdio<Writable, Readable, Readable>;
    protected sessionFileList: number[];
    private waitingForData = false;
    private closed = false;
    private firstRead = true;
    public readonly options: JournalFeedOptios;

    constructor(public baseDir: string, options: JournalFeedOptios = {}) {
        this.cursor = {
            session: options.initCursor?.session ?? 0,
            offset: options.initCursor?.offset ?? 0,
        };
        this.options = Object.assign({
            timeout: -1,
            follow: true,
        } as JournalFeedOptios, options);
    }

    get name(): string {
        return path.basename(this.baseDir);
    }

    get currCursor(): string {
        return `${this.cursor.session}@+${this.cursor.offset}`;
    }

    get currFilename(): string {
        return path.join(this.baseDir, this.cursor.session.toString());
    }

    close() {
        if (this.closed) return;
        logger.info(`Closing stream reader of ${this.name}, cursor=${this.currCursor}`);
        this.closed = true;

        this.closeCurrentStream();
    }

    protected closeCurrentStream(destroyReadStream: boolean = true) {
        if (this.dataTimeout) {
            clearInterval(this.dataTimeout);
            this.dataTimeout = void 0;
        }

        if (this.tailProc) {
            this.tailProc.kill('SIGTERM');
            this.tailProc = void 0;
        }
        // else {
        //     (<fs.ReadStream>this.rs).close();
        // }
        if (this.rs)  {
            if (!this.rs.destroyed && destroyReadStream) {
                this.rs.destroy();
            }
            this.rs = void 0;
        }
    }

    protected clearBuffers() {
        this.chunkBuff = void 0;
        this.chunkPos = void 0;
        this.rbuff = void 0;
    }

    protected async refreshFileList() {
        this.sessionFileList = (await fs.readdir(this.baseDir)).filter(v => v.match(/^\d+$/)).map(v => Number(v)).sort();
    }

    protected isCurrSessionLast() {
        return this.cursor.session === this.sessionFileList[this.sessionFileList.length - 1];
    }

    protected async setupReadstream() {
        const sessName = this.cursor.session;

        if (!this.isCurrSessionLast() || !this.options.follow) {
            this.rs = fs.createReadStream(this.currFilename, {
                encoding: null,
                start: this.cursor.offset,
            });
        }
        else {
            const tmpTailProc = spawn('tail', [
                `--bytes=+${this.cursor.offset + 1}`,
                `--sleep-interval=0.01`,
                `-f`, this.currFilename,
            ], {
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            tmpTailProc.stderr.on('data', buff => {
                if (!(buff instanceof Buffer)) {
                    throw new Error(`tailProc stderr not buff: ${buff}`);
                }
                logger.warn(`tailProc err: src=${this.name} sname=${sessName} pid=${tmpTailProc.pid} buff=${buff.toString('utf8').trimRight()}`);
                this.closeCurrentStream();
                this.clearBuffers();
            });

            const tmpDataTimeout = setInterval(async () => {
                logger.debug(`tailProc dataTimeout src=${this.name} sname=${sessName} chunkBuffLen=${this.chunkBuff?.length} readableLen=${this.rs.readableLength} waitingForData=${this.waitingForData}`);
                if (this.chunkBuff || this.rs.readableLength) return;
                await this.refreshFileList();
                if (!this.isCurrSessionLast()) {
                    logger.warn(`tailProc timeout, src=${this.name} sname=${sessName} pid=${tmpTailProc.pid}, new file detected`);
                    this.closeCurrentStream(false);
                    this.cursor.session = this.sessionFileList[this.sessionFileList.findIndex(v => v === this.cursor.session) + 1];
                    this.cursor.offset = 0;
                }
            }, 3000);
            this.dataTimeout = tmpDataTimeout;

            tmpTailProc.on('exit', (code, signal) => {
                logger.verbose(`tailProc exit: src=${this.name} sname=${sessName} pid=${tmpTailProc.pid} code=${code} signal=${signal}`);
                if (!tmpDataTimeout) return;

                // by the time this event fires there might be new tailProc instance open
                // clear reference only if they match
                if (this.dataTimeout === tmpDataTimeout) {
                    logger.debug(`clearInterval dataTimeout`);
                    this.dataTimeout = void 0;
                }

                clearInterval(tmpDataTimeout);
            });

            this.tailProc = tmpTailProc;
            this.rs = tmpTailProc.stdout as fs.ReadStream;
        }

        // this.rs.on('readable', () => { logger.verbose(`readstream: src=${this.name} readable sname=${sessName}`); });
        this.rs.on('end', () => {
            logger.verbose(`readstream: end src=${this.name} sname=${sessName}`);
        });
        this.rs.on('close', () => {
            logger.verbose(`readstream: close src=${this.name} sname=${sessName}`);
        });
        this.rs.on('error', (err) => {
            throw err;
        });
    }

    protected readlineFromBuff() {
        while (this.chunkBuff.byteLength > this.chunkPos) {
            let chunkEnd = this.chunkBuff.indexOf(0x0A, this.chunkPos);

            // no EOL
            if (chunkEnd === -1) {
                // if we haven't read enough from the stream to begin with
                // copy it to rbuff until we reach an EOL
                if (this.chunkPos === 0) {
                    // if rbuff is empty there's no need to allocate anything new
                    if (!this.rbuff) {
                        this.rbuff = this.chunkBuff;
                    }
                    // if rbuff already has something then allocate new buffer and merge the content
                    else {
                        const tmpbuff = Buffer.allocUnsafe(this.rbuff.byteLength + this.chunkBuff.byteLength);
                        this.rbuff.copy(tmpbuff);
                        this.chunkBuff.copy(tmpbuff, this.rbuff.byteLength, 0, this.chunkBuff.byteLength);
                    }
                    this.chunkBuff = void 0;
                    return null;
                }
                else {
                    // this should never happen.. probably?
                    logger.error(`chunkEnd`, {
                        name: this.name,
                        cursor: this.currCursor,
                        chunkByteLength: this.chunkBuff.byteLength,
                        chunkPos: this.chunkPos,
                        chunkString: this.chunkBuff.toString('utf8', this.chunkPos),
                        chunkBuff: this.chunkBuff,
                        rbuff: this.rbuff,
                        rstring: this.rbuff ? this.rbuff.toString('utf8') : void 0,
                    });
                    throw new Error(`chunkEnd == -1`);
                }
            }

            let line: string;
            // prepend the remaining content from previous read
            if (this.rbuff) {
                const tmpbuff = Buffer.allocUnsafe(this.rbuff.byteLength + (chunkEnd - this.chunkPos));
                this.rbuff.copy(tmpbuff);
                this.chunkBuff.copy(tmpbuff, this.rbuff.byteLength, this.chunkPos, chunkEnd);
                line = tmpbuff.toString('utf8');
                this.rbuff = void 0;
            }
            else {
                line = this.chunkBuff.toString('utf8', this.chunkPos, chunkEnd);
            }

            if (line.charCodeAt(line.length - 1) !== 0x0D) {
                throw new Error('Expected CRLF');
            }

            line = line.substr(0, line.length - 1);
            this.chunkPos = chunkEnd + 1;
            this.cursor.offset += Buffer.byteLength(line) + 2;

            if (this.dataTimeout) {
                this.dataTimeout.refresh();
            }

            if (this.chunkBuff.byteLength === this.chunkPos) {
                this.chunkBuff = void 0;
            }
            else if (this.chunkBuff.indexOf(0x0A, this.chunkPos) === -1) {
                if (this.rbuff) {
                    throw new Error('buff expected to be null');
                }
                this.rbuff = Buffer.allocUnsafe(this.chunkBuff.byteLength - this.chunkPos);
                this.chunkBuff.copy(this.rbuff, 0, this.chunkPos, this.chunkBuff.byteLength);
                this.chunkBuff = void 0;
            }

            return line;
        }

        this.chunkBuff = void 0;
    }

    /**
     * - returns `string` for a succesfull read
     * - returns `undefined` when reached timeout
     * - returns `false` when reached an end and follow mode was disabled
     * @param timeout
     */
    async read(timeout: number = 500): Promise<string | false | undefined> {
        if (this.closed) {
            logger.warn(`attempting to read from closed feed, src=${this.name}`);
            return;
        }

        if (
            this.firstRead &&
            this.cursor.session === this.options.initCursor.session &&
            this.cursor.offset === this.options.initCursor.offset
        ) {
            await fs.ensureDir(this.baseDir);
            const exists = await fs.pathExists(this.currFilename);
            if (!exists) {
                await this.refreshFileList();
                logger.error(`feed file doesn't exist ${this.currFilename}`, this.sessionFileList);
                throw new Error(`feed file doesn't exist ${this.currFilename}`);
            }

            this.firstRead = false;
            if (this.options.initCursor.offset !== 0) {
                const headProc = spawn('head', [
                    '--lines',
                    '1',
                    this.currFilename,
                ], { shell: true });
                const headResult = await spawnWaitExit(headProc, { captureStdout: true });
                if (headResult.rcode !== 0) {
                    throw new Error(`read head n1 rcode=${headResult.rcode}`);
                }
                return headResult.stdout.trimRight();
            }
            else if (this.options.initCursor.session === 0) {
                await this.refreshFileList();
                if (!this.sessionFileList.length) {
                    logger.warn(`feed source is empty, src=${this.name}`);
                    return;
                }
                this.cursor.session = this.sessionFileList[0];
            }
        }

        let readTimeoutCounter = 0;
        while (1) {
            if (!this.rs) {
                await this.refreshFileList();

                const fSize = (await fs.stat(this.currFilename)).size;
                if (!this.isCurrSessionLast()) {
                    if (fSize <= this.cursor.offset) {
                        throw new Error(
                            `offset past the filesize, src=${this.name} cursor=${this.currCursor} size=${fSize}`
                        );
                    }
                }

                if (!this.options.follow && (
                    this.cursor.session !== this.options.initCursor.session || this.cursor.offset === fSize
                )) {
                    logger.verbose(`feed src=${this.name} session end, not following further`);
                    this.close();
                    return false;
                }

                logger.info(`opening src=${this.name} cursor=${this.currCursor}`);
                await this.setupReadstream();
                this.waitingForData = false;
            }

            if (this.chunkBuff) {
                const line = this.readlineFromBuff();
                if (line) {
                    return line;
                }
                else if (line === null) {
                    continue;
                }
                else {
                    throw new Error(`readlineFromBuff: src=${this.name} cursor=${this.currCursor}`);
                }
            }

            if (this.rs.readable && !this.rs.readableLength) {
                if (this.waitingForData) { return; }
                try {
                    // logger.debug(`waiting for readable on ${this.name}`);
                    await new Promise((resolve, reject) => {
                        let tm: NodeJS.Timer;
                        const tmprs = this.rs;
                        const ronce = (() => {
                            clearTimeout(tm);
                            resolve();
                        }).bind(this);
                        tm = setTimeout(() => {
                            tmprs.off('readable', ronce);
                            reject();
                        }, timeout);
                        tmprs.once('readable', ronce);
                    });
                }
                catch (e) {
                    if (this.closed) {
                        return;
                    }

                    const fSize = (await fs.stat(this.currFilename)).size;
                    if (this.tailProc && fSize === this.cursor.offset) {
                        this.waitingForData = true;
                        // logger.debug(`nothing to read: src=${this.name} cursor=${this.currCursor} fsize=${fSize}`);
                        return;
                    }
                    else if (!this.tailProc && fSize === this.cursor.offset) {
                        logger.debug(`reached EOF: src=${this.name} cursor=${this.currCursor} fsize=${fSize}`);
                    }
                    else {
                        ++readTimeoutCounter;
                        if (readTimeoutCounter >= 2) {
                            logger.warn(`Feed read timeout, c=${readTimeoutCounter} src=${this.name} cursor=${this.currCursor} fsize=${fSize} tailProc=${Boolean(this.tailProc)}`);
                        }
                        else if (readTimeoutCounter > 10) {
                            throw new Error(`Feed read attempts exceeded, src=${this.name} cursor=${this.currCursor}`);
                        }
                        continue;
                    }
                }
            }

            const tmp = this.rs.read();
            if (tmp instanceof Buffer) {
                readTimeoutCounter = 0;
                this.chunkBuff = tmp;
                this.chunkPos = 0;
                this.waitingForData = false;
                continue;
            }
            else if (!tmp) {
                logger.info(`waiting for end: src=${this.name} cursor=${this.currCursor}`);
                if (this.rs.readable) {
                    try {
                        await new Promise((resolve, reject) => {
                            let tm: NodeJS.Timer;
                            const ronce = () => {
                                clearTimeout(tm);
                                resolve();
                            };
                            const tmprs = this.rs;
                            tm = setTimeout(() => {
                                tmprs.off('end', ronce);
                                reject();
                            }, timeout);
                            tmprs.once('end', ronce);
                        });
                    }
                    catch (err) {
                        ++readTimeoutCounter;
                        logger.error(`Feed end timeout, src=${this.name} cursor=${this.currCursor}`, {
                            readable: this.rs.readable,
                            readableLength: this.rs.readableLength,
                            bytesRead: this.rs.bytesRead,
                            destroyed: this.rs.destroyed,
                        });
                        if (readTimeoutCounter > 10) {
                            throw new Error(`Feed end timeout attempts exceeded, src=${this.name} cursor=${this.currCursor}`);
                        }
                        continue;
                    }
                }
                this.closeCurrentStream();

                await this.refreshFileList();
                if (!this.isCurrSessionLast()) {
                    const fSize = (await fs.stat(this.currFilename)).size;
                    if (fSize > this.cursor.offset) {
                        throw new Error(
                            `unexpected end of stream, cursorSession=${this.cursor.session} cursorOffset=${this.cursor.offset} fSize=${fSize}`
                        );
                    }
                    else {
                        this.cursor.session = this.sessionFileList[this.sessionFileList.findIndex(v => v === this.cursor.session) + 1];
                        this.cursor.offset = 0;
                    }
                }
            }
            else {
                throw new Error(`failed read, expected Buffer instance, received ${tmp}`);
            }
        }
    }
}
