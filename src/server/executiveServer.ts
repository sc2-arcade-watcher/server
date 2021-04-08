import * as http from 'http';
import * as WebSocket from 'ws';
import * as orm from 'typeorm';
import { logger, logIt } from '../logger';
import { Socket } from 'net';
import { Queue, Worker, QueueBase, Job } from 'bullmq';
import { sleep, TypedEvent } from '../helpers';
import { PlayerProfile, GameRegion } from '../common';
import { RunnerFeedCtrl } from './feedCtrl';
import { MapIndexer } from '../map/mapIndexer';
import { profileHandle } from '../bnet/common';
import { oneLine } from 'common-tags';
import { S2MapTrackingRepository } from '../repository/S2MapTrackingRepository';
import { CmdKind, CmdWorkerRegionGroup, createCmdWorkerRegionGroup, CmdWorkerKindGroup, CmdMrevRequest, CmdKindType, CmdWorkerKindEntry, createCmdWorker, DataRecordType, createDataRecordQueue, ProfileDiscover, DataRecordKind, cmdKindToRecordKind, createCmdQueue } from './runnerExchange';

// ===

export enum MessageKind {
    Acknowledge                  = 0,
    Reply                        = 2,
    RunnerIntro                  = 1,
    RunnerWelcome                = 6,

    // SetStreamOffset              = 2,
    LobbyFeedBegin               = 3,
    // StreamEnd                    = 4,
    // StreamChunk                  = 5,

    MapRevisionResult            = 10,
    MapRevisionAck               = 11,
    MapDiscoverRequest           = 21,
    MapDiscoverResult            = 22,
    MapUnavailableReport         = 30,
    ProfileDiscoverResult        = 41,
    // MapReviewsDiscoverResult     = 51,
    // S2CmdAccept                  = 60,
    S2CmdPostRequest             = 61,
    S2CmdPostResponse            = 62,
}

interface MessageBase {
    $id: MessageKind;
    $v: number;
    $token?: number;
}

interface MessageAcknowledgeable extends MessageBase {
}

interface MessageReplyable extends MessageBase {
}

interface MessageReply extends MessageBase {
    $id: MessageKind.Reply;
    $replyTo: number;
}

interface RunnerCapabilities {
    lobbyFeed: boolean;
}

interface RunnerIntro {
    hostname: string;
    region: string;
    capabilities: RunnerCapabilities;
    cmdQueues: S2CmdQueueStatus[];
}

interface RunnerWelcome {
    lastFeed: {
        session: number;
        offset: number;
    };
}

interface MessageRunnerWelcome extends MessageBase, RunnerWelcome {
    $id: MessageKind.RunnerWelcome;
}

// ===========================
// - LOBBY FEED
// ===========================

interface MessageLobbyFeedBegin extends MessageBase {
    sessionStartAt: number;
    offset: number;
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
    versions: MapVersionInfo[];
}

interface MessageMapUnavailableReport extends MessageAcknowledgeable {
    $id: MessageKind.MapUnavailableReport;
    queriedAt: number;
    regionId: number;
    mapId: number;
}

// ===========================
// - PROFILE
// ===========================

export interface MessageProfileDiscoverResult extends MessageAcknowledgeable, ProfileDiscover {
    $id: MessageKind.ProfileDiscoverResult;
}

// ===========================
// - S2Cmd
// ===========================

export interface S2CmdRequestBase {
    ckind: CmdKindType;
    id: string;
    priority?: number;
    data: any;
}

export interface S2CmdRequestMrev extends S2CmdRequestBase {
    data: CmdMrevRequest;
}

export type S2CmdRequest = (
    S2CmdRequestMrev
);

export interface S2CmdResponse<T = any> {
    ckind: CmdKindType;
    id: string;
    success: boolean;
    error?: string;
    result?: T;
}

export interface S2CmdQueueStatus {
    ckind: CmdKindType;
    pendingCount: number;
    queueLimit: number;
}

export interface MessageBodyS2CmdPostRequest {
    requests: S2CmdRequest[];
}

export interface MessageS2CmdPostRequest extends MessageBase, MessageBodyS2CmdPostRequest {
    $id: MessageKind.S2CmdPostRequest;
}

export interface MessageBodyS2CmdPostResponse {
    responses: S2CmdResponse[];
}

export interface MessageS2CmdPostResponse extends MessageAcknowledgeable, MessageBodyS2CmdPostResponse {
    $id: MessageKind.S2CmdPostResponse;
}

// ===========================
// -
// ===========================

class RunnerCmdProcessor<T = any, R = any> {
    protected worker: Worker<T>;
    // protected queue: Queue<T>;
    protected activeCmds = new Map<string, TypedEvent<S2CmdResponse<R>>>();
    protected _onStatusUpdate = new TypedEvent<void>();
    protected _onClose = new TypedEvent<void>();

    constructor(
        protected readonly cr: ConnectedRunner,
        protected readonly dataRecQueue: Queue<DataRecordType>,
        protected readonly queue: Queue<T>,
        public readonly ckind: CmdKind,
        protected status: S2CmdQueueStatus
    ) {
    }

    protected async proc(job: Job<T>) {
        const ev = new TypedEvent<S2CmdResponse<R>>();
        if (this.activeCmds.has(job.id)) {
            throw new Error('???');
        }
        this.activeCmds.set(job.id, ev);
        const request = {
            ckind: this.ckind,
            id: job.id,
            data: job.data as any,
        };
        this.cr.request<MessageBodyS2CmdPostRequest>(MessageKind.S2CmdPostRequest, {
            requests: [request],
        });
        const response: S2CmdResponse<R> = await new Promise((resolve, reject) => {
            const tmp = this._onClose.once(() => {
                this.activeCmds.delete(job.id);
                reject(new Error(`connection with runner interrupted`));
            });
            ev.once((r) => {
                this.activeCmds.delete(job.id);
                tmp.dispose();
                resolve(r);
            });
        });
        if (!response.success) {
            logger.warn(`[${GameRegion[this.cr.context.region]}][${this.ckind}] job ${job.id} failed due to: ${response.error}`, request);
            // job.moveToFailed(response.error, );
            throw new Error(response.error);
        }

        const djob = await this.dataRecQueue.add(`${GameRegion[this.cr.context.region].toLowerCase()}_${job.name}`, {
            dkind: cmdKindToRecordKind(this.ckind),
            payload: response.result as any,
        });
        return djob.id;
    }

    run() {
        if (this.worker) return;
        // if (this.queue) return;
        // this.queue = createCmdQueue(this.ckind, this.cr.context.region);
        this.worker = createCmdWorker(this.ckind, this.cr.context.region, this.proc.bind(this), {
            concurrency: this.status.queueLimit,
        });
        // this.worker = createCmdWorker(this.ckind, this.cr.context.region, null);
        // this.worker.getNextJob();
    }

    updateStatus(pendingCount: number) {
        this.status.pendingCount = pendingCount;
        if (this.status.pendingCount < this.status.queueLimit) {
            this._onStatusUpdate.emit();
        }
    }

    async postResponse(response: S2CmdResponse) {
        const ev = this.activeCmds.get(response.id);
        if (!ev) {
            const job = await this.queue.getJob(response.id);
            if (job) {
                // const djob = await this.dataRecQueue.add(job.name, {
                //     dkind: cmdKindToRecordKind(this.ckind),
                //     payload: response.result as any,
                // });
                // await job.extendLock(this.cr.runnerName, 10000);
                // await job.moveToCompleted(djob.id, this.cr.runnerName, false);
            }
            else {
            }
            logger.warn(`[${this.ckind}] response for "${job?.name ?? '???'}" [${response.id}] is unknown in context of ${this.cr.runnerName}`);
            return;
        }
        ev.emit(response);
    }

    async close() {
        if (!this.worker) return;
        // Array.from(this.activeCmds.keys()).map(x => x)
        this._onClose.emit();
        await this.worker.pause(false);
        await this.worker.close(false);
        await this.worker.disconnect();
    }
}

class RunnerContext {
    readonly region: GameRegion;
    readonly capabilities: RunnerCapabilities;
    readonly cmdProcessor: {
        [key: string]: RunnerCmdProcessor,
    };
}

class ConnectedRunner {
    isAlive: boolean = true;
    protected _isClosed: boolean = false;

    rnInfo?: RunnerIntro;
    context?: RunnerContext;
    lobbyFeed?: RunnerFeedCtrl;
    protected idCounter: number = 0;

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

    async close() {
        if (this._isClosed) return;
        this._isClosed = true;
        this.ws.terminate();
        await Promise.all([
            ...Object.values(this.context.cmdProcessor).map(x => x.close())
        ]);
    }

    request<T, O extends (MessageBase & T) = MessageBase & T>(mkind: MessageKind, body: T, opts?: {}) {
        const payload = <O>{
            $id: mkind,
            $v: 1,
            $token: ++this.idCounter,
            ...body,
        };
        this.ws.send(JSON.stringify(payload));
        return payload;
    }

    reply<T extends MessageReply, O extends MessageReplyable>(msg: T, origMsg: O) {
        this.ws.send(JSON.stringify(<T>{
            $id: MessageKind.Reply,
            $v: 1,
            $token: origMsg.$token,
            ...msg,
        }));
    }

    ack<T extends MessageAcknowledgeable>(origMsg: T) {
        this.ws.send(JSON.stringify({
            $id: MessageKind.Acknowledge,
            $v: 1,
            $token: origMsg.$token,
        }));
    }
}

interface RunnerFilters {
    regionId?: number;
    requiredCapabilities?: [keyof RunnerCapabilities];
}

export class ExecutiveServer {
    protected wss: WebSocket.Server;
    protected clientsInfo = new Map<WebSocket, ConnectedRunner>();
    protected dataRecQueue: Queue<DataRecordType>;
    protected cmdRegions: CmdWorkerRegionGroup;
    protected mapIndexer: MapIndexer;

    constructor(protected readonly conn: orm.Connection) {
    }

    protected getActiveRunners(options: RunnerFilters = {}) {
        const matchingRunners: ConnectedRunner[] = [];
        out: for (const item of this.clientsInfo.values()) {
            if (!item.rnInfo) continue;
            if (options.regionId && options.regionId !== item?.context.region) continue;
            if (options.requiredCapabilities) {
                for (const k of options.requiredCapabilities) {
                    if (!item.rnInfo!.capabilities[k]) continue out;
                }
            }
            matchingRunners.push(item);
        }
        return matchingRunners;
    }

    async load() {
        this.mapIndexer = new MapIndexer(this.conn);
        await this.mapIndexer.load();

        this.dataRecQueue = createDataRecordQueue();
        this.cmdRegions = createCmdWorkerRegionGroup();

        this.wss = new WebSocket.Server({
            port: 8089,
            verifyClient: this.verifyClient.bind(this),
            perMessageDeflate: true,
        });

        this.wss.on('listening', async function() {
            logger.info(`WebSocket listening..`);
        });

        this.wss.on('connection', this.onNewConnection.bind(this));

        setInterval(async () => {
            for (const [ws, cr] of this.clientsInfo) {
                if (cr.isTerminated) continue;
                if (!cr.isAlive) {
                    logger.info(`No response to ping from ${cr.addr}. Terminating connection..`);
                    await cr.close();
                    continue;
                }
                cr.isAlive = false;
                ws.ping();
            }
        }, 60000).unref();

        await this.periodicQueueClean();
    }

    protected async periodicQueueClean() {
        const allQueues = Object.values<CmdWorkerKindGroup>(this.cmdRegions as any)
            .map(cwkg => Object.values<CmdWorkerKindEntry>(cwkg as any).map<Queue[]>(x => [x.queue]))
            .flat(2)
        ;

        for (const currQueue of allQueues) {
            const jobCounts = await currQueue.getJobCounts('active', 'completed', 'failed', 'delayed', 'wait', 'paused');
            logger.info(`[${currQueue.name}] job counts - ${Object.entries(jobCounts).map(x => `${x[0]}: ${x[1]}`).join(' ')}`);
            await currQueue.clean(1000 * 60 * 15, 1000, 'completed');
        }

        setTimeout(this.periodicQueueClean.bind(this), 60000 * 5).unref();
    }

    @logIt({ profiling: false })
    async close() {
        logger.verbose(`Closing websocket..`);
        this.wss.close();

        logger.verbose(`Closing connected runners..`);
        await Promise.all(Array.from(this.clientsInfo.values()).map(x => x.close()));

        const allCmdResources = Object.values<CmdWorkerKindGroup>(this.cmdRegions as any)
            .map(cwkg => Object.values<CmdWorkerKindEntry>(cwkg as any).map<QueueBase[]>(x => [x.scheduler, x.queue]))
            .flat(2)
        ;

        logger.verbose(`Closing stuff..`);
        await Promise.all([
            this.mapIndexer.close(),
            this.dataRecQueue.close(),
            ...allCmdResources.map(x => x.close())
        ]);
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
            logger.warn(`unknown message datatype`, typeof message, message);
            return;
        }

        let msg: any;
        let msgKind: number;
        try {
            msg = JSON.parse(message);
            msgKind = Number(msg.$id);
        }
        catch (err) {
            if (err instanceof SyntaxError) {
                logger.warn(`invalid payload from ${cvRunner.runnerName} size=${message.length}`);
                return;
            }
            else {
                throw err;
            }
        }

        switch (msgKind as MessageKind) {
            case MessageKind.RunnerIntro: {
                await this.onRunnerIntro(cvRunner, msg);
                break;
            }
            case MessageKind.LobbyFeedBegin: {
                await this.onLobbyFeedBegin(cvRunner, msg);
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
            case MessageKind.ProfileDiscoverResult: {
                await this.onProfileDiscoverResult(cvRunner, msg);
                break;
            }
            case MessageKind.S2CmdPostResponse: {
                await this.onCmdPostResponse(cvRunner, msg);
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
                await otherClient.close();
                for (let i = 0; i < 5; ++i) {
                    await sleep(1000);
                    if (socket.CLOSED && !otherClient.lobbyFeed?.activeSession) {
                        continue out;
                    }
                }
                logger.error(`Failed to terminate hanging connections.. refusing incoming connection`);
                await cnRunner.close();
                return false;
            }
        }
        return true;
    }

    protected async onRunnerIntro(cnRunner: ConnectedRunner, rnIntro: RunnerIntro) {
        cnRunner.rnInfo = {
            hostname: rnIntro.hostname,
            region: rnIntro.region,
            capabilities: Object.assign(<RunnerCapabilities>{
                lobbyFeed: false,
            }, rnIntro.capabilities ?? {} as RunnerCapabilities),
            cmdQueues: rnIntro.cmdQueues ?? [],
        };
        logger.info(`RunnerIntro: ${cnRunner.runnerName}`, cnRunner.rnInfo.capabilities);

        const region: GameRegion = GameRegion[rnIntro.region as any] as any;
        if (!region) {
            logger.error(`Unknown region=${rnIntro.region} @${cnRunner.runnerName}`);
            await cnRunner.close();
            return;
        }

        if (!(await this.checkHangingConnections(cnRunner))) {
            return;
        }

        cnRunner.lobbyFeed = new RunnerFeedCtrl(cnRunner.runnerName);
        const sessInfo = await cnRunner.lobbyFeed.fetchCurrentSessionInfo();
        logger.debug(`lobbyfeed session=${sessInfo?.timestamp} size=${sessInfo?.size} @${cnRunner.runnerName}`);

        const cmdProcessor: {[key: string]: RunnerCmdProcessor} = {};
        for (const item of cnRunner.rnInfo.cmdQueues) {
            cmdProcessor[item.ckind] = new RunnerCmdProcessor(
                cnRunner,
                this.dataRecQueue,
                this.cmdRegions[region][item.ckind].queue,
                item.ckind as CmdKind,
                item
            );
        }
        cnRunner.context = Object.assign(new RunnerContext(), <RunnerContext>{
            region: region,
            capabilities: cnRunner.rnInfo.capabilities,
            cmdProcessor: cmdProcessor,
        });

        cnRunner.request<RunnerWelcome, MessageRunnerWelcome>(
            MessageKind.RunnerWelcome,
            {
                lastFeed: {
                    session: sessInfo?.timestamp ?? 0,
                    offset: sessInfo?.size ?? 0,
                },
            }
        );

        Object.values(cmdProcessor).forEach(x => x.run());
    }

    protected async onLobbyFeedBegin(cnRunner: ConnectedRunner, msg: MessageLobbyFeedBegin) {
        logger.info(`LobbyFeedBegin, sess=${msg.sessionStartAt}+${msg.offset} @${cnRunner.runnerName}`);
        cnRunner.lobbyFeed.beginSession(msg.sessionStartAt, msg.offset);
    }

    protected async onMapHeaderResult(cnRunner: ConnectedRunner, msg: MessageMapRevisionResult) {
        logger.debug(`received map revision, map=${msg.regionId}/${msg.mapId},${msg.mapVersion}`);
        try {
            await this.mapIndexer.add(msg);
            cnRunner.request<Omit<MessageMapRevisionAck, '$id' | '$token' | '$v'>>(
                MessageKind.MapRevisionAck,
                {
                    regionId: msg.regionId,
                    mapId: msg.mapId,
                    mapVersion: msg.mapVersion,
                }
            );
        }
        catch (e) {
            logger.error('processing map revision fail', msg, e);
        }
    }

    protected async onMapDiscoverResult(cnRunner: ConnectedRunner, msg: MessageMapDiscoverResult) {
        logger.debug(`received map discover, map=${msg.regionId}/${msg.mapId}`);
        try {
            await this.mapIndexer.add(msg);
            cnRunner.ack(msg);
        }
        catch (e) {
            logger.error('processing map discover fail', msg, e);
        }
    }

    protected async onMapUnavailableReport(cnRunner: ConnectedRunner, msg: MessageMapUnavailableReport) {
        const dateQuery = new Date(msg.queriedAt * 1000);
        logger.debug(`received map unavailable report, map=${msg.regionId}/${msg.mapId} date=${dateQuery}`);
        const mpTrack = await this.conn.getCustomRepository(S2MapTrackingRepository).fetchOrCreate({
            regionId: msg.regionId,
            mapId: msg.mapId,
        });

        if (mpTrack.lastCheckedAt && mpTrack.lastCheckedAt > dateQuery) {
            logger.debug(oneLine`
                unavailability report: outdated
                map=${msg.regionId}/${msg.mapId}
                date=${dateQuery.toISOString()} lastCheckedAt=${mpTrack.lastCheckedAt?.toISOString()}
            `);
            cnRunner.ack(msg);
            return;
        }

        // increase unavailabilityCounter only for reports which are at least newer by one day
        if (mpTrack.unavailabilityCounter > 0 && (dateQuery.getTime() - mpTrack.lastCheckedAt.getTime()) < 24 * 3600 * 1000) {
            logger.debug(oneLine`
                unavailability report: not relevant
                map=${msg.regionId}/${msg.mapId}
                date=${dateQuery.toISOString()} lastCheckedAt=${mpTrack.lastCheckedAt?.toISOString()}
            `);
            cnRunner.ack(msg);
            return;
        }

        mpTrack.lastCheckedAt = dateQuery;
        if (!mpTrack.firstSeenUnvailableAt) {
            mpTrack.firstSeenUnvailableAt = dateQuery;
        }
        mpTrack.unavailabilityCounter += 1;

        await this.conn.getCustomRepository(S2MapTrackingRepository).update(
            this.conn.getCustomRepository(S2MapTrackingRepository).getId(mpTrack),
            {
                lastCheckedAt: mpTrack.lastCheckedAt,
                firstSeenUnvailableAt: mpTrack.firstSeenUnvailableAt,
                unavailabilityCounter: mpTrack.unavailabilityCounter,
            },
        );
        cnRunner.ack(msg);
    }

    protected async onProfileDiscoverResult(cr: ConnectedRunner, msg: MessageProfileDiscoverResult) {
        await this.dataRecQueue.add(`profiles_${cr.rnInfo.hostname}_${GameRegion[cr.context.region]}`, {
            dkind: DataRecordKind.ProfileDiscover,
            payload: {
                profiles: msg.profiles
            },
        });
        cr.ack(msg);
    }

    protected async onCmdPostResponse(cr: ConnectedRunner, msg: MessageS2CmdPostResponse) {
        for (const mresp of msg.responses) {
            await cr.context.cmdProcessor[mresp.ckind].postResponse(mresp);
        }
        cr.ack(msg);
    }

    protected async onConnClose(ws: WebSocket, code: number, reason: string) {
        const sclient = this.clientsInfo.get(ws);
        logger.info(`Client disconnected ${sclient.addr} code=${code} reason=${reason}`);
        if (sclient.lobbyFeed) {
            await sclient.lobbyFeed.endSession();
        }
        await sclient.close();
        this.clientsInfo.delete(ws);
    }

    protected onConnPong(ws: WebSocket) {
        this.clientsInfo.get(ws).isAlive = true;
    }
}

