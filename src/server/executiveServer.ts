import * as http from 'http';
import * as WebSocket from 'ws';
import * as orm from 'typeorm';
import { logger, logIt } from '../logger';
import { Socket } from 'net';
import { sleep, throwErrIfNotDuplicateEntry } from '../helpers';
import { S2Region } from '../entity/S2Region';
import { PlayerProfile } from '../common';
import { RunnerFeedCtrl } from './feedCtrl';
import { MapIndexer } from '../map/mapIndexer';
import { S2MapTracking } from '../entity/S2MapTracking';

// ===

export enum MessageKind {
    Acknowledge                  = 0,
    RunnerIntro                  = 1,
    RunnerWelcome                = 6,

    SetStreamOffset              = 2,
    LobbyFeedBegin               = 3,
    StreamEnd                    = 4,
    StreamChunk                  = 5,

    MapRevisionResult            = 10,
    MapRevisionAck               = 11,

    MapDiscoverRequest           = 21,
    MapDiscoverResult            = 22,

    MapUnavailableReport         = 30,
}

interface MessageBase {
    $id: MessageKind;
    $version: number;
}

interface MessageAcknowledgeable extends MessageBase {
    $token: number;
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

interface MessageRunnerWelcome extends MessageBase {
    $id: MessageKind.RunnerWelcome;
    lastFeed: {
        session: number;
        offset: number;
    };
}

// ===========================
// - LOBBY FEED
// ===========================

interface MessageLobbyFeedBegin extends MessageBase {
    sessionStartAt: number;
    offset: number;
}

// ===========================
// - old lobby feed stream handlers, to be removed
// ===========================

interface LbsSetDataOffset {
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

// ===========================
// - MAP
// ===========================

export interface MessageMapRevisionResult extends MessageBase {
    $id: MessageKind.MapRevisionResult;
    queriedAt: number;
    regionId: number;
    mapId: number;
    mapVersion: number;
    headerHash: string;
    isExtensionMod: boolean;
    isPrivate: boolean;
}

interface MessageMapRevisionAck extends MessageBase {
    $id: MessageKind.MapRevisionAck;
    regionId: number;
    mapId: number;
    mapVersion: number;
}

export interface MapVersionInfo {
    mapVersion: number;
    headerHash: string;
    isExtensionMod: boolean;
    isPrivate: boolean;
}

export interface MessageMapDiscoverResult extends MessageAcknowledgeable {
    $id: MessageKind.MapDiscoverResult;
    queriedAt: number;
    regionId: number;
    mapId: number;
    author: PlayerProfile;
    initialRevision: MapVersionInfo;
    latestRevision: MapVersionInfo;
}

interface MessageMapUnavailableReport extends MessageAcknowledgeable {
    $id: MessageKind.MapUnavailableReport;
    queriedAt: number;
    regionId: number;
    mapId: number;
}

// ===========================
// -
// ===========================

class ConnectedRunner {
    isAlive: boolean = true;
    protected _isClosed: boolean = false;

    rnInfo?: RunnerIntro;
    region?: S2Region;
    lobbyFeed?: RunnerFeedCtrl;

    constructor(
        public readonly connSocket: Socket,
        public readonly ws: WebSocket
    ) {
    }

    get isTerminated() {
        return this._isClosed;
    }

    get runnerName(): string {
        return this.rnInfo ? `${this.rnInfo.hostname}-${this.rnInfo.region}` : void 0;
    }

    get addr(): string {
        return `${this.runnerName ?? '<unknown>'} [${this.connSocket.remoteAddress} :${this.connSocket.remotePort}]`;
    }

    terminate() {
        if (this._isClosed) return;
        this.ws.terminate();
        this._isClosed = true;
    }

    sendMessage<T extends MessageBase>(msg: T) {
        this.ws.send(JSON.stringify(msg));
    }

    acknowledgeMessage<T extends MessageAcknowledgeable>(msg: T) {
        this.ws.send(JSON.stringify({
            $id: MessageKind.Acknowledge,
            $version: 1,
            $token: msg.$token,
        }));
    }
}

interface RunnerFilters {
    regionId?: number;
    requiredCapabilities?: [keyof RunnerCapabilities];
}

export class ExecutiveServer {
    protected conn: orm.Connection;
    protected wss: WebSocket.Server;
    protected clientsInfo = new Map<WebSocket, ConnectedRunner>();
    protected regions: S2Region[] = [];
    protected mapIndexer: MapIndexer;

    private async setupDbConn() {
        this.conn = await orm.createConnection();
        this.regions = await this.conn.getRepository(S2Region).find({
            order: { id: 'ASC' },
        });
    }

    protected getActiveRunners(options: RunnerFilters = {}) {
        const matchingRunners: ConnectedRunner[] = [];
        out: for (const item of this.clientsInfo.values()) {
            if (!item.rnInfo) continue;
            if (options.regionId && options.regionId !== item.region!.id) continue;
            if (options.requiredCapabilities) {
                for (const k of options.requiredCapabilities) {
                    if (!item.rnInfo!.capabilities[k]) continue out;
                }
            }
            matchingRunners.push(item);
        }
        return matchingRunners;
    }

    @logIt()
    async load() {
        await this.setupDbConn();
        this.mapIndexer = new MapIndexer(this.conn);
        await this.mapIndexer.load();

        this.wss = new WebSocket.Server({
            port: 8089,
            verifyClient: this.verifyClient.bind(this),
        });

        this.wss.on('listening', async function() {
            logger.info(`WebSocket listening..`);
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

    @logIt({ profiling: false })
    async close() {
        logger.verbose(`Closing websocket..`);
        this.wss.close();

        await this.mapIndexer.close();

        logger.verbose(`Shutting down DB connection..`);
        await this.conn.close();
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

    protected async onNewConnection(ws: WebSocket, request: http.IncomingMessage) {
        const cnRunner = new ConnectedRunner(request.connection, ws);
        this.clientsInfo.set(ws, cnRunner);

        logger.info(`New connection @${cnRunner.addr}`);

        ws.on('upgrade', this.onUpgrade.bind(this, ws));
        ws.on('message', this.onConnMessage.bind(this, ws));
        ws.on('close', this.onConnClose.bind(this, ws));
        ws.on('pong', this.onConnPong.bind(this, ws));
    }

    @logIt()
    protected async onUpgrade(ws: WebSocket, request: http.IncomingMessage) {
    }

    protected async onConnMessage(ws: WebSocket, message: WebSocket.Data) {
        const cvRunner = this.clientsInfo.get(ws);
        if (cvRunner.isTerminated) return;

        if (message instanceof Buffer) {
            cvRunner.lobbyFeed.write(message.toString('utf8'));
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
                await this.onRunnerIntro(cvRunner, msg);
                break;
            }

            case MessageKind.LobbyFeedBegin: {
                await this.onLobbyFeedBegin(cvRunner, msg);
                break;
            }

            case MessageKind.StreamEnd: {
                const rvStrEnd: LbsStreamEnd = msg;
                logger.info(`StreamEnd, endAt=${rvStrEnd.sessionEndAt} @${cvRunner.runnerName}`);
                // await cvRunner.lobbyFeed.endSession();
                break;
            }

            case MessageKind.StreamChunk: {
                const rvStrChunk: LbsStreamChunk = msg;
                if (rvStrChunk.d.length === 0) {
                    logger.error(`Empty payload from ${cvRunner.addr}, terminating conn..`);
                    cvRunner.terminate();
                    return;
                }
                cvRunner.lobbyFeed.write(rvStrChunk.d);
                break;
            }

            case MessageKind.MapRevisionResult: {
                await this.onMapHeaderResult(cvRunner, msg);
                break;
            }

            case MessageKind.MapDiscoverResult: {
                await this.onMapDiscoverResult(cvRunner, msg);
                break;
            }

            case MessageKind.MapUnavailableReport: {
                await this.onMapUnavailableReport(cvRunner, msg);
                break;
            }

            default: {
                logger.warn(`Received unknown message kind=${msgKind} ip=${cvRunner.connSocket.remoteAddress} rport=${cvRunner.connSocket.remotePort}`, msg);
                break;
            }
        }
    }

    protected async checkHangingConnections(cnRunner: ConnectedRunner) {
        const hangingClients = Array.from(this.clientsInfo.entries()).filter(x => {
            return (
                x[1] !== cnRunner &&
                x[1].runnerName === cnRunner.runnerName
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
                cnRunner.terminate();
                return false;
            }
        }
        return true;
    }

    protected async onRunnerIntro(cnRunner: ConnectedRunner, rnIntro: RunnerIntro) {
        cnRunner.rnInfo = {
            hostname: rnIntro.hostname,
            region: rnIntro.region,
            capabilities: Object.assign({
                lobbyFeed: true,
                mapResolving: false,
            }, rnIntro.capabilities ?? {} as RunnerCapabilities),
        };
        logger.info(`RunnerIntro: ${cnRunner.runnerName}`, cnRunner.rnInfo.capabilities);

        cnRunner.region = this.regions.find(x => x.code === rnIntro.region);
        if (!cnRunner.region) {
            logger.error(`Unknown region=${rnIntro.region} @${cnRunner.runnerName}`);
            cnRunner.terminate();
            return;
        }

        if (!(await this.checkHangingConnections(cnRunner))) {
            return;
        }

        cnRunner.lobbyFeed = new RunnerFeedCtrl(cnRunner.runnerName);
        const sessInfo = await cnRunner.lobbyFeed.fetchCurrentSessionInfo();
        logger.debug(`lobbyfeed session=${sessInfo?.timestamp} size=${sessInfo?.size} @${cnRunner.runnerName}`);

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
        cnRunner.ws.send(JSON.stringify({ $id: MessageKind.SetStreamOffset, ...sdOffset }));
        // END

        cnRunner.sendMessage<MessageRunnerWelcome>({
            $id: MessageKind.RunnerWelcome,
            $version: 1,
            lastFeed: {
                session: sessInfo?.timestamp ?? 0,
                offset: sessInfo?.size ?? 0,
            },
        });
    }

    protected async onLobbyFeedBegin(cnRunner: ConnectedRunner, msg: MessageLobbyFeedBegin) {
        logger.info(`LobbyFeedBegin, sess=${msg.sessionStartAt}+${msg.offset} @${cnRunner.runnerName}`);
        cnRunner.lobbyFeed.beginSession(msg.sessionStartAt, msg.offset);
    }

    protected async onMapHeaderResult(cnRunner: ConnectedRunner, msg: MessageMapRevisionResult) {
        logger.debug(`received map revision, map=${msg.regionId}/${msg.mapId},${msg.mapVersion}`);
        try {
            await this.mapIndexer.add(msg);
            cnRunner.sendMessage<MessageMapRevisionAck>({
                $id: MessageKind.MapRevisionAck,
                $version: 1,
                regionId: msg.regionId,
                mapId: msg.mapId,
                mapVersion: msg.mapVersion,
            });
        }
        catch (e) {
            logger.error('processing map revision fail', msg, e);
        }
    }

    protected async onMapDiscoverResult(cnRunner: ConnectedRunner, msg: MessageMapDiscoverResult) {
        logger.debug(`received map discover, map=${msg.regionId}/${msg.mapId}`);
        try {
            await this.mapIndexer.add(msg);
            cnRunner.acknowledgeMessage(msg);
        }
        catch (e) {
            logger.error('processing map discover fail', msg, e);
        }
    }

    protected async onMapUnavailableReport(cnRunner: ConnectedRunner, msg: MessageMapUnavailableReport) {
        const dateQuery = new Date(msg.queriedAt * 1000);
        logger.debug(`received map unavailable report, map=${msg.regionId}/${msg.mapId} date=${dateQuery}`);
        let mtrack = await this.conn.getRepository(S2MapTracking).findOne({
            where: {
                regionId: msg.regionId,
                bnetId: msg.mapId,
            },
        });
        if (!mtrack) {
            mtrack = new S2MapTracking();
            mtrack.regionId = msg.regionId;
            mtrack.bnetId = msg.mapId;
        }

        if (mtrack.lastCheckedAt > dateQuery) {
            logger.debug(`received report outdated, map=${msg.regionId}/${msg.mapId} date=${dateQuery} lastCheckedAt=${mtrack.lastCheckedAt}`);
            cnRunner.acknowledgeMessage(msg);
            return;
        }

        // increase unavailabilityCounter only for reports which are at least newer by one day
        if (mtrack.unavailabilityCounter > 0 && (dateQuery.getTime() - mtrack.lastCheckedAt.getTime()) < 24 * 3600 * 1000) {
            logger.debug(`received report irrelevant, map=${msg.regionId}/${msg.mapId} date=${dateQuery} lastCheckedAt=${mtrack.lastCheckedAt}`);
            cnRunner.acknowledgeMessage(msg);
            return;
        }

        mtrack.lastCheckedAt = dateQuery;
        if (mtrack.firstSeenUnvailableAt !== null) {
            mtrack.firstSeenUnvailableAt = dateQuery;
        }
        mtrack.unavailabilityCounter += 1;

        try {
            await this.conn.getRepository(S2MapTracking).save(mtrack, { transaction: false });
            cnRunner.acknowledgeMessage(msg);
        }
        catch (err) {
            throwErrIfNotDuplicateEntry(err);
        }
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

