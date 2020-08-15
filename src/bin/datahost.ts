import * as util from 'util';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as WebSocket from 'ws';
import * as dotenv from 'dotenv';
import * as orm from 'typeorm';
import PQueue from 'p-queue';
import { logger, logIt, setupFileLogger } from '../logger';
import { Socket } from 'net';
import { execAsync, sleep } from '../helpers';
import { S2Region } from '../entity/S2Region';
import { S2MapHeader } from '../entity/S2MapHeader';
import { MapResolver } from '../task/mapResolver';

interface RunnerSessionFeed {
    startedAt: number;
    lastUpdateAt: number;
    size: number;
}

class RunnerFeedCtrl {
    readonly id: string;
    readonly hname: string;
    readonly region: string;

    constructor(id: string, hostName: string, region: string) {
        this.id = id;
        this.hname = hostName;
        this.region = region;
    }

    @logIt()
    async getCurrentSession(): Promise<RunnerSessionFeed> {
        const result = await execAsync(`fd -t f . "${FeedStorage.storageDir}/${this.id}/" -x echo "{/.} {}" | sort -h | cut -d " " -f 2-`);
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
        const fname = path.join(FeedStorage.storageDir, this.id, sessTimestamp.toString());
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

class FeedStorage {
    static storageDir = 'data/lbstream';
    protected runnerInfo = new Map<string, RunnerFeedCtrl>();

    async load() {
        for (const runnerId of await fs.readdir(FeedStorage.storageDir)) {
            const fstat = await fs.stat(path.join(FeedStorage.storageDir, runnerId));
            if (!fstat.isDirectory()) continue;

            const m = runnerId.match(/^(.*)-(EU|KR|US)$/);
            const rInfo = new RunnerFeedCtrl(runnerId, m[1], m[2]);
            this.runnerInfo.set(rInfo.id, rInfo);
        }
    }

    async createRunner(hname: string, region: string) {
        const runnerId = `${hname}-${region}`;
        const rInfo = new RunnerFeedCtrl(runnerId, hname, region);
        this.runnerInfo.set(runnerId, rInfo);
        await fs.ensureDir(path.join(FeedStorage.storageDir, runnerId));
        return rInfo;
    }

    getRunners() {
        return this.runnerInfo as ReadonlyMap<string, RunnerFeedCtrl>;
    }
}

// ===

enum MessageKind {
    Welcome                      = 0,
    RunnerIntro                  = 1,
    RunnerWelcome                = 6,

    SetStreamOffset              = 2,
    StreamBegin                  = 3,
    StreamEnd                    = 4,
    StreamChunk                  = 5,

    MapHeaderResult              = 10,
    MapHeaderAck                 = 11,
    // MapInfoRequest               = 12,
    // MapInfoResult                = 13,
    // MapInfoAck                   = 14,
}

interface RunnerCapabilities {
    lobbyFeed: boolean;
    mapResolving: boolean;
}

interface RunnerIntro {
    hostname: string;
    region: string;
    capabilities?: RunnerCapabilities;
}

interface RunnerWelcome {
    lastFeed: {
        session: number;
        offset: number;
    };
    mapProgressOffsetId: number;
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

interface MapHeaderResult {
    regionId: number;
    mapId: number;
    mapVersion: number;
    headerHash: string;
    isExtensionMod: boolean;
    isPrivate: boolean;
    isInitialVersion: boolean;
}

interface MapHeaderAck {
    regionId: number;
    mapId: number;
    mapVersion: number;
}

interface WsClientDesc {
    isAlive: boolean;
    connSocket: Socket;
    ws: WebSocket;
    rinfo?: RunnerIntro;
    region?: S2Region;
    runnerFeedInfo?: RunnerFeedCtrl;
    sessInfo?: RunnerSessionFeed;
    sessWriteStream?: fs.WriteStream;
}

type FetchClientOptions = {
    regionId?: number;
    requiredCapabilities?: [keyof RunnerCapabilities];
};

export class LbsServer {
    protected conn: orm.Connection;
    protected wss: WebSocket.Server;
    protected clientsInfo = new Map<WebSocket, WsClientDesc>();
    protected fStorage = new FeedStorage();
    protected regions: S2Region[] = [];
    protected mapResolver: MapResolver;
    protected mapHeaderQueue = new PQueue({
        concurrency: Number(process.env.STARC_DHOST_MR_QUEUE_LIMIT) || 8,
    });

    private async setupDbConn() {
        this.conn = await orm.createConnection();
        this.mapResolver = new MapResolver(this.conn);
        this.regions = await this.conn.getRepository(S2Region).find({
            relations: ['mapProgress'],
            order: { id: 'ASC' },
        });
    }

    protected getActiveRunners(options: FetchClientOptions = {}) {
        const matchingRunners: WsClientDesc[] = [];
        out: for (const item of this.clientsInfo.values()) {
            if (!item.rinfo) continue;
            if (options.regionId && options.regionId !== item.region!.id) continue;
            if (options.requiredCapabilities) {
                for (const k of options.requiredCapabilities) {
                    if (!item.rinfo!.capabilities[k]) continue out;
                }
            }
            matchingRunners.push(item);
        }
        return matchingRunners;
    }

    @logIt()
    async load() {
        await this.setupDbConn();
        await this.fStorage.load();
        this.wss = new WebSocket.Server({
            port: 8089,
            verifyClient: this.verifyClient.bind(this),
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
                    logger.info(`No response to ping from ${sclient?.runnerFeedInfo.id}. Terminating connection..`);
                    return ws.terminate();
                }

                sclient.isAlive = false;
                ws.ping();
            });
        }, 30000).unref();
    }

    protected verifyClient(info: { origin: string; secure: boolean; req: http.IncomingMessage }) {
        logger.verbose(`verifying connection from ${info.req.connection.remoteAddress} rport=${info.req.connection.remotePort}`);
        const reBearer = /^Bearer (.+)$/;
        if (!info.req.headers.authorization) {
            logger.verbose(`no authorization header`);
            return false;
        }

        const matches = info.req.headers.authorization.match(reBearer);
        if (!matches) {
            logger.verbose(`no bearer token provided`);
            return false;
        }

        if (matches[1] !== process.env.DPROC_AUTH_TOKEN) {
            logger.verbose(`provided invalid token: "${matches[1]}"`);
            return false;
        }

        return true;
    }

    @logIt({ profiling: false })
    async close() {
        logger.verbose(`Pausing mapHeaderQueue.. qsize=${this.mapHeaderQueue.size}`);
        this.mapHeaderQueue.pause();
        logger.verbose(`Closing websocket..`);
        this.wss.close();
        logger.verbose(`Shutting down DB connection..`);
        await this.conn.close();
    }

    protected async onNewConnection(ws: WebSocket, request: http.IncomingMessage) {
        this.clientsInfo.set(ws, {
            ws: ws,
            isAlive: true,
            connSocket: request.connection,
        });

        logger.info(`New connection from ip=${request.connection.remoteAddress} rport=${request.connection.remotePort}`);

        ws.on('upgrade', this.onUpgrade.bind(this, ws));
        ws.on('message', this.onConnMessage.bind(this, ws));
        ws.on('close', this.onConnClose.bind(this, ws));
        ws.on('pong', this.onConnPong.bind(this, ws));
    }

    @logIt()
    protected async onUpgrade(ws: WebSocket, request: http.IncomingMessage) {
    }

    protected async onConnMessage(ws: WebSocket, message: WebSocket.Data) {
        const sclient = this.clientsInfo.get(ws);
        const msg = JSON.parse(message as string);

        // logger.debug(`msg ip=${sclient.connSocket.remoteAddress} rport=${sclient.connSocket.remotePort}`, msg);

        const msgKind = Number(msg.$id);
        switch (msgKind as MessageKind) {
            case MessageKind.RunnerIntro: {
                const rvRunner: RunnerIntro = msg;

                logger.info(`RunnerIntro: ip=${sclient.connSocket.remoteAddress} rport=${sclient.connSocket.remotePort}`, rvRunner);
                sclient.rinfo = {
                    hostname: rvRunner.hostname,
                    region: rvRunner.region,
                    capabilities: Object.assign<RunnerCapabilities | {}, RunnerCapabilities>(rvRunner.capabilities ?? {}, {
                        lobbyFeed: true,
                        mapResolving: true,
                    }),
                };
                sclient.region = this.regions.find(x => x.code === rvRunner.region);
                if (!sclient.region) {
                    logger.error(`Unknown region=${rvRunner.region}`);
                    ws.terminate();
                    return;
                }

                const rnKey = `${rvRunner.hostname}-${rvRunner.region}`;
                let rnInfo = this.fStorage.getRunners().get(rnKey);
                if (!rnInfo) {
                    rnInfo = await this.fStorage.createRunner(rvRunner.hostname, rvRunner.region);
                }

                const dupedClients = Array.from(this.clientsInfo.entries()).filter(x => {
                    return (
                        x[1] !== sclient &&
                        x[1].runnerFeedInfo?.id === rnInfo.id
                    );
                });
                if (dupedClients.length) {
                    out: for (const [socket, client] of dupedClients) {
                        logger.warn(`Terminating extra connection of ${client.runnerFeedInfo.id} rport=${client.connSocket.remotePort}`);
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

                sclient.runnerFeedInfo = rnInfo;
                sclient.sessInfo = await rnInfo.getCurrentSession();
                logger.verbose('sessInfo', sclient.sessInfo);

                // TODO: obsolete - remove once all runners will be updated
                const sdOffset: LbsSetDataOffset = {
                    sessionStartAt: 0,
                    line: 0,
                    offset: 0,
                };
                if (sclient.sessInfo) {
                    sdOffset.sessionStartAt = sclient.sessInfo.startedAt;
                    sdOffset.offset = sclient.sessInfo.size;
                }
                ws.send(JSON.stringify({ $id: MessageKind.SetStreamOffset, ...sdOffset }));
                // END

                ws.send(JSON.stringify({ $id: MessageKind.RunnerWelcome, ...{
                    lastFeed: {
                        session: sclient.sessInfo?.startedAt ?? 0,
                        offset: sclient.sessInfo?.size ?? 0,
                    },
                    mapProgressOffsetId: sclient.region.mapProgress.offsetMapId,
                } as RunnerWelcome }));

                break;
            }

            case MessageKind.StreamBegin: {
                const rvStrBeg: LbsStreamBegin = msg;

                const rnInfo = sclient.runnerFeedInfo;
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

            case MessageKind.StreamEnd: {
                const rvStrEnd: LbsStreamEnd = msg;
                logger.info(`StreamEnd, endAt=${rvStrEnd.sessionEndAt}, path="${sclient.sessWriteStream.path}"`);
                sclient.sessWriteStream.end(() => logger.verbose(`onConnMessage sessWriteStream end`));
                sclient.sessWriteStream = void 0;
                break;
            }

            case MessageKind.StreamChunk: {
                const rvStrChunk: LbsStreamChunk = msg;
                if (rvStrChunk.d.length === 0) {
                    logger.error(`Empty payload from ip=${sclient.connSocket.remoteAddress} rport=${sclient.connSocket.remotePort}, terminating conn..`);
                    ws.terminate();
                    return;
                }
                sclient.sessWriteStream.write(rvStrChunk.d, 'utf8');
                break;
            }

            case MessageKind.MapHeaderResult: {
                await this.onMapHeaderResult(sclient, <MapHeaderResult>msg);
                break;
            }

            default: {
                logger.warn(`Received unknown message kind=${msgKind} ip=${sclient.connSocket.remoteAddress} rport=${sclient.connSocket.remotePort}`, msg);
                break;
            }
        }
    }

    protected async onMapHeaderResult(sclient: WsClientDesc, msg: MapHeaderResult) {
        logger.debug(`received map header, regionId=${msg.regionId} mhandle=${msg.mapId},${msg.mapVersion}, qsize=${this.mapHeaderQueue.pending}`);
        this.mapHeaderQueue.add(async () => {
            try {
                await this.processMapHeader(msg);
            }
            catch (e) {
                logger.error('processing map header fail', msg, e);
            }
        });
    }

    protected async processMapHeader(msg: MapHeaderResult) {
        const [ majorVer, minorVer ] = [(msg.mapVersion >> 16) & 0xFFFF, (msg.mapVersion) & 0xFFFF];
        let mhead = await this.conn.getRepository(S2MapHeader).findOne({
            where: {
                regionId: msg.regionId,
                bnetId: msg.mapId,
                majorVersion: majorVer,
                minorVersion: minorVer,
            },
        });

        let doUpdate = false;
        if (!mhead) {
            mhead = new S2MapHeader();
            mhead.regionId = msg.regionId;
            mhead.bnetId = msg.mapId;
            mhead.majorVersion = majorVer;
            mhead.minorVersion = minorVer;
            mhead.headerHash = msg.headerHash;
            mhead.isPrivate = msg.isPrivate;
            mhead.isExtensionMod = msg.isExtensionMod;
            doUpdate = true;
        }
        else if (msg.isInitialVersion) {
            doUpdate = true;
        }

        if (doUpdate) {
            await this.mapResolver.initializeMapHeader(mhead, msg.isInitialVersion);
        }
        else {
            logger.debug(`skiping map header init for ${msg.mapId},${msg.mapVersion}`);
        }

        this.getActiveRunners({
            regionId: mhead.regionId,
            requiredCapabilities: [
                'mapResolving',
            ],
        }).forEach(x => {
            x.ws.send(JSON.stringify({
                $id: MessageKind.MapHeaderAck,
                ...{
                    regionId: msg.regionId,
                    mapId: msg.mapId,
                    mapVersion: msg.mapVersion,
                } as MapHeaderAck
            }));
        });
    }

    protected onConnClose(ws: WebSocket, code: number, reason: string) {
        const sclient = this.clientsInfo.get(ws);
        logger.info(`Client disconnected: ip=${sclient.connSocket.remoteAddress} rport=${sclient.connSocket.remotePort} code=${code} reason=${reason}`);
        if (sclient.sessWriteStream) {
            logger.info(`Closing stream, bytesWritten=${sclient.sessWriteStream.bytesWritten}`);
            sclient.sessWriteStream.end(() => logger.verbose(`onConnClose sessWriteStream end`));
            sclient.sessWriteStream = void 0;
        }
        this.clientsInfo.delete(ws);
    }

    protected onConnPong(ws: WebSocket) {
        this.clientsInfo.get(ws).isAlive = true;
    }
}

process.on('unhandledRejection', e => { throw e; });
(async function () {
    dotenv.config();
    setupFileLogger('datahost');
    const lserv = new LbsServer();

    async function terminate(sig: NodeJS.Signals) {
        logger.info(`${sig} received`);
        await lserv.close();
    }

    process.on('SIGTERM', terminate);
    process.on('SIGINT', terminate);

    await lserv.load();
})();
