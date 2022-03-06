import * as dotenv from 'dotenv';
import * as orm from 'typeorm';
import { sleep, systemdNotify, setupProcessTerminator, systemdNotifyWatchdog } from '../helpers';
import { setupFileLogger, logger } from '../logger';
import { CommandoClient, CommandoClientOptions, FriendlyError } from 'discord.js-commando';
import { BotTask } from '../ds/dscommon';
import { LobbyReporterTask } from '../ds/mod/lobbyReporter';
import { InviteCommand } from '../ds/cmd/general';
import { StatusTask } from '../ds/mod/status';
import { DMChannel, Intents, UserResolvable, HTTPError } from 'discord.js';
import { SubscriptionsTask } from '../ds/mod/subscriptions';
import { LobbyPublishCommand } from '../ds/cmd/lobbyPublish';
import { HelpCommand } from '../ds/cmd/help';
import { GuildsOverviewCommand } from '../ds/cmd/admin';
import { oneLine } from 'common-tags';

export class DsBot extends CommandoClient {
    readonly issueTracker: string;
    conn: orm.Connection;
    tasks: {
        lreporter: LobbyReporterTask;
        subscription: SubscriptionsTask,
        status: StatusTask;
    };
    doShutdown: boolean;

    constructor(options?: CommandoClientOptions) {
        options = Object.assign<CommandoClientOptions, CommandoClientOptions>({
            // commando
            owner: process.env.DS_BOT_OWNER,
            commandPrefix: '.',
            // commandEditableDuration: 300,
            nonCommandEditable: false,

            // discord.js
            messageCacheMaxSize: 50,
            messageCacheLifetime: 60 * 10,
            messageSweepInterval: 300,
            messageEditHistoryMaxSize: 0,
            disableMentions: 'everyone',
            retryLimit: 10, // keep hammering Dicord's API, at least 10 times before giving up on specific request

            ws: {
                intents: [
                    'GUILDS',
                    // 'GUILD_MEMBERS',
                    // 'GUILD_BANS',
                    // 'GUILD_EMOJIS',
                    // 'GUILD_INTEGRATIONS',
                    // 'GUILD_WEBHOOKS',
                    // 'GUILD_INVITES',
                    // 'GUILD_VOICE_STATES',
                    // 'GUILD_PRESENCES',
                    'GUILD_MESSAGES',
                    // 'GUILD_MESSAGE_REACTIONS',
                    // 'GUILD_MESSAGE_TYPING',
                    'DIRECT_MESSAGES',
                    // 'DIRECT_MESSAGE_REACTIONS',
                    // 'DIRECT_MESSAGE_TYPING',
                ],
            }
        }, options);
        super(options);
        this.issueTracker = 'https://github.com/sc2-arcade-watcher/issue-tracker/issues?q=is%3Aissue+';
        this.doShutdown = false;

        this.on('error', (e) => logger.error(e.message, e));
        this.on('warn', (s) => logger.warn(s));
        this.on('debug', (s) => logger.debug(s));
        this.on('ready', () => {
            logger.info(`Logged in as ${this.user.tag} (${this.user.id}) guilds: ${this.guilds.cache.size} channels: ${this.channels.cache.size}`);
            for (const guild of this.guilds.cache.array().sort((a, b) => a.joinedTimestamp - b.joinedTimestamp).values()) {
                logger.info(`Connected with guild "${guild.name}" (${guild.id}) members: ${guild.memberCount} createdAt: ${guild.createdAt} channels: ${guild.channels.cache.size}`);
            }
        });
        this.on('disconnect', () => logger.warn('Disconnected!'));
        this.on('shardReconnecting', (id) => logger.warn(`Shard reconnecting ${id} ..`));
        this.on('shardError', (err, id) => logger.warn(`Shard error ${id} ..`, err));
        this.on('shardReady', (id, unavailableGuilds) => logger.info(`Shard ready ${id} , unavailable guilds: ${unavailableGuilds?.size ?? 0}`, unavailableGuilds));
        this.on('rateLimit', (d) => logger.warn('ratelimit', d));

        this.on('commandRun', (cmd, p, msg, args) => {
            logger.info(`Command run ${cmd.memberName} by ${msg.author.tag} (${msg.author.id})`, msg.content, args);
        });
        this.on('commandError', (cmd, err, cmsg, args, pattern) => {
            if (err instanceof FriendlyError) {
                logger.warn(`Error in command ${cmd.groupID}:${cmd.memberName}`, err);
            }
            else {
                logger.error(`Error in command ${cmd.groupID}:${cmd.memberName}`, err);
            }
        });

        this.on('message', (msg) => {
            if (msg.channel instanceof DMChannel && msg.author.id !== this.user.id) {
                logger.debug(`Received DM from ${msg.author.tag} (${msg.author.id})`, msg.content);
            }
        });

        this.on('guildCreate', (guild) => logger.info(`joined guild ${guild.name} (${guild.id})`));
        this.on('guildDelete', (guild) => logger.info(`left guild ${guild.name} (${guild.id})`));
        this.on('guildUnavailable', (guild) => logger.info(`guild unavailable ${guild.name} (${guild.id})`));

        this.registry.registerDefaultTypes();
        this.registry.registerGroups([
            ['subscription', 'Subscription'],
            ['util', 'Utility'],
            ['admin', 'Admin'],
        ]);
        this.registry.registerDefaultCommands({
            help: false,
            prefix: false,
            ping: true,
            eval: false,
            commandState: false,
            unknownCommand: false,
        });
        this.registry.registerCommand(HelpCommand);
        this.registry.registerCommand(InviteCommand);
        this.registry.registerCommand(LobbyPublishCommand);
        this.registry.registerCommand(GuildsOverviewCommand);
    }

    async prepare() {
        // TODO: remove or fix?
        // there's something wrong with that implementation, also it's not used for anything apart `prefix` cmd
        // logger.verbose(`Opening sqlite db..`);
        // this.slitedb = await sqlite.open('data/commando-settings.db');
        // await this.setProvider(new SQLiteProvider(this.slitedb));
        logger.verbose(`Connecting to mariadb..`);
        this.conn = await orm.createConnection();
    }

    async install() {
        this.tasks = {
            lreporter: new LobbyReporterTask(this),
            subscription: new SubscriptionsTask(this),
            status: new StatusTask(this)
        };

        await Promise.all(Object.values(this.tasks).map(async v => {
            logger.verbose(`Loading.. ${v.constructor.name}`);
            await v.load();
            logger.verbose(`${v.constructor.name} has loaded!`);
        }));

        logger.verbose('All tasks loaded!');
    }

    async close() {
        if (this.doShutdown) return;
        this.doShutdown = true;
        logger.info('closing discord ..');

        if (this.tasks) {
            logger.info('stopping pending tasks..');
            const pendingRequests: Promise<void>[] = [];
            for (const task of Object.values(this.tasks)) {
                pendingRequests.push(task.unload());
            }
            await Promise.all(pendingRequests);

            logger.info('waiting for tasks to finish..');
            let prevPendingTasks = [];
            while (1) {
                await sleep(50);
                const activeTasks = Object.values(this.tasks).filter(x => x.running);
                if (!activeTasks.length) break;
                if (prevPendingTasks.length !== activeTasks.length) {
                    prevPendingTasks = activeTasks;
                    logger.info(`Pending tasks: ${String(activeTasks.map(x => `${x.constructor.name}`))}`);
                }
            }
        }

        logger.info('shutting down discord connection..');
        this.destroy();

        if (this.conn) {
            logger.info('closing mariadb connections..');
            await this.conn.close();
            this.conn = void 0;
        }

        logger.info('discord closed');
    }

    get staffMembers() {
        return (process.env.DS_BOT_STAFF || '').split(' ').map(x => {
            const tmp = x.split(':');
            return {
                id: String(tmp[0]),
                tag: tmp.length > 1 ? String(tmp[1]) : null,
            };
        });
    }

    isStaff(user: UserResolvable, includeOwner = true) {
        return this.staffMembers.findIndex(x => x.id === this.users.resolveID(user)) !== -1 || this.isOwner(user);
    }

    async fetchStaffMembers() {
        return Promise.all(this.staffMembers.map(x => this.users.fetch(x.id, true)));
    }
}

interface IDiscordShitState {
    errCounter: number;
    firstErrorAt: number | null;
    stateResetTimeout: NodeJS.Timer | null;
}

(async function() {
    dotenv.config();
    await systemdNotify('READY');
    setupFileLogger('dsbot');

    const bot = new DsBot();
    const dsShittingState: IDiscordShitState = {
        errCounter: 0,
        firstErrorAt: null,
        stateResetTimeout: null,
    };
    const dsShittingTimeLimit = 1000 * 60 * 10;
    const dsShittingTimeReset = 1000 * 60 * 3;

    process.on('unhandledRejection', e => {
        // TODO: perhaps should limit it to only 5xx responses?
        if (e instanceof HTTPError) {
            if (!dsShittingState.stateResetTimeout) {
                logger.error(`Discord started shitting itself..`);
                dsShittingState.firstErrorAt = Date.now();
                dsShittingState.stateResetTimeout = setTimeout(() => {
                    logger.info(oneLine`
                        Discord appears to be stable again..
                        shit counter stopped at ${dsShittingState.errCounter}
                        after ${(Date.now() - dsShittingState.firstErrorAt) / 1000}s
                    `);
                    dsShittingState.errCounter = 0;
                    dsShittingState.firstErrorAt = null;
                    dsShittingState.stateResetTimeout = null;
                }, dsShittingTimeReset).unref();
                // TODO: should probably force restart
            }
            else {
                dsShittingState.stateResetTimeout.refresh();
            }

            dsShittingState.errCounter++;
            logger.warn(`Discord shit counter: ${dsShittingState.errCounter}`, e);

            if (dsShittingState.firstErrorAt <= (Date.now() - dsShittingTimeLimit)) {
                logger.error(`Discord continues to shit itself, giving up for this session..`);
                // systemd will trigger full restart (if we haven't hit the limit for the day)
                throw e;
            }

            return;
        }

        logger.error('unhandledRejection', e);
        throw e;
    });

    await systemdNotifyWatchdog(0);
    setupProcessTerminator(async () => {
        await systemdNotify('STOPPING');
        await bot.close();
    });

    await bot.prepare();
    logger.verbose(`Logging in..`);
    await bot.login(process.env.DS_BOT_TOKEN);
    await bot.install();
})();
