import * as dotenv from 'dotenv';
import * as orm from 'typeorm';
import * as sqlite from 'sqlite';
import { setupFileLogger, logger } from '../logger';
import { CommandoClient, CommandoClientOptions, FriendlyError, SQLiteProvider } from 'discord.js-commando';
import { BotTask } from '../ds/dscommon';
import { LobbyReporterTask } from '../ds/mod/lobbyReporter';
import { InviteCommand } from '../ds/cmd/general';
import { StatusTask } from '../ds/mod/status';
import { DMChannel, Intents } from 'discord.js';
import { sleep, execAsync } from '../helpers';
import { SubscriptionsTask } from '../ds/mod/subscriptions';
import { LobbyPublishCommand } from '../ds/cmd/lobbyPublish';
import { HelpCommand } from '../ds/cmd/help';

export class DsBot extends CommandoClient {
    readonly issueTracker: string;
    conn: orm.Connection;
    slitedb: sqlite.Database;
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
            messageCacheMaxSize: 30,
            messageCacheLifetime: 60 * 20,
            messageSweepInterval: 600,
            messageEditHistoryMaxSize: 0,
            disableMentions: 'everyone',
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
        this.on('ready', async () => {
            logger.info(`Logged in as ${this.user.tag} (${this.user.id})`);
            logger.info(`Cached guilds: ${this.guilds.cache.size} , channels: ${this.channels.cache.size}`);
            // for (const guild of this.guilds.sort((a, b) => a.joinedTimestamp - b.joinedTimestamp).values()) {
            //     logger.info(`Connected with guild "${guild.name}" (${guild.memberCount}) id=${guild.id}`);
            //     for (const chan of guild.channels.values()) {
            //         logger.verbose(`Connected with text channel "${chan.name}" id=${chan.id}`);
            //     }
            // }
        });
        this.on('disconnect', () => logger.warn('Disconnected!'));
        this.on('shardReconnecting', (id) => logger.warn(`Shard reconnecting ${id} ..`));
        this.on('commandRun', (cmd, p, msg) => {
            logger.info(`Command run ${cmd.memberName}, Author '${msg.author.username}', msg: ${msg.content}`);
        });
        // FIXME:
        // this.on('commandError', (cmd, err) => {
        //     if (err instanceof FriendlyError) {
        //         logger.warn(`Error in command ${cmd.groupID}:${cmd.memberName}`, err);
        //     }
        //     else {
        //         logger.error(`Error in command ${cmd.groupID}:${cmd.memberName}`, err);
        //     }
        // });
        this.on('message', (msg) => {
            if (msg.channel instanceof DMChannel) {
                logger.debug('DM Message', {
                    userId: msg.author.id,
                    userTag: msg.author.tag,
                    username: msg.author.username,
                    content: msg.content,
                });
            }
        });

        this.registry.registerDefaultTypes();
        this.registry.registerDefaultGroups();
        this.registry.registerGroups([
            ['admin', 'Admin'],
            ['general', 'General'],
            ['subscriptions', 'Subscriptions'],
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
        if (this.doShutdown) {
            throw new Error(`forced shutdown`);
        }
        this.doShutdown = true;

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

        logger.info('shutting down discord connection..');
        this.destroy();

        logger.info('closing db connections..');
        if (this.slitedb) {
            await this.slitedb.close();
            this.slitedb = void 0;
        }
        if (this.conn) {
            await this.conn.close();
            this.conn = void 0;
        }
    }
}

process.on('unhandledRejection', e => { throw e; });
(async function() {
    dotenv.config();
    setupFileLogger('dsbot');

    const bot = new DsBot();
    await bot.prepare();

    if (process.env.NOTIFY_SOCKET) {
        const r = await execAsync('systemd-notify --ready');
        logger.verbose(`systemd-notify`, r);
    }

    async function terminate(sig: NodeJS.Signals) {
        logger.info(`Received ${sig}`);
        await bot.close();
    }

    process.on('SIGTERM', terminate);
    process.on('SIGINT', terminate);

    logger.verbose(`Logging in..`);
    await bot.login(process.env.DS_BOT_TOKEN);
    await bot.install();
})();
