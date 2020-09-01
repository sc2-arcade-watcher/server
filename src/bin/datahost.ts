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
import { RunnerFeedCtrl } from '../server/feedCtrl';

// ===

enum MessageKind {
    Welcome                      = 0,
    RunnerIntro                  = 1,
    RunnerWelcome                = 6,

    SetStreamOffset              = 2,
    LobbyFeedBegin               = 3,
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

interface LobbyFeedBegin {
    sessionStartAt: number;
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

interface MapVersionInfo {
    mapVersion: number;
    headerHash: string;
    isExtensionMod: boolean;
    isPrivate: boolean;
}

interface MapMetadataResult {
    regionId: number;
    mapId: number;
    author: {
        regionId: number;
        realmId: number;
        profileId: number;
        name: string;
        discriminator: number;
    };
    initialRevision: MapVersionInfo;
    latestRevision: MapVersionInfo;
}

class WsClientDesc {
    isAlive: boolean = true;
    protected _isClosed: boolean = false;

    rinfo?: RunnerIntro;
    region?: S2Region;
    lobbyFeed?: RunnerFeedCtrl;

    constructor(
        public readonly connSocket: Socket,
        public readonly ws: WebSocket
    ) {
    }

    terminate() {
        if (this._isClosed) return;
        this.ws.terminate();
        this._isClosed = true;
    }

    get isClosed() {
        return this._isClosed;
    }

    get runnerName(): string {
        return this.rinfo ? `${this.rinfo.hostname}-${this.rinfo.region}` : void 0;
    }

    get addr(): string {
        return `${this.runnerName ?? '__UNKNOWN__'} [${this.connSocket.remoteAddress} :${this.connSocket.remotePort}]`;
    }
}

type FetchClientOptions = {
    regionId?: number;
    requiredCapabilities?: [keyof RunnerCapabilities];
};

export class LbsServer {
    protected conn: orm.Connection;
    protected wss: WebSocket.Server;
    protected clientsInfo = new Map<WebSocket, WsClientDesc>();
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
                    logger.info(`No response to ping from ${sclient.addr}. Terminating connection..`);
                    sclient.terminate();
                    return;
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
        this.clientsInfo.set(ws, new WsClientDesc(request.connection, ws));

        logger.info(`New connection from ip=${request.connection.remoteAddress} rport=${request.connection.remotePort}`);

        ws.on('upgrade', this.onUpgrade.bind(this, ws));
        ws.on('message', this.onConnMessage.bind(this, ws));
        ws.on('close', this.onConnClose.bind(this, ws));
        ws.on('pong', this.onConnPong.bind(this, ws));
    }

    @logIt()
    protected async onUpgrade(ws: WebSocket, request: http.IncomingMessage) {
    }

    protected async onRunnerIntro(sclient: WsClientDesc, msg: RunnerIntro) {
        const rvRunner: RunnerIntro = msg;

        sclient.rinfo = {
            hostname: rvRunner.hostname,
            region: rvRunner.region,
            capabilities: Object.assign<RunnerCapabilities | {}, RunnerCapabilities>(rvRunner.capabilities ?? {}, {
                lobbyFeed: true,
                mapResolving: false,
            }),
        };
        logger.info(`RunnerIntro: ${sclient.runnerName}`, sclient.rinfo.capabilities);

        sclient.region = this.regions.find(x => x.code === rvRunner.region);
        if (!sclient.region) {
            logger.error(`Unknown region=${rvRunner.region} @${sclient.runnerName}`);
            sclient.terminate();
            return;
        }

        const hangingClients = Array.from(this.clientsInfo.entries()).filter(x => {
            return (
                x[1] !== sclient &&
                x[1].runnerName === sclient.runnerName
            );
        });
        if (hangingClients.length) {
            out: for (const [socket, otherClient] of hangingClients) {
                logger.warn(`Terminating hanging connection of ${otherClient.addr}`);
                otherClient.terminate();
                for (let i = 0; i < 5; ++i) {
                    await sleep(1000);
                    if (socket.CLOSED && !otherClient.lobbyFeed?.activeSession) {
                        continue out;
                    }
                }
                logger.error(`Failed to terminate hanging connections.. refusing incoming connection`);
                sclient.terminate();
                return;
            }
        }

        sclient.lobbyFeed = new RunnerFeedCtrl(sclient.runnerName);
        const sessInfo = await sclient.lobbyFeed.fetchCurrentSessionInfo();
        logger.debug(`lobbyfeed session=${sessInfo?.timestamp} size=${sessInfo?.size} @${sclient.runnerName}`);

        // TODO: obsolete - remove once all runners will be updated
        const sdOffset: LbsSetDataOffset = {
            sessionStartAt: 0,
            line: 0,
            offset: 0,
        };
        if (sessInfo) {
            sdOffset.sessionStartAt = sessInfo.timestamp;
            sdOffset.offset = sessInfo.size;
        }
        sclient.ws.send(JSON.stringify({ $id: MessageKind.SetStreamOffset, ...sdOffset }));
        // END

        sclient.ws.send(JSON.stringify({ $id: MessageKind.RunnerWelcome, ...{
            lastFeed: {
                session: sessInfo?.timestamp ?? 0,
                offset: sessInfo?.size ?? 0,
            },
            mapProgressOffsetId: sclient.region.mapProgress.offsetMapId,
        } as RunnerWelcome }));
    }

    protected async onConnMessage(ws: WebSocket, message: WebSocket.Data) {
        const sclient = this.clientsInfo.get(ws);
        if (sclient.isClosed) return;

        if (message instanceof Buffer) {
            sclient.lobbyFeed.write(message.toString('utf8'));
            return;
        }
        else if (typeof message !== 'string') {
            logger.warning(`unknown message datatype`, typeof message, message);
            return;
        }

        const msg = JSON.parse(message);
        const msgKind = Number(msg.$id);

        switch (msgKind as MessageKind) {
            case MessageKind.RunnerIntro: {
                this.onRunnerIntro(sclient, msg);
                break;
            }

            case MessageKind.LobbyFeedBegin: {
                const rvStrBeg: LobbyFeedBegin = msg;

                logger.info(`LobbyFeedBegin, sess=${rvStrBeg.sessionStartAt}+${rvStrBeg.offset} @${sclient.runnerName}`);
                sclient.lobbyFeed.beginSession(rvStrBeg.sessionStartAt, rvStrBeg.offset);

                break;
            }

            case MessageKind.StreamEnd: {
                const rvStrEnd: LbsStreamEnd = msg;
                logger.info(`StreamEnd, endAt=${rvStrEnd.sessionEndAt} @${sclient.runnerName}`);
                await sclient.lobbyFeed.endSession();
                break;
            }

            case MessageKind.StreamChunk: {
                const rvStrChunk: LbsStreamChunk = msg;
                if (rvStrChunk.d.length === 0) {
                    logger.error(`Empty payload from ${sclient.addr}, terminating conn..`);
                    sclient.terminate();
                    return;
                }
                if (!sclient.lobbyFeed.write(rvStrChunk.d)) {
                    logger.error(`Failed to write to lobby feed?! @${sclient.runnerName}`);
                    sclient.terminate();
                    return;
                }
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
            const mapHeader = await this.mapResolver.initializeMapHeader(mhead, msg.isInitialVersion);
            logger.info(`resolved map=${mhead.regionId}/${mhead.bnetId} v${mhead.majorVersion}.${mhead.minorVersion} name=${mapHeader.filename} uploadTime=${mhead.uploadedAt.toUTCString()}`);
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

    protected async onConnClose(ws: WebSocket, code: number, reason: string) {
        const sclient = this.clientsInfo.get(ws);
        logger.info(`Client disconnected ${sclient.addr} code=${code} reason=${reason}`);
        if (sclient.lobbyFeed) {
            await sclient.lobbyFeed.endSession();
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
