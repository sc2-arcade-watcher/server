import * as util from 'util';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as WebSocket from 'ws';
import { logger, logIt, setupFileLogger } from '../logger';
import { Socket } from 'net';
import { execAsync, sleep } from '../helpers';

export interface LblRunnerSession {
    startedAt: number;
    lastUpdateAt: number;
    size: number;
}

export class LblRunnerInfo {
    readonly id: string;
    readonly hname: string;
    readonly region: string;

    constructor(id: string, hostName: string, region: string) {
        this.id = id;
        this.hname = hostName;
        this.region = region;
    }

    @logIt()
    async getCurrentSession(): Promise<LblRunnerSession> {
        const result = await execAsync(`fd -t f . "${LblStorage.storageDir}/${this.id}/" -x echo "{/.} {}" | sort -h | cut -d " " -f 2-`);
        const flist = result.stdout.trimRight().split('\n');
        if (!flist.length || flist[0] === '') return;

        const sessTimestamp = Number(flist[flist.length - 1].match(/(\d+)$/)[1]);
        const fstat = await fs.stat(flist[flist.length - 1]);

        return {
            startedAt: sessTimestamp,
            lastUpdateAt: Number((fstat.mtime.getTime() / 1000).toFixed(0)),
            size: fstat.size,
        };
    }

    @logIt({ argsDump: true })
    openWriteSession(sessTimestamp: number, offset: number) {
        const fname = path.join(LblStorage.storageDir, this.id, sessTimestamp.toString());
        if (fs.pathExistsSync(fname)) {
            const sInfo = fs.statSync(fname);
            if (sInfo.size !== offset) {
                throw new Error(`Provided offset past the size of file, size=${sInfo.size} offset=${offset}`);
            }
            return fs.createWriteStream(fname, {
                encoding: 'utf8',
                flags: 'r+',
                start: offset,
            });
        }
        else {
            return fs.createWriteStream(fname, {
                encoding: 'utf8',
                flags: 'w',
            });
        }
    }
}

export class LblStorage {
    static storageDir = 'data/lbstream';
    protected runnerInfo = new Map<string, LblRunnerInfo>();

    async load() {
        for (const runnerId of await fs.readdir(LblStorage.storageDir)) {
            const fstat = await fs.stat(path.join(LblStorage.storageDir, runnerId));
            if (!fstat.isDirectory()) continue;

            const m = runnerId.match(/^(.*)-(EU|KR|US)$/);
            const rInfo = new LblRunnerInfo(runnerId, m[1], m[2]);
            this.runnerInfo.set(rInfo.id, rInfo);
        }
    }

    async createRunner(hname: string, region: string) {
        const runnerId = `${hname}-${region}`;
        const rInfo = new LblRunnerInfo(runnerId, hname, region);
        this.runnerInfo.set(runnerId, rInfo);
        await fs.ensureDir(path.join(LblStorage.storageDir, runnerId));
        return rInfo;
    }

    getRunners() {
        return this.runnerInfo as ReadonlyMap<string, LblRunnerInfo>;
    }
}

// ===

enum LbsRequestKind {
    Welcome         = 0,
    RunnerIntro     = 1,
    SetStreamOffset = 2,
    StreamBegin     = 3,
    StreamEnd       = 4,
    StreamChunk     = 5,
}

interface LbsRunnerIntro {
    hostname: string;
    region: string;
}

interface LbsSetDataOffset {
    sessionStartAt: number;
    line: number;
    offset: number;
}

interface LbsStreamBegin {
    sessionStartAt: number;
    line: number;
    offset: number;
}

interface LbsStreamEnd {
    sessionEndAt: number;
}

interface LbsStreamChunk {
    d: string;
}

interface WsClientDesc {
    isAlive: boolean;
    connSocket: Socket;
    runnerInfo?: LblRunnerInfo;
    sessInfo?: LblRunnerSession;
    sessWriteStream?: fs.WriteStream;
}

export class LbsServer {
    protected wss: WebSocket.Server;
    protected clientsInfo = new Map<WebSocket, WsClientDesc>();
    protected lbStorage = new LblStorage();

    @logIt()
    async load() {
        await this.lbStorage.load();
        this.wss = new WebSocket.Server({
            port: 8089,
        });

        this.wss.on('listening', async function() {
            logger.info(`WebSocket listening..`);
            if (process.env.NOTIFY_SOCKET) {
                const r = await execAsync('systemd-notify --ready');
                logger.verbose(`systemd-notify`, r);
            }
        });

        this.wss.on('connection', this.onNewConnection.bind(this));

        setInterval(() => {
            this.wss.clients.forEach((ws) => {
                const sclient = this.clientsInfo.get(ws);
                if (!sclient.isAlive) {
                    logger.info(`No response to ping from ${sclient?.runnerInfo.id}. Terminating connection..`);
                    return ws.terminate();
                }

                sclient.isAlive = false;
                ws.ping();
            });
        }, 30000).unref();
    }

    @logIt({ profiling: false })
    close() {
        logger.verbose('Closing websocket..');
        this.wss.close();
    }

    protected async onNewConnection(ws: WebSocket, request: http.IncomingMessage) {
        this.clientsInfo.set(ws, {
            isAlive: true,
            connSocket: request.connection,
        });

        logger.info(`New connection from ip=${request.connection.remoteAddress} rport=${request.connection.remotePort}`);

        ws.on('message', this.onConnMessage.bind(this, ws));
        ws.on('close', this.onConnClose.bind(this, ws));
        ws.on('pong', this.onConnPong.bind(this, ws));
    }

    protected async onConnMessage(ws: WebSocket, message: WebSocket.Data) {
        const sclient = this.clientsInfo.get(ws);
        const msg = JSON.parse(message as string);

        // logger.debug(`msg ip=${sclient.connSocket.remoteAddress} rport=${sclient.connSocket.remotePort}`, msg);

        switch (Number(msg.$id) as LbsRequestKind) {
            case LbsRequestKind.RunnerIntro: {
                const rvRunner: LbsRunnerIntro = msg;
                const rnKey = `${rvRunner.hostname}-${rvRunner.region}`;
                let rnInfo = this.lbStorage.getRunners().get(rnKey);
                if (!rnInfo) {
                    rnInfo = await this.lbStorage.createRunner(rvRunner.hostname, rvRunner.region);
                }

                logger.info(`RunnerIntro: ip=${sclient.connSocket.remoteAddress} rport=${sclient.connSocket.remotePort}`, rvRunner);

                const dupedClients = Array.from(this.clientsInfo.entries()).filter(x => {
                    return (
                        x[1] !== sclient &&
                        x[1].sessWriteStream &&
                        x[1].runnerInfo.id === rnInfo.id
                    );
                });
                if (dupedClients.length) {
                    out: for (const [socket, client] of dupedClients) {
                        logger.warn(`Terminating extra connection of ${client.runnerInfo.id} rport=${client.connSocket.remotePort}`);
                        socket.terminate();
                        for (let i = 0; i < 5; ++i) {
                            await sleep(1000);
                            if (socket.CLOSED) {
                                continue out;
                            }
                        }
                        logger.error(`Failed to terminate extra connections.. refusing connection new connection`);
                        ws.terminate();
                        return;
                    }
                }

                sclient.runnerInfo = rnInfo;
                sclient.sessInfo = await rnInfo.getCurrentSession();
                logger.verbose('sessInfo', sclient.sessInfo);

                const sdOffset: LbsSetDataOffset = {
                    sessionStartAt: 0,
                    line: 0,
                    offset: 0,
                };
                if (sclient.sessInfo) {
                    sdOffset.sessionStartAt = sclient.sessInfo.startedAt;
                    sdOffset.offset = sclient.sessInfo.size;
                }

                ws.send(JSON.stringify({ $id: LbsRequestKind.SetStreamOffset, ...sdOffset }));

                break;
            }

            case LbsRequestKind.StreamBegin: {
                const rvStrBeg: LbsStreamBegin = msg;

                const rnInfo = sclient.runnerInfo;
                if (sclient.sessWriteStream && Number(path.basename(sclient.sessWriteStream.path as string)) === rvStrBeg.sessionStartAt) {
                    logger.verbose(`resuing same stream instance, path="${sclient.sessWriteStream.path}" bytesWritten="${sclient.sessWriteStream.bytesWritten}"`);
                }
                else {
                    sclient.sessWriteStream = rnInfo.openWriteSession(rvStrBeg.sessionStartAt, rvStrBeg.offset);
                    sclient.sessWriteStream.on('error', (err: Error) => {
                        throw err;
                    });
                    sclient.sessWriteStream.on('finish', () => {
                        logger.verbose(`sessWriteStream finish offset=${rvStrBeg.offset} session="${rvStrBeg.sessionStartAt}"`);
                    });
                    sclient.sessWriteStream.on('close', () => {
                        logger.verbose(`sessWriteStream close offset=${rvStrBeg.offset} session="${rvStrBeg.sessionStartAt}"`);
                    });
                }

                logger.info(`StreamBegin, offset=${rvStrBeg.offset} path="${sclient.sessWriteStream.path}"`);

                break;
            }

            case LbsRequestKind.StreamEnd: {
                const rvStrEnd: LbsStreamEnd = msg;
                logger.info(`StreamEnd, endAt=${rvStrEnd.sessionEndAt}, path="${sclient.sessWriteStream.path}"`);
                sclient.sessWriteStream.end(() => logger.verbose(`onConnMessage sessWriteStream end`));
                sclient.sessWriteStream = void 0;
                break;
            }

            case LbsRequestKind.StreamChunk: {
                const rvStrChunk: LbsStreamChunk = msg;
                if (rvStrChunk.d.length === 0) {
                    logger.error(`Empty payload from ip=${sclient.connSocket.remoteAddress} rport=${sclient.connSocket.remotePort}, terminating conn..`);
                    ws.terminate();
                    return;
                }
                sclient.sessWriteStream.write(rvStrChunk.d, 'utf8');
                break;
            }
        }
    }

    protected onConnClose(ws: WebSocket, code: number, reason: string) {
        const sclient = this.clientsInfo.get(ws);
        logger.info(`Client disconnected: ip=${sclient.connSocket.remoteAddress} rport=${sclient.connSocket.remotePort} code=${code} reason=${reason}`);
        if (sclient.sessWriteStream) {
            logger.info(`Closing stream, bytesWritten=${sclient.sessWriteStream.bytesWritten}`);
            sclient.sessWriteStream.end(() => logger.verbose(`onConnClose sessWriteStream end`));
        }
        this.clientsInfo.delete(ws);
    }

    protected onConnPong(ws: WebSocket) {
        this.clientsInfo.get(ws).isAlive = true;
    }
}

process.on('unhandledRejection', e => { throw e; });
(async function () {
    setupFileLogger('datahost');
    const lserv = new LbsServer();

    async function terminate(sig: NodeJS.Signals) {
        logger.info(`SIGTERM received`);
        lserv.close();
    }

    process.on('SIGTERM', terminate);
    process.on('SIGINT', terminate);

    await lserv.load();
})();
