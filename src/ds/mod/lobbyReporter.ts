import * as orm from 'typeorm';
import pQueue, { DefaultAddOptions } from 'p-queue';
import type { RunFunction } from 'p-queue/dist/queue';
import lowerBound from 'p-queue/dist/lower-bound';
import type lruFactory from 'tiny-lru';
const lru: typeof lruFactory = require('tiny-lru');
import { User, TextChannel, Message, MessageEmbedOptions, DiscordAPIError, DMChannel, Guild, APIMessage } from 'discord.js';
import * as Redis from 'ioredis';
import deepEqual = require('deep-equal');
import { differenceInSeconds, differenceInDays } from 'date-fns';
import { Worker, Job, QueueScheduler, Queue, Processor } from 'bullmq';
import { BotTask, DiscordErrorCode } from '../dscommon';
import { S2GameLobby } from '../../entity/S2GameLobby';
import { GameLobbyStatus } from '../../common';
import { S2GameLobbySlot, S2GameLobbySlotKind } from '../../entity/S2GameLobbySlot';
import { sleep, sleepUnless, systemdNotifyWatchdog, TypedEvent } from '../../helpers';
import { logger, logIt } from '../../logger';
import { DsGameLobbySubscription } from '../../entity/DsGameLobbySubscription';
import { DsGameLobbyMessage } from '../../entity/DsGameLobbyMessage';
import { S2GameLobbyRepository } from '../../repository/S2GameLobbyRepository';
import { GameRegion, battleMapLink } from '../../common';
import { createBattleMatchQueue, createBattleMatchWorker, BattleMatchRelayItem, createBattleMatchScheduler } from '../../bnet/battleMatchRelay';
import { S2MatchDecision } from '../../entity/S2ProfileMatch';
import { S2LobbyMatchResult } from '../../entity/S2LobbyMatch';
import { oneLine } from 'common-tags';

export interface DestChannelOpts {
    userId: string | number | BigInt;
    guildId: string | number | BigInt;
    channelId: string | number | BigInt;
}

interface PostedGameLobby {
    // embed?: MessageEmbedOptions;
    msg: DsGameLobbyMessage;
    contentUpdatedAt: Date;
    outdatedSince: Date | null;
    closedAt?: Date;
    subscriptionId?: number;
    onComplete?: TypedEvent<Message | undefined>;
}

type PostActionType = 'post' | 'patch';

interface PostActionDesc {
    targetId: string;
    targetChannelId: string;
    actionType: PostActionType;
}

interface PostScheduledAction extends PostActionDesc {
    timestamp: number;
}

interface PerfMeasurementOptions {
    /**
     * time-window to measure - actions from last X seconds
     */
    timeFrame: number;
    /**
     * interpolate value if there's not enough recorded data
     */
    interpolate: boolean | number;
    sampleSize: number;
    cache: boolean;
}

class PosterPerformanceManager {
    protected readonly redis = new Redis({
        host: process.env.STARC_QUEUE_REDIS_HOST,
        port: parseInt(process.env.STARC_QUEUE_REDIS_PORT),
        db: 1,
        maxRetriesPerRequest: null,
        enableOfflineQueue: false,
        lazyConnect: true,
        retryStrategy: (times) => null,
    });
    protected readonly streamMaxLen = 1000;
    protected readonly scheduleLog = new Map<string, PostScheduledAction[]>();
    protected readonly postLog = new Map<string, number>();
    protected readonly cacheAvgPostLog = lru<number>(void 0, 10000);

    constructor() {
    }

    protected getPostLogKey(targetId: string) {
        return `lslog:${targetId}`;
    }

    protected trimSchLog(targetId: string) {
        const now = Date.now();
        const schLog = this.scheduleLog.get(targetId);
        if (!schLog) return;
        for (let i = 0; i < schLog.length; i++) {
            const item = schLog[i];
            if ((now - item.timestamp) > 60000 && (i + 1) < schLog.length) continue;
            if ((now - item.timestamp) < 60000) i--;
            if (i >= 1) {
                schLog.splice(0, i);
            }
            break;
        }
    }

    protected async sweepSchLog() {
        for (const [targetId, schLog] of this.scheduleLog) {
            this.trimSchLog(targetId);
            if (schLog.length <= 0) {
                this.scheduleLog.delete(targetId);
            }
        }
    }

    protected async sweepPostLog() {
        const timeOffset = Date.now() - (10 * 60 * 1000);
        const toDelete: string[] = [];
        for (const [targetId, timestamp] of this.postLog) {
            if (timestamp > timeOffset) continue;
            toDelete.push(targetId);
            this.postLog.delete(targetId);
        }
        if (toDelete.length <= 0) return;
        await this.redis.del(toDelete.map(x => this.getPostLogKey(x)));
    }

    async load() {
        setInterval(this.sweepSchLog.bind(this), 15000).unref();
        setInterval(this.sweepPostLog.bind(this), 25000).unref();
        await this.redis.connect();
        for (const key of await this.redis.keys(this.getPostLogKey('*'))) {
            const r = await this.redis.xinfo('STREAM', key) as any[];
            const i = r.indexOf('last-generated-id');
            if (i === -1) {
                throw new Error('last-generated-id missing?');
            }
            this.postLog.set(key.substr(this.getPostLogKey('').length), Number((r[i + 1] as string).split('-')[0]));
        }
    }

    async close() {
        this.redis.disconnect();
    }

    scheduleAction(targetId: string, targetChannelId: string, actionType: PostActionType) {
        const schLog = this.scheduleLog.get(targetId) ?? [];
        const now = Date.now();
        if (schLog.length === 0) {
            this.scheduleLog.set(targetId, schLog);
        }
        else {
            this.trimSchLog(targetId);
        }

        schLog.push({
            targetId: targetId,
            targetChannelId: targetChannelId,
            actionType: actionType,
            timestamp: now,
        });
    }

    avgScheduledPerSecond(targetId?: string, targetChannelId?: string, actionType?: PostActionType, timeWindow: number = 5000): number {
        if (!targetId) {
            return Array.from(this.scheduleLog.keys()).reduce((prev, item) => prev + this.avgScheduledPerSecond(item, void 0, void 0, timeWindow), 0);
        }

        const schLog = this.scheduleLog.get(targetId);
        if (!schLog) return 0;
        this.trimSchLog(targetId);
        const dnow = Date.now();
        let timeFrame = timeWindow;
        if (schLog.length > 0) {
            timeFrame = Math.min(timeWindow * 1.5, Math.max(timeWindow, dnow - schLog[0].timestamp));
        }
        const timeOffset = dnow - timeFrame;
        const count = schLog.reduce((prev, item) => {
            if (item.timestamp < timeOffset) return prev;
            if (targetChannelId && targetChannelId !== item.targetChannelId) return prev;
            if (actionType && actionType !== item.actionType) return prev;
            return prev + 1;
        }, 0);
        return (timeWindow / timeFrame) * count;
    }

    async doAction(pinfo: PostActionDesc, lobbyId: string, subscriptionId: number) {
        this.postLog.set(pinfo.targetId, Date.now());
        await this.redis.xadd(
            this.getPostLogKey(pinfo.targetId),
            'MAXLEN', '~', `${this.streamMaxLen}`,
            '*',
            'targetChannelId', pinfo.targetChannelId,
            'actionType', pinfo.actionType,
            'lobbyId', lobbyId,
            'subscriptionId', subscriptionId
        );
    }

    async avgDone(filters: Partial<PostActionDesc>, inOpts?: Partial<PerfMeasurementOptions>) {
        if (!this.postLog.has(filters.targetId)) return 0;
        const currOpts: PerfMeasurementOptions = Object.assign<PerfMeasurementOptions, typeof inOpts>({
            timeFrame: 1,
            sampleSize: 0,
            interpolate: false,
            cache: false,
        }, inOpts ?? {});
        if (currOpts.sampleSize <= currOpts.timeFrame) {
            currOpts.sampleSize = currOpts.timeFrame + 60;
        }
        let timeStart: number;
        let count = 0;
        // const streamList = (await this.redis.xrange(this.getPostLogKey(pinfo.targetId), Date.now() - currOpts.sampleSize, '+'));
        const streamList = (await this.redis.xrevrange(this.getPostLogKey(filters.targetId), '+', Date.now() - (currOpts.sampleSize * 1000))).reverse();
        if (!streamList.length) return 0;
        outter: for (const [ktm, contents] of streamList) {
            if (!timeStart) {
                timeStart = Number(ktm.split('-')[0]);
            }
            for (let i = 0; i < contents.length; i += 2) {
                const k = contents[i];
                const v = contents[i + 1];
                if (typeof (filters as any)[k] !== 'undefined' && (filters as any)[k] !== v) continue outter;
            }
            count++;
        }

        let timeFrame = currOpts.timeFrame * 1000;
        let sampledTimeWindow = (Date.now() - timeFrame);
        if (currOpts.interpolate) {
            sampledTimeWindow = (Date.now() - timeStart);
            if (typeof currOpts.interpolate === 'number') {
                sampledTimeWindow += currOpts.interpolate * 1000;
            }
        }
        return count / (sampledTimeWindow / timeFrame);
    }

    async summaryDone(filters: Partial<PostActionDesc>, inOpts?: Partial<PerfMeasurementOptions>) {
        const rmap = new Map<string, number>();
        for (const targetId of this.postLog.keys()) {
            const n = await this.avgDone({ targetId, ...filters }, inOpts);
            rmap.set(targetId, n);
        }
        return rmap;
    }
}

class TrackedGameLobby {
    candidates = new Set<DsGameLobbySubscription>();
    postedMessages = new Set<PostedGameLobby>();

    constructor (public lobby: S2GameLobby) {
    }

    updateInfo(newLobbyInfo: S2GameLobby) {
        const previousInfo = this.lobby;
        this.lobby = newLobbyInfo;
        this.lobby.match = previousInfo.match;
        if (previousInfo.createdAt?.getTime() !== newLobbyInfo.createdAt?.getTime()) return true;
        if (previousInfo.closedAt?.getTime() !== newLobbyInfo.closedAt?.getTime()) return true;
        if (previousInfo.status !== newLobbyInfo.status) return true;
        if (previousInfo.lobbyTitle !== newLobbyInfo.lobbyTitle) return true;
        if (previousInfo.hostName !== newLobbyInfo.hostName) return true;
        if (newLobbyInfo.slots.length === 0) {
            if (previousInfo.slotsHumansTaken !== newLobbyInfo.slotsHumansTaken) return true;
            if (previousInfo.slotsHumansTotal !== newLobbyInfo.slotsHumansTotal) return true;
        }
        if (!deepEqual(previousInfo.slots, newLobbyInfo.slots)) return true;
        return false;
    }

    isClosedStatusConcluded(min: number = 25000, max?: number) {
        if (this.lobby.status === GameLobbyStatus.Open) return false;
        const tdiff = Date.now() - this.lobby.closedAt.getTime();
        return tdiff > min && (typeof max !== 'number' || tdiff <= max);
    }
}

interface PostQueueOptions extends DefaultAddOptions {
    lobbyId?: number;
    subscriptionId?: number;
    targetId?: string;
    targetChannelId?: string;
}

type PostQueueElement = Partial<PostQueueOptions> & { run: RunFunction };

class LobbyQueue {
    protected _queue: PostQueueElement[] = [];

    enqueue(run: RunFunction, options?: Partial<PostQueueOptions>) {
        options = Object.assign({ priority: 0 }, options);
        const element = {
            ...options,
            run
        };
        if (this.size && this._queue[this.size - 1].priority >= options.priority) {
            this._queue.push(element);
            return;
        }
        const index = lowerBound(this._queue, element, (a, b) => b.priority - a.priority);
        this._queue.splice(index, 0, element);
    }

    dequeue() {
        const item = this._queue.shift();
        return item === null || item === void 0 ? void 0 : item.run;
    }

    filter(options: Readonly<Partial<PostQueueOptions>>) {
        return this._queue
            .filter((element) => {
                for (const key of Object.keys(options)) {
                    if (options[key] !== element[key]) return false;
                }
                return true;
            })
            .map(x => x.run)
        ;
    }

    get size() {
        return this._queue.length;
    }
}

class LobbyBattleMatchReceiver {
    queue: Queue<BattleMatchRelayItem>;
    protected worker: Worker<BattleMatchRelayItem>;
    protected scheduler: QueueScheduler;

    constructor(protected readonly conn: orm.Connection) {
    }

    async load(processor: Processor<BattleMatchRelayItem>) {
        this.queue = createBattleMatchQueue();
        this.worker = createBattleMatchWorker(processor, {
            concurrency: 15,
        });
        this.scheduler = createBattleMatchScheduler();
        await this.periodicClean();
    }

    async close() {
        await this.queue.close();
        // await this.worker.pause(false);
        await this.worker.close(false);
        await this.scheduler.close();
        await this.worker.disconnect();
    }

    protected async periodicClean() {
        const jobCounts = await this.queue.getJobCounts('active', 'completed', 'failed', 'delayed', 'wait', 'paused');
        logger.info(`[${this.queue.name}] job counts - ${Object.entries(jobCounts).map(x => `${x[0]}: ${x[1]}`).join(' ')}`);
        setTimeout(this.periodicClean.bind(this), 60000 * 5).unref();
    }
}

export class LobbyReporterTask extends BotTask {
    readonly trackedLobbies = new Map<number, TrackedGameLobby>();
    readonly subscriptions = new Map<number, DsGameLobbySubscription>();
    readonly postingQueue = new pQueue<LobbyQueue, PostQueueOptions>({
        concurrency: 25,
        queueClass: LobbyQueue,
    });

    readonly perf = new PosterPerformanceManager();
    actionCountersLastFiveMin: Map<string, number>;
    postCountersLastFiveMin: Map<string, number>;

    protected _onClose = new TypedEvent<void>();
    readonly matchReceiver = new LobbyBattleMatchReceiver(this.conn);

    async reloadSubscriptions() {
        this.subscriptions.clear();
        for (const subscription of await this.conn.getRepository(DsGameLobbySubscription).find({
            where: {
                deletedAt: null,
            },
        })) {
            this.subscriptions.set(subscription.id, subscription);
        }
    }

    async removeSubscription(subscription: DsGameLobbySubscription) {
        await this.conn.getRepository(DsGameLobbySubscription).update(subscription.id, {
            deletedAt: new Date(),
        });
        this.subscriptions.delete(subscription.id);
    }

    async load() {
        await this.flushMessages();
        await this.reloadSubscriptions();
        await this.restore();
        await this.perf.load();
        await this.refreshActionMetrics();
        await this.matchReceiver.load(this.processBattleMatchResult.bind(this));

        this.postingQueue.on('next', async () => {
            await systemdNotifyWatchdog(30000);
        });

        await systemdNotifyWatchdog(0);

        setTimeout(this.update.bind(this), 900).unref();
        setInterval(this.flushMessages.bind(this), 60000 * 3600).unref();
    }

    async unload() {
        this._onClose.emit();
        await this.matchReceiver.close();
        this.postingQueue.clear();
        await this.postingQueue.onIdle();
        await this.perf.close();
    }

    getPostingTargetName(targetDesc: DsGameLobbySubscription | DsGameLobbyMessage | { guildId?: string, userId?: string, channelId?: string }) {
        let targetName = targetDesc.userId ?
            `"${this.client.users.cache.get(String(targetDesc.userId))?.username}"` :
            `"${this.client.guilds.cache.get(String(targetDesc.guildId))?.name}"`
        ;
        if (targetDesc.channelId) {
            targetName += ` #${(this.client.channels.cache.get(String(targetDesc.channelId)) as TextChannel)?.name}`;
        }
        return `${targetName} (${targetDesc.guildId ?? targetDesc.userId})`;
    }

    /**
     * @returns limits per one minute
     */
    getPostingLimits(targetDesc: DsGameLobbySubscription | DsGameLobbyMessage | { guildId?: string, userId?: string, channelId?: string }) {
        let postLimit = 3;
        let actionLimit = 7;
        let subLimit = 5;
        if (targetDesc.guildId) {
            const guild = this.client.guilds.cache.get(String(targetDesc.guildId));

            if (guild) {
                const daysDiff = differenceInDays(Date.now(), guild.createdAt);
                const credits = Math.pow(Math.log2(daysDiff), Math.log10(guild.memberCount));

                postLimit = Math.min(8, postLimit + credits);
                actionLimit = Math.min(15, actionLimit + credits);
                subLimit = Math.max(
                    Math.min(credits, 30),
                    subLimit
                );

                if (this.client.owners.find(x => x.id === guild.ownerID)) {
                    postLimit = 70;
                    actionLimit = 125;
                    subLimit = 20;
                }
            }
        }
        return {
            postLimit,
            actionLimit,
            subLimit,
        };
    }

    protected async processBattleMatchResult(job: Job<BattleMatchRelayItem>): Promise<void> {
        if (job.data.result !== S2LobbyMatchResult.Success) return;

        if (Math.max(1, this.postingQueue.size) / this.postingQueue.concurrency > 0.75) {
            logger.warn(`posting queue overloaded, pausing processing of battle match results..`);
            await this.postingQueue.onEmpty();
        }

        if (this.trackedLobbies.has(job.data.lobbyId)) {
            logger.warn(`Given lobby ${job.data.lobbyId} for battle match result is already being tracked, aborting..`);
            return;
        }

        const matchingLobMessages = await this.conn.getRepository(DsGameLobbyMessage)
            .createQueryBuilder('lmsg')
            .innerJoinAndSelect('lmsg.subscription', 'subscription')
            .andWhere('lmsg.lobby = :lobbyId', { lobbyId: job.data.lobbyId })
            // .andWhere('subscription.postMatchResult = 1')
            .andWhere('lmsg.completed = false')
            .getMany()
        ;
        if (!matchingLobMessages.length) {
            // logger.verbose(`Found no matching lobbies posted for received battle match result ${job.data.lobbyId}`);
            return;
        }

        const qb = this.conn.getCustomRepository(S2GameLobbyRepository).prepareDetailedSelect();
        this.conn.getCustomRepository(S2GameLobbyRepository).addMatchResult(qb, { playerResults: true, playerProfiles: true });
        const lobbyInfo = await qb
            .andWhere('lobby.id = :lobbyId', { lobbyId: job.data.lobbyId })
            .getOne()
        ;
        if (!lobbyInfo) {
            logger.warn(`Given lobby for battle match result, couldn't be fetched from db ${job.data.lobbyId} ??`);
            return;
        }

        try {
            logger.info(`Received lobby ${lobbyInfo.globalId} for battle match result, affected msges: ${matchingLobMessages.map(x => x.messageId)}`);

            const completionPromises: Promise<[PostedGameLobby, Message | undefined]>[] = [];
            const trackedLobby = new TrackedGameLobby(lobbyInfo);
            this.trackedLobbies.set(lobbyInfo.id, trackedLobby);
            for (const lobbyMsg of matchingLobMessages) {
                lobbyMsg.lobby = trackedLobby.lobby;
                const gameLobMessage: PostedGameLobby = {
                    msg: lobbyMsg,
                    contentUpdatedAt: lobbyMsg.updatedAt,
                    // outdatedSince: trackedLobby.lobby.match.completedAt,
                    outdatedSince: new Date(),
                    subscriptionId: lobbyMsg.subscription?.id,
                    onComplete: new TypedEvent(),
                };
                trackedLobby.postedMessages.add(gameLobMessage);

                completionPromises.push(new Promise<[PostedGameLobby, Message | undefined]>((resolve, reject) => {
                    const tmp = this._onClose.once(() => {
                        reject(new Error(`processing of battle match result interrupted`));
                    });
                    gameLobMessage.onComplete.once(msg => {
                        tmp.dispose();
                        resolve([gameLobMessage, msg]);
                    });
                }));
            }

            await Promise.all(completionPromises);
        }
        catch (err) {
            logger.error(`failed to process lobby ${lobbyInfo.globalId} for battle match result, affected msges: ${matchingLobMessages.map(x => x.messageId)}`);
            throw err;
        }
    }

    @logIt({
        level: 'verbose',
        profTime: true,
        when: 'both',
    })
    protected async refreshActionMetrics() {
        this.actionCountersLastFiveMin = await this.perf.summaryDone({}, { timeFrame: 300, interpolate: 30 });
        this.postCountersLastFiveMin = await this.perf.summaryDone({ actionType: 'post' }, { timeFrame: 300, interpolate: 30 });
        setTimeout(this.refreshActionMetrics.bind(this), 30000).unref();
    }

    @logIt({
        level: 'verbose',
        profTime: true,
        when: 'both',
    })
    protected async flushMessages() {
        const res = await this.conn.getRepository(DsGameLobbyMessage)
            .createQueryBuilder('dmessage')
            .delete()
            .andWhere('completed = true OR (closed = true AND updated_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY))')
            .execute()
        ;
        logger.info(`deleted ${res.affected} obsolete messages from db`);
    }

    @logIt({
        level: 'verbose',
        profTime: true,
    })
    protected async restore() {
        const lobbyMessages = await this.conn.getRepository(DsGameLobbyMessage)
            .createQueryBuilder('lmsg')
            .leftJoinAndSelect('lmsg.subscription', 'subscription')
            .innerJoinAndSelect('lmsg.lobby', 'lobby')
            .andWhere('lmsg.closed = false')
            .getMany()
        ;
        if (!lobbyMessages.length) return;

        const freshLobbyInfo = await this.conn.getCustomRepository(S2GameLobbyRepository)
            .prepareDetailedSelect()
            .andWhere('lobby.id IN (:trackedLobbies)', {
                'trackedLobbies': Array.from(new Set(lobbyMessages.map(x => x.lobby.id))),
            })
            .getMany()
        ;

        for (const lobbyInfo of freshLobbyInfo) {
            const trackedLobby = new TrackedGameLobby(lobbyInfo);
            this.trackedLobbies.set(lobbyInfo.id, trackedLobby);
        }

        for (const lobbyMsg of lobbyMessages) {
            const trackedLobby = this.trackedLobbies.get(lobbyMsg.lobby.id);
            trackedLobby.postedMessages.add({
                msg: lobbyMsg,
                contentUpdatedAt: lobbyMsg.updatedAt,
                outdatedSince: trackedLobby.lobby.closedAt ?? null,
                subscriptionId: lobbyMsg.subscription?.id,
            });
            lobbyMsg.lobby = trackedLobby.lobby;
        }
    }

    async update() {
        this.running = true;

        await Promise.all([
            this.examineLobbiesTask(),
            this.updateLobbiesTask(),
        ]);

        this.running = false;
    }

    async examineLobbiesTask() {
        while (await this.waitUntilReady()) {
            await this.discoverNewLobbies();
            await this.evaluateCandidates();
            await sleepUnless(1000, () => !this.client.doShutdown);
            await this.refreshTrackedLobbies();
            await sleepUnless(500, () => !this.client.doShutdown);
        }
    }

    async updateLobbiesTask() {
        await sleepUnless(1000, () => !this.client.doShutdown);
        while (await this.waitUntilReady()) {
            await this.updateTrackedLobbies();
            if (this.postingQueue.size === 0) {
                await systemdNotifyWatchdog(30000);
            }
            await sleepUnless(1500, () => !this.client.doShutdown);
        }
    }

    protected async discoverNewLobbies() {
        const newLobbiesInfo = await this.conn.getCustomRepository(S2GameLobbyRepository)
            .prepareDetailedSelect()
            .andWhere('lobby.id NOT IN (:trackedLobbies)', { 'trackedLobbies': [0].concat(Array.from(this.trackedLobbies.keys())) })
            .andWhere('lobby.status = :status', { status: GameLobbyStatus.Open })
            .getMany()
        ;

        logger.verbose(`Newly discovered lobbies, count=${newLobbiesInfo.length}`);

        for (const s2gm of newLobbiesInfo) {
            const trackedLobby = new TrackedGameLobby(s2gm);
            this.trackedLobbies.set(s2gm.id, trackedLobby);

            for (const sub of this.subscriptions.values()) {
                this.testSubscription(sub, s2gm.id);
            }
        }
    }

    public testSubscription(sub: DsGameLobbySubscription, lobbyId?: number) {
        if (!lobbyId) {
            for (const trackedLobby of this.trackedLobbies.values()) {
                this.testSubscription(sub, trackedLobby.lobby.id);
            }
            return;
        }

        const trackedLobby = this.trackedLobbies.get(lobbyId);
        const s2gm = trackedLobby.lobby;

        if (
            (
                (
                    s2gm.extMod &&
                    (
                        (sub.isMapNameRegex && s2gm.extMod.name.match(new RegExp(sub.mapName, 'iu'))) ||
                        (sub.isMapNamePartial && s2gm.extMod.name.toLowerCase().indexOf(sub.mapName.toLowerCase()) !== -1) ||
                        (!sub.isMapNameRegex && !sub.isMapNamePartial && s2gm.extMod.name.toLowerCase() === sub.mapName.toLowerCase())
                    )
                ) ||
                (
                    s2gm.map &&
                    (
                        (sub.isMapNameRegex && s2gm.map.name.match(new RegExp(sub.mapName, 'iu'))) ||
                        (sub.isMapNamePartial && s2gm.map.name.toLowerCase().indexOf(sub.mapName.toLowerCase()) !== -1) ||
                        (!sub.isMapNameRegex && !sub.isMapNamePartial && s2gm.map.name.toLowerCase() === sub.mapName.toLowerCase())
                    )
                )
            ) &&
            (!sub.variant || sub.variant === s2gm.mapVariantMode) &&
            ((!sub.regionId && s2gm.regionId !== GameRegion.CN) || sub.regionId === s2gm.regionId)
        ) {
            trackedLobby.candidates.add(sub);
            logger.info(`New lobby ${s2gm.globalId} "${s2gm.map?.name}" sub: ${sub.id}`);
        }
    }

    protected async evaluateCandidates() {
        const currSubs = Array.from(this.trackedLobbies.values())
            .filter((trackedLobby) => trackedLobby.candidates.size > 0)
            .map((trackedLobby) => {
                return Array.from(trackedLobby.candidates).map<[TrackedGameLobby, DsGameLobbySubscription]>(x => [trackedLobby, x]);
            })
            .flat(1)
        ;
        const validatedSubs = currSubs.filter(([trackedLobby, candidate]) => {
            const timeDiff = (Date.now() - trackedLobby.lobby.createdAt.getTime()) / 1000;
            // hold on a little if the lobby was just made and there's no preview yet
            if (!trackedLobby.lobby.slotsUpdatedAt && timeDiff <= 2.0) {
                return false;
            }
            const humanOccupiedSlots = trackedLobby.lobby.getSlots({ kinds: [S2GameLobbySlotKind.Human] });
            if (
                (candidate.timeDelay && candidate.timeDelay > timeDiff) &&
                (candidate.humanSlotsMin && candidate.humanSlotsMin > humanOccupiedSlots.length)
            ) {
                return false;
            }
            return true;
        });

        logger.debug(`evaluated current subscriptions: existing: ${currSubs.length} validated: ${validatedSubs.length}`);
        if (!validatedSubs.length) return;

        let scheduledPostCount = 0;
        for (const [trackedLobby, cSub] of validatedSubs) {
            if (
                this.perf.avgScheduledPerSecond(
                    cSub.targetId,
                    cSub.targetChannelId,
                    'post',
                    2000
                ) >= 1.5
            ) {
                continue;
            }
            if (
                this.perf.avgScheduledPerSecond(
                    cSub.targetId,
                    cSub.targetChannelId,
                    'post',
                    6000
                ) >= Math.max(1.0, Math.min(10, Math.max(1, this.postingQueue.size) / this.postingQueue.concurrency * 0.1))
            ) {
                continue;
            }

            if (cSub.guildId && !this.client.guilds.cache.has(String(cSub.guildId))) {
                logger.warn(`Guild ${cSub.guildId} is unreachable, holding off from posting lobby: ${trackedLobby.lobby.globalId} sub: ${cSub.id}`);
                trackedLobby.candidates.delete(cSub);
                continue;
            }

            const limits = this.getPostingLimits(cSub);
            const targetPostsRecentTotal = (this.postCountersLastFiveMin.get(cSub.targetId) ?? 0);
            if (targetPostsRecentTotal > (limits.postLimit * 5)) {
                if (trackedLobby.isClosedStatusConcluded()) {
                    logger.verbose([
                        `target ${this.getPostingTargetName(cSub)} surpassed limit: ${targetPostsRecentTotal} max: ${(limits.postLimit * 5)}. `,
                        `lobby already closed, stopping tracking of ${trackedLobby.lobby.globalId}`
                    ].join(' '));
                    trackedLobby.candidates.delete(cSub);
                    continue;
                }
            }

            trackedLobby.candidates.delete(cSub);
            this.perf.scheduleAction(cSub.targetId, cSub.targetChannelId, 'post');
            this.postingQueue.add(async () => {
                if (!this.trackedLobbies.has(trackedLobby.lobby.id)) {
                    logger.warn(`Pending lobby ${trackedLobby.lobby.globalId} with candidates removed from tracking list prematurely?`);
                    return;
                }
                await this.updateSubcribedLobby(trackedLobby, cSub);
            }, {
                lobbyId: trackedLobby.lobby.id,
                subscriptionId: cSub.id,
                targetId: cSub.targetId,
                targetChannelId: cSub.targetChannelId,
            });
            scheduledPostCount += 1;
        }

        logger.verbose(`scheduled ${scheduledPostCount} lobbies to post from ${validatedSubs.length} available`);
    }

    protected async refreshTrackedLobbies() {
        // filter to those which meet at least one condition:
        // - have been already posted
        // - have a matching subscription which did not yet meet its critera
        // - have not been checked within the last 5 min
        const tnow = Date.now();
        const trackedLobbiesRelevant = Array.from(this.trackedLobbies.values())
            .filter(x => (
                x.postedMessages.size > 0 ||
                x.candidates.size > 0 ||
                (tnow - x.lobby.snapshotUpdatedAt.getTime()) > (1000 * 60 * 5)
            ))
        ;

        if (!trackedLobbiesRelevant.length) return;

        // fetch only IDs of lobbies which have newer data
        const affectedLobIds: number[] = [];
        const lobbyDataSnapshot = await this.conn.getCustomRepository(S2GameLobbyRepository)
            .createQueryBuilder('lobby')
            .select(['lobby.id', 'lobby.status', 'lobby.snapshotUpdatedAt', 'lobby.slotsUpdatedAt'])
            .andWhere('lobby.id IN (:trackedLobbies)', { 'trackedLobbies': trackedLobbiesRelevant.map(x => x.lobby.id) })
            .getMany()
        ;
        for (const lsnapshot of lobbyDataSnapshot) {
            const trackedLobby = this.trackedLobbies.get(lsnapshot.id);
            if (!trackedLobby) continue;

            // remove closed lobbies if they haven't been posted, or they aren't going to be
            if (
                trackedLobby.postedMessages.size === 0 &&
                (
                    (trackedLobby.candidates.size === 0 && lsnapshot.status !== GameLobbyStatus.Open) ||
                    (trackedLobby.candidates.size > 0 && trackedLobby.isClosedStatusConcluded())
                )
            ) {
                this.trackedLobbies.delete(lsnapshot.id);
                continue;
            }

            const lobby = trackedLobby.lobby;
            if (
                lobby.status !== lsnapshot.status ||
                lobby.snapshotUpdatedAt?.getTime() !== lsnapshot.snapshotUpdatedAt?.getTime() ||
                lobby.slotsUpdatedAt?.getTime() !== lsnapshot.slotsUpdatedAt?.getTime()
            ) {
                affectedLobIds.push(lsnapshot.id);
            }
        }

        // also include closed lobbies which have't actually changed but require update of a post for other reasons
        // such as deleting messages after X seconds from when they've been orginally closed
        const outdatedLobIds = affectedLobIds.concat(
            trackedLobbiesRelevant.filter(x => x.isClosedStatusConcluded(20000, 30000)).map(x => x.lobby.id)
        );

        logger.verbose(`Lobbies: affected count=${affectedLobIds.length}, outdated count=${outdatedLobIds.length}`);
        if (!outdatedLobIds.length) return;

        const freshLobbyInfo = await this.conn.getCustomRepository(S2GameLobbyRepository)
            .prepareDetailedSelect()
            .andWhere('lobby.id IN (:trackedLobbies)', {
                'trackedLobbies': Array.from(new Set(outdatedLobIds))
            })
            .getMany()
        ;

        for (const freshLobbyData of freshLobbyInfo) {
            const trackedLobby = this.trackedLobbies.get(freshLobbyData.id);
            if (!trackedLobby) continue;
            const hasNewData = trackedLobby.updateInfo(freshLobbyData);
            if (hasNewData) {
                const tnow = new Date();
                for (const lobMsg of trackedLobby.postedMessages.values()) {
                    if (!lobMsg.outdatedSince) {
                        lobMsg.outdatedSince = tnow;
                    }
                }
            }
        }
    }

    protected async updateTrackedLobbies() {
        const outdatedList = Array.from(this.trackedLobbies.values())
            .map(trackedLobby => {
                if (!trackedLobby.postedMessages.size) return;
                let outdatedMessages = Array.from(trackedLobby.postedMessages);
                if (!trackedLobby.isClosedStatusConcluded()) {
                    outdatedMessages = outdatedMessages.filter(x => x.outdatedSince);
                }
                if (!outdatedMessages.length) return;
                return outdatedMessages.map<[TrackedGameLobby, PostedGameLobby]>(postedMsg => {
                    return [trackedLobby, postedMsg];
                });
            })
            .filter(x => typeof x !== 'undefined').flat(1)
            .filter(([trackedLobby, postedMsg]) => {
                if (
                    !trackedLobby.isClosedStatusConcluded() &&
                    trackedLobby.lobby.closedAt &&
                    postedMsg.closedAt?.getTime() === trackedLobby.lobby.closedAt.getTime()
                ) {
                    logger.verbose(`skipping closedAt msg: ${postedMsg.msg.messageId}`);
                    return false;
                }
                return true;
            })
            .sort((a, b) => {
                if (a[0].lobby.match && b[0].lobby.match) {
                    return a[0].lobby.match.completedAt.getTime() - b[0].lobby.match.completedAt.getTime();
                }
                else if (a[0].lobby.match) {
                    return -1;
                }
                else if (b[0].lobby.match) {
                    return 1;
                }

                if (a[0].lobby.closedAt && b[0].lobby.closedAt) {
                    return a[0].lobby.closedAt.getTime() - b[0].lobby.closedAt.getTime();
                }
                else if (a[0].lobby.closedAt) {
                    return -1;
                }
                else if (b[0].lobby.closedAt) {
                    return 1;
                }

                return (b[1].contentUpdatedAt.getTime() - a[1].contentUpdatedAt.getTime());
            })
        ;

        const targetIds = Array.from(new Set(outdatedList.map(x => x[1].msg.targetId)));
        const targetPerfList = await Promise.all(targetIds.map<Promise<[string, number]>>(async x => {
            const n = await this.perf.avgDone({ targetId: x, actionType: 'patch' }, {
                timeFrame: 120,
                interpolate: 30,
            });
            return [x, n];
        }));
        const targetPerfMap = new Map(targetPerfList);
        // logger.verbose(`target performance`, targetPerfList.sort((a, b) => b[1] - a[1]));

        let scheduledPostCount = 0;
        for (const [trackedLobby, postedMsg] of outdatedList) {
            if (
                this.perf.avgScheduledPerSecond(
                    postedMsg.msg.targetId,
                    postedMsg.msg.targetChannelId,
                    'patch',
                    1000
                ) >= 1.0
            ) {
                continue;
            }
            if (
                this.perf.avgScheduledPerSecond(
                    postedMsg.msg.targetId,
                    postedMsg.msg.targetChannelId,
                    'patch',
                    6500
                ) >= Math.max(1.0, 4.0 - this.postingQueue.size * 0.1)
            ) {
                continue;
            }
            if (this.postingQueue.sizeBy({ lobbyId: trackedLobby.lobby.id, targetChannelId: postedMsg.msg.targetChannelId }) >= 1) continue;
            const limits = this.getPostingLimits(postedMsg.msg);
            const currReqStats = targetPerfMap.get(postedMsg.msg.targetId);
            if (
                currReqStats >= (limits.actionLimit * 1.4) &&
                !trackedLobby.isClosedStatusConcluded() &&
                (postedMsg.outdatedSince && (Date.now() - postedMsg.outdatedSince.getTime()) <= 1000.0 * 20.0 * (currReqStats / limits.actionLimit))
            ) {
                continue;
            }
            if (currReqStats >= (limits.actionLimit * 2.0)) continue;

            this.perf.scheduleAction(postedMsg.msg.targetId, postedMsg.msg.targetChannelId, 'patch');
            this.postingQueue.add(async () => {
                await this.updateSubcribedLobby(trackedLobby, postedMsg);
                if (trackedLobby.postedMessages.size <= 0 && trackedLobby.isClosedStatusConcluded()) {
                    this.trackedLobbies.delete(trackedLobby.lobby.id);
                }
            }, {
                lobbyId: trackedLobby.lobby.id,
                subscriptionId: postedMsg.subscriptionId ?? 0,
                targetId: postedMsg.msg.targetId,
                targetChannelId: postedMsg.msg.targetChannelId,
            });
            scheduledPostCount += 1;
        }

        logger.verbose(`tlobs: ${this.trackedLobbies.size} outdated: ${outdatedList.length} scheduled: ${scheduledPostCount} queued total: ${this.postingQueue.size}`);
    }

    /**
     * - returns `true` if channel is unknown / was deleted
     * - returns `false` if there was an unknown error, but channel might exist
     * - returns `TextChannel | DMChannel` if it's valid
     */
    protected async fetchDestChannel(opts: DestChannelOpts): Promise<TextChannel | DMChannel | boolean> {
        if (opts.userId) {
            try {
                const destUser = await this.client.users.fetch(String(opts.userId));
                return destUser.dmChannel ?? (destUser.createDM());
            }
            catch (err) {
                if (err instanceof DiscordAPIError) {
                    // DiscordErrorCode.UnknownUser
                    // DiscordErrorCode.CannotSendMessagesToThisUser (??)
                    logger.error(`Couldn't create DM for an user, id=${opts.userId}`, err);
                }
                else {
                    throw err;
                }
            }
        }
        else if (opts.guildId) {
            try {
                const destGuildChan = await this.client.channels.fetch(String(opts.channelId));
                if (!destGuildChan) {
                    logger.error(
                        `Guild chan doesn't exist, id=${opts.channelId}`,
                        opts,
                        destGuildChan,
                    );
                    return;
                }
                if (!(destGuildChan instanceof TextChannel)) {
                    logger.error(`Guild chan incorrect type=${destGuildChan.type}`, opts);
                    return;
                }
                return destGuildChan;
            }
            catch (err) {
                if (err instanceof DiscordAPIError) {
                    if ([DiscordErrorCode.UnknownChannel, DiscordErrorCode.MissingAccess].indexOf(err.code) !== -1) {
                        return true;
                    }
                    else {
                        logger.error(`Couldn't fetch the channel ${opts.channelId}`, err);
                        return;
                    }
                }
                else {
                    throw err;
                }
            }
            return false;
        }
        else {
            throw new Error(`invalid DestChannelOpts`);
        }
    }

    protected async updateSubcribedLobby(trackedLobby: TrackedGameLobby, inp: DsGameLobbySubscription | PostedGameLobby) {
        let plob: PostedGameLobby;
        let adesc: PostActionDesc;
        if (inp instanceof DsGameLobbySubscription) {
            adesc = {
                targetId: inp.targetId,
                targetChannelId: inp.targetChannelId,
                actionType: 'post',
            };
            const secDiff = differenceInSeconds(Date.now(), trackedLobby.lobby.createdAt);
            logger.debug(oneLine
                `posting ${trackedLobby.lobby.globalId}
                (${trackedLobby.lobby.status}) ${trackedLobby.lobby.statSlots}
                ${trackedLobby.lobby.statSlots}
                in ${this.getPostingTargetName(inp)} (${secDiff}s)
            `);
            plob = await this.postSubscribedLobby(trackedLobby, inp);
        }
        else {
            adesc = {
                targetId: inp.msg.guildId ? String(inp.msg.guildId) : String(inp.msg.userId),
                targetChannelId: String(inp.msg.channelId),
                actionType: 'patch',
            };
            plob = inp;
            const secDiff = differenceInSeconds(Date.now(), inp.outdatedSince);
            logger.debug(oneLine`
                updating ${trackedLobby.lobby.globalId}
                (${trackedLobby.lobby.match ? 'completed' : trackedLobby.lobby.status})
                ${trackedLobby.lobby.statSlots}
                in ${this.getPostingTargetName(inp.msg)} (${secDiff}s)
            `);
            const pf = Date.now();
            await this.editLobbyMessage(trackedLobby, inp);
            logger.debug(oneLine`
                UPDATED ${trackedLobby.lobby.globalId}
                (${trackedLobby.lobby.match ? 'completed' : trackedLobby.lobby.status})
                ${trackedLobby.lobby.statSlots}
                in ${this.getPostingTargetName(inp.msg)} (${secDiff}s) - ${((Date.now() - pf) / 1000).toFixed(1)}s
            `);
        }
        if (plob) {
            await this.perf.doAction(adesc, trackedLobby.lobby.globalId, plob.subscriptionId ?? 0);
            return plob;
        }
    }

    protected async postSubscribedLobby(trackedLobby: TrackedGameLobby, subscription: DsGameLobbySubscription) {
        const chan = await this.fetchDestChannel(subscription);
        if (chan === true) {
            logger.info(`Can't fetch the channel=${subscription.discordId} ; deleted subscription id=${subscription.id}`);
            await this.removeSubscription(subscription);
        }
        else if (chan === false) {
            logger.info(`Can't fetch the channel=${subscription.discordId} ; lobby not posted id=${subscription.id}`);
        }
        else {
            return this.postTrackedLobby(chan, trackedLobby, subscription);
        }
    }

    async postTrackedLobby(chan: TextChannel | DMChannel, trackedLobby: TrackedGameLobby, subscription: DsGameLobbySubscription) {
        const gameLobMessage = DsGameLobbyMessage.create();
        gameLobMessage.lobby = trackedLobby.lobby;
        gameLobMessage.subscription = subscription ?? null;
        const lobbyClosedAt = trackedLobby.lobby.closedAt;
        const lbEmbed = embedGameLobby(trackedLobby.lobby, subscription);

        try {
            const msg = await chan.send({ embed: lbEmbed });
            gameLobMessage.messageId = msg.id;

            if (chan instanceof TextChannel) {
                gameLobMessage.guildId = chan.guild.id;
            }
            else if (chan instanceof DMChannel) {
                gameLobMessage.userId = chan.recipient.id;
            }
            else {
                throw new Error(`unsupported channel type=${(<any>chan).type}`);
            }
            gameLobMessage.channelId = chan.id;
            const lobbyMsg: PostedGameLobby = {
                msg: gameLobMessage,
                contentUpdatedAt: msg.createdAt,
                outdatedSince: null,
                closedAt: lobbyClosedAt,
                subscriptionId: subscription?.id,
            };
            if (
                lobbyMsg.closedAt &&
                trackedLobby.isClosedStatusConcluded() &&
                (
                    !subscription || (
                        (trackedLobby.lobby.status === GameLobbyStatus.Started && !subscription.deleteMessageStarted) ||
                        (trackedLobby.lobby.status === GameLobbyStatus.Abandoned && !subscription.deleteMessageAbandoned) ||
                        (trackedLobby.lobby.status === GameLobbyStatus.Unknown && !subscription.deleteMessageAbandoned)
                    )
                )
            ) {
                logger.debug(`COULD RELEASE EARLY ${trackedLobby.lobby.globalId} ${trackedLobby.lobby.status} ${this.getPostingTargetName(gameLobMessage)}`);
                // gameLobMessage.closed = true;
            }
            await this.conn.getRepository(DsGameLobbyMessage).insert(gameLobMessage);
            if (!gameLobMessage.closed) {
                trackedLobby.postedMessages.add(lobbyMsg);
            }

            return lobbyMsg;
        }
        catch (err) {
            if (err instanceof DiscordAPIError) {
                if (
                    subscription && (
                        err.code === DiscordErrorCode.MissingPermissions ||
                        err.code === DiscordErrorCode.MissingAccess ||
                        err.code === DiscordErrorCode.CannotSendMessagesToThisUser
                    )
                ) {
                    logger.warn(`Failed to send message, removing subscription - lobby: ${trackedLobby.lobby.globalId} sub: ${subscription.id} err: ${err.message}`);
                    await this.removeSubscription(subscription);
                }
                else {
                    logger.error(`Failed to send message, lobby: ${trackedLobby.lobby.globalId} sub: ${subscription.id}`, err, lbEmbed, subscription, trackedLobby.lobby);
                }
                return;
            }
            else {
                throw err;
            }
        }
    }

    async bindMessageWithLobby(msg: Message, lobbyId: number) {
        let trackedLobby = this.trackedLobbies.get(lobbyId);
        if (!trackedLobby) {
            const lobby = await this.conn.getCustomRepository(S2GameLobbyRepository)
                .prepareDetailedSelect()
                .where('lobby.id = :id', { id: lobbyId })
                .getOne()
            ;
            if (!lobby) return;

            trackedLobby = this.trackedLobbies.get(lobbyId);
            if (!trackedLobby) {
                trackedLobby = new TrackedGameLobby(lobby);
                this.trackedLobbies.set(lobby.id, trackedLobby);

                for (const sub of this.subscriptions.values()) {
                    this.testSubscription(sub, lobby.id);
                }
            }
        }

        const chan = msg.channel;
        const gameLobMessage = DsGameLobbyMessage.create();
        gameLobMessage.lobby = trackedLobby.lobby;
        gameLobMessage.messageId = msg.id;
        if (chan instanceof TextChannel) {
            gameLobMessage.guildId = chan.guild.id;
        }
        else if (chan instanceof DMChannel) {
            gameLobMessage.userId = chan.recipient.id;
        }
        else {
            throw new Error(`unsupported channel type=${chan.type}`);
        }
        gameLobMessage.channelId = chan.id;
        await this.conn.getRepository(DsGameLobbyMessage).insert(gameLobMessage);

        const lobbyMsg: PostedGameLobby = {
            msg: gameLobMessage,
            contentUpdatedAt: new Date(),
            outdatedSince: null,
        };
        trackedLobby.postedMessages.add(lobbyMsg);
        await this.editLobbyMessage(trackedLobby, lobbyMsg);

        return trackedLobby;
    }

    protected async releaseLobbyMessage(trackedLobby: TrackedGameLobby, lobbyMsg: PostedGameLobby, msg?: Message) {
        trackedLobby.postedMessages.delete(lobbyMsg);
        const isCompleted = (
            typeof msg === 'undefined' ||
            typeof lobbyMsg.msg.subscription === 'undefined' ||
            (trackedLobby.lobby.status === GameLobbyStatus.Started && lobbyMsg.msg.subscription.deleteMessageStarted) ||
            trackedLobby.lobby.status !== GameLobbyStatus.Started
        );
        await this.conn.getRepository(DsGameLobbyMessage).update(
            this.conn.getRepository(DsGameLobbyMessage).getId(lobbyMsg.msg),
            {
                updatedAt: new Date(),
                closed: true,
                completed: isCompleted,
            }
        );
        if (lobbyMsg.onComplete) {
            lobbyMsg.onComplete.emit(msg);
        }
    }

    protected async editLobbyMessage(trackedLobby: TrackedGameLobby, lobbyMsg: PostedGameLobby) {
        try {
            const chan = await this.fetchDestChannel(lobbyMsg.msg);
            if (typeof chan === 'boolean') {
                await this.releaseLobbyMessage(trackedLobby, lobbyMsg);
                return;
            }

            const lbEmbed = embedGameLobby(trackedLobby.lobby, lobbyMsg.msg.subscription);
            lobbyMsg.closedAt = trackedLobby.lobby.closedAt;
            lobbyMsg.outdatedSince = null;
            if (
                lobbyMsg.msg.subscription && (
                    (trackedLobby.lobby.status === GameLobbyStatus.Started && lobbyMsg.msg.subscription.deleteMessageStarted) ||
                    (trackedLobby.lobby.status === GameLobbyStatus.Abandoned && lobbyMsg.msg.subscription.deleteMessageAbandoned) ||
                    (trackedLobby.lobby.status === GameLobbyStatus.Unknown && lobbyMsg.msg.subscription.deleteMessageAbandoned)
                )
            ) {
                if (trackedLobby.isClosedStatusConcluded()) {
                    try {
                        await chan.messages.delete(String(lobbyMsg.msg.messageId));
                        await this.releaseLobbyMessage(trackedLobby, lobbyMsg);
                    }
                    catch (err) {
                        if (err instanceof DiscordAPIError) {
                            if (
                                err.code === DiscordErrorCode.UnknownMessage ||
                                err.code === DiscordErrorCode.MissingAccess
                            ) {
                                await this.releaseLobbyMessage(trackedLobby, lobbyMsg);
                            }
                            logger.error(`Failed to delete`, err);
                        }
                        else {
                            throw err;
                        }
                    }
                }
                else {
                    const msg = (new Message(this.client, {
                        id: String(lobbyMsg.msg.messageId),
                    }, chan));
                    await msg.edit({ embed: lbEmbed });
                }
            }
            else {
                const msg = (new Message(this.client, {
                    id: String(lobbyMsg.msg.messageId),
                }, chan));
                const newMsg = await msg.edit({ embed: lbEmbed });
                if (trackedLobby.lobby.status !== GameLobbyStatus.Open) {
                    await this.releaseLobbyMessage(trackedLobby, lobbyMsg, newMsg);
                }
            }
        }
        catch (err) {
            if (err instanceof DiscordAPIError) {
                if (err.code === DiscordErrorCode.UnknownMessage || err.code === DiscordErrorCode.MissingAccess || err.code === DiscordErrorCode.UnknownChannel) {
                    await this.releaseLobbyMessage(trackedLobby, lobbyMsg);
                    return;
                }
                logger.error(`Failed to update message for lobby ${trackedLobby.lobby.globalId}, msgid=${lobbyMsg.msg.messageId}`, err, lobbyMsg.msg);
            }
            else {
                throw err;
            }
        }
    }
}

function formatTimeDiff(a: Date, b: Date, opts?: { lettersAsDelimiters?: boolean }) {
    const secsDiff = Math.max(((a.getTime() - b.getTime()) / 1000), 0.0);
    const out: string[] = [];
    if (secsDiff >= 3600) {
        out.push(`${Math.floor(secsDiff / 3600).toFixed(0)}${opts?.lettersAsDelimiters ? 'h' : ''}`);
    }
    out.push(`${Math.floor(secsDiff % 3600 / 60).toFixed(0).padStart(2, '0')}${opts?.lettersAsDelimiters ? 'm' : ''}`);
    out.push(`${Math.floor(secsDiff % 60).toFixed(0).padStart(2, '0')}${opts?.lettersAsDelimiters ? 's' : ''}`);
    return opts?.lettersAsDelimiters ? out.join(' ') : out.join(':');
}

interface LobbyEmbedOptions {
    showLeavers: boolean;
    showTimestamps: boolean;
    showThumbnail: boolean;
}

function embedGameLobby(s2gm: S2GameLobby, cfg?: Partial<LobbyEmbedOptions>): MessageEmbedOptions {
    if (!cfg) cfg = {};
    cfg = Object.assign<LobbyEmbedOptions, Partial<LobbyEmbedOptions>>({
        showLeavers: false,
        showTimestamps: false,
        showThumbnail: true,
    }, cfg);

    const em: MessageEmbedOptions = {
        title: s2gm.map?.name ?? battleMapLink(s2gm.regionId, s2gm.mapBnetId),
        url: `https://sc2arcade.com/lobby/${s2gm.regionId}/${s2gm.bnetBucketId}/${s2gm.bnetRecordId}`,
        fields: [],
        timestamp: s2gm.createdAt,
        footer: {
        },
    };

    if (cfg.showThumbnail && s2gm.map) {
        em.thumbnail = {
            url: `https://static.sc2arcade.com/dimg/${s2gm.map.iconHash}.jpg?region=${GameRegion[s2gm.regionId].toLowerCase()}`,
        };
    }

    switch (s2gm.regionId) {
        case GameRegion.US: {
            em.footer.icon_url = 'https://i.imgur.com/K584M0K.png';
            break;
        }
        case GameRegion.EU: {
            em.footer.icon_url = 'https://i.imgur.com/G8Vst8Q.png';
            break;
        }
        case GameRegion.KR: {
            em.footer.icon_url = 'https://i.imgur.com/YbFsB42.png';
            break;
        }
        case GameRegion.CN: {
            em.footer.icon_url = 'https://i.imgur.com/UrIuIjZ.png';
            break;
        }
    }

    if (s2gm.match) {
        // 🏁
        em.color = 0x226699;
        em.fields.push({
            name: `Status`,
            value: `☑️ __** FINISHED **__ \`${formatTimeDiff(s2gm.match.completedAt, s2gm.closedAt, { lettersAsDelimiters: true })}\``,
        });
    }
    else {
        let statusm: string[] = [];
        switch (s2gm.status) {
            case GameLobbyStatus.Open: {
                statusm.push('⏳');
                em.color = 0xffac33;
                break;
            }
            case GameLobbyStatus.Started: {
                statusm.push('✅');
                em.color = 0x77b255;
                break;
            }
            case GameLobbyStatus.Abandoned: {
                statusm.push('❌');
                em.color = 0xdd2e44;
                break;
            }
            case GameLobbyStatus.Unknown: {
                statusm.push('❓');
                em.color = 0xccd6dd;
                break;
            }
        }
        statusm.push(` __** ${s2gm.status.toLocaleUpperCase()} **__`);
        if (s2gm.status !== GameLobbyStatus.Open && (cfg.showTimestamps || 1)) {
            statusm.push(` \`${formatTimeDiff(s2gm.closedAt, s2gm.createdAt, { lettersAsDelimiters: true })}\``);
        }
        em.fields.push({
            name: `Status`,
            value: statusm.join(''),
            inline: false,
        });
    }

    if (s2gm.extModBnetId) {
        em.fields.push({
            name: `Extension mod`,
            value: s2gm.extMod?.name ?? battleMapLink(s2gm.regionId, s2gm.extModBnetId),
            inline: false,
        });
    }

    if (s2gm.mapVariantMode.trim().length) {
        em.footer.text = s2gm.mapVariantMode;
    }
    else {
        em.footer.text = `${s2gm.mapVariantIndex}`;
    }

    if (!s2gm.match && s2gm.lobbyTitle) {
        em.fields.push({
            name: `Title`,
            value: s2gm.lobbyTitle,
            inline: false,
        });
    }

    const teamsNumber = (new Set(s2gm.slots.map(x => x.team))).size;
    const activeSlots = s2gm.slots.filter(x => x.kind !== S2GameLobbySlotKind.Open).sort((a, b) => b.slotKindPriority - a.slotKindPriority);
    const humanSlots = s2gm.slots.filter(x => x.kind === S2GameLobbySlotKind.Human);

    const redSquare = `\u{1F7E5}`;
    const greenSquare = `\u{1F7E9}`;
    const blackSquare = `\u{1F532}`;
    const orangeSquare = `\u{1F7E7}`;
    const blueSquare = `\u{1F7E6}`;
    const brownSquare = `\u{1F7EB}`;

    function formatSlotRows(slotsList: S2GameLobbySlot[], opts: { includeTeamNumber?: boolean } = {}) {
        const ps: string[] = [];
        let i = 1;
        for (const slot of slotsList) {
            if (s2gm.status !== GameLobbyStatus.Open && slot.kind === S2GameLobbySlotKind.Open) continue;

            const wparts: string[] = [];
            wparts.push(`\`${i.toString().padStart(slotsList.length.toString().length, '0')})`);

            if (
                opts.includeTeamNumber &&
                (slot.kind === S2GameLobbySlotKind.Human || slot.kind === S2GameLobbySlotKind.AI)
            ) {
                wparts.push(` T${slot.team}`);
            }

            if (slot.kind === S2GameLobbySlotKind.Human) {
                let fullname = slot.profile ? `${slot.profile.name}#${slot.profile.discriminator}` : slot.name;

                if (!s2gm.match && (cfg.showTimestamps || !opts.includeTeamNumber)) {
                    wparts.push(` ${formatTimeDiff(slot.joinInfo?.joinedAt ?? s2gm.slotsUpdatedAt, s2gm.createdAt)}`);
                }
                wparts.push('` ');
                if (s2gm.match) {
                    const profMatch = s2gm.match.profileMatches.find(x => {
                        return x.profile.realmId === slot.profile.realmId && x.profile.profileId === slot.profile.profileId;
                    });
                    if (profMatch) {
                        switch (profMatch.decision) {
                            case S2MatchDecision.Left: {
                                wparts.push(blackSquare);
                                break;
                            }
                            case S2MatchDecision.Win: {
                                wparts.push(greenSquare);
                                break;
                            }
                            case S2MatchDecision.Loss: {
                                wparts.push(redSquare);
                                break;
                            }
                            case S2MatchDecision.Tie: {
                                wparts.push(brownSquare);
                                break;
                            }
                            case S2MatchDecision.Observer: {
                                wparts.push(blueSquare);
                                break;
                            }
                            case S2MatchDecision.Disagree: {
                                wparts.push(orangeSquare);
                                break;
                            }
                            case S2MatchDecision.Unknown: {
                                wparts.push(`\u{2754}`);
                                break;
                            }
                        }
                    }
                    else {
                        wparts.push(`?`);
                    }
                    wparts.push(` `);
                }

                if (slot.name === s2gm.hostName) {
                    fullname = `__${fullname}__`;
                }
                wparts.push(fullname);
            }
            else if (slot.kind === S2GameLobbySlotKind.AI) {
                wparts.push(`  AI  `);
                wparts.push('`');
            }
            else if (slot.kind === S2GameLobbySlotKind.Open) {
                if (!s2gm.closedAt) {
                    wparts.push(` OPEN `);
                }
                else {
                    wparts.push(` CLSD `);
                }
                wparts.push('`');
            }
            ps.push(wparts.join(''));
            ++i;
        }
        if (!ps.length) return ['-'];
        return ps;
    }

    const teamFields: { name: string, value: string, inline?: boolean }[] = [];

    if ((s2gm.status === GameLobbyStatus.Open || s2gm.status === GameLobbyStatus.Started) && activeSlots.length) {
        let teamSizes: number[] = [];
        for (const slot of s2gm.slots) {
            if (!teamSizes[slot.team]) teamSizes[slot.team] = 0;
            teamSizes[slot.team] += 1;
        }
        teamSizes = teamSizes.filter(x => typeof x === 'number');

        const useRichLayout = (
            (teamsNumber >= 2 && s2gm.slots.length / teamsNumber >= 2) &&
            (Math.max(...teamSizes) <= 6)
        );

        if (useRichLayout) {
            for (let currTeam = 1; currTeam <= teamsNumber; currTeam++) {
                const currTeamSlots = s2gm.getSlots({ teams: [currTeam] }).sort((a, b) => b.slotKindPriority - a.slotKindPriority);
                if (!currTeamSlots.length) continue;
                const currTeamOccupied = s2gm.getSlots({ kinds: [S2GameLobbySlotKind.Human, S2GameLobbySlotKind.AI], teams: [currTeam] });
                const formattedSlots = formatSlotRows(currTeamSlots);

                teamFields.push({
                    name: `Team ${currTeam}`,
                    value: formattedSlots.join('\n'),
                    inline: true,
                });
            }
        }
        else {
            const occupiedSlots = s2gm.getSlots({ kinds: [S2GameLobbySlotKind.Human, S2GameLobbySlotKind.AI] });
            const formattedSlots = formatSlotRows(occupiedSlots, {
                // displaying teamNumber seems to be useless with this setup (non even teams).
                // often times it just shows dummy computer players which are forced from map variant
                // includeTeamNumber: teamsNumber > 1 && Math.max(...teamSizes) > 1,
            });
            em.fields.push({
                name: `Players` + (s2gm.status === GameLobbyStatus.Open ? ` [${occupiedSlots.length}/${s2gm.slots.length}]` : ''),
                value: formattedSlots.join('\n'),
                inline: false,
            });
        }
    }

    if (teamFields.length > 0) {
        em.fields[em.fields.length - 1].inline = false;

        let rowCount = 0;
        let columnLimit = 2;
        // don't use more than 2 columns - doesn't look good most of the times
        // if ((teamFields.length % 3) === 0) {
        //     columnLimit = 3;
        // }
        while (teamFields.length) {
            ++rowCount;
            const sectionTeamFields = teamFields.splice(0, columnLimit);

            while (sectionTeamFields.length < columnLimit && rowCount > 1) {
                sectionTeamFields.push({ name: `\u200B`, value: `\u200B`, inline: true });
            }

            em.fields.push(...sectionTeamFields);
            if (teamFields.length) {
                em.fields.push({ name: `\u200B`, value: `\u200B`, inline: false });
            }
        }
    }

    if (!s2gm.slots.length) {
        em.fields.push({
            name: 'Host',
            value: s2gm.hostName,
            inline: false,
        });
    }

    if (s2gm.joinHistory?.length && (cfg.showLeavers || s2gm.status !== GameLobbyStatus.Started)) {
        let leftPlayers = s2gm.getLeavers();
        if (!cfg.showLeavers) {
            leftPlayers = leftPlayers.filter(x => (Date.now() - x.leftAt.getTime()) <= 40000);
        }
        if (leftPlayers.length) {
            const ps: string[] = [];
            for (const joinInfo of leftPlayers) {
                ps.push([
                    `\`${formatTimeDiff(joinInfo.joinedAt, s2gm.createdAt)} >`,
                    ` ${formatTimeDiff(joinInfo.leftAt, s2gm.createdAt)}\` `,
                    ` ~~${joinInfo.profile.name}#${joinInfo.profile.discriminator}~~`,
                ].join(''));
            }

            while (ps.join('\n').length > 1024) {
                ps.splice(0, 1);
            }

            em.fields.push({
                name: `Recently left`,
                value: ps.join('\n'),
                inline: false,
            });
        }
    }

    return em;
}
