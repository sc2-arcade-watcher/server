import * as orm from 'typeorm';
import { User, TextChannel, Message, RichEmbed, RichEmbedOptions, Snowflake, DiscordAPIError, PartialTextBasedChannelFields, DMChannel } from 'discord.js';
import { DsBot } from '../../bin/dsbot';
import { BotTask, DiscordErrorCode, GeneralCommand, formatObjectAsMessage, ExtendedCommandInfo } from '../dscommon';
import { S2GameLobby } from '../../entity/S2GameLobby';
import { GameLobbyStatus, GameRegion } from '../../gametracker';
import { S2GameLobbySlot } from '../../entity/S2GameLobbySlot';
import { DiscordClientStatus } from '../../ds/dscommon';
import { sleep, sleepUnless } from '../../helpers';
import { logger, logIt } from '../../logger';
import { DsGameTrackRule } from '../../entity/DsGameTrackRule';
import { DsGameLobbyMessage } from '../../entity/DsGameLobbyMessage';
import { CommandMessage, FriendlyError, ArgumentCollector } from 'discord.js-commando';
import { S2Region } from '../../entity/S2Region';
import { stripIndents } from 'common-tags';

interface NotificationSubscribeArgs {
    targetChannel?: TextChannel | DMChannel;
    mapName: string;
    isMapNameExact: boolean;
    region: keyof typeof GameRegion;
    variant: string | null;
    timeDelay: number;
    humanSlotsMin: number;
    showLeavers: boolean;
    deleteMessageStarted: boolean;
    deleteMessageDisbanded: boolean;
}

class NotificationNewCommand extends GeneralCommand {
    constructor(client: DsBot, info: ExtendedCommandInfo) {
        info = Object.assign(<ExtendedCommandInfo>{
            name: 'gn.new',
            description: 'Add new notification for game lobby',
            guildOnly: true,
            userPermissions: ['MANAGE_GUILD'],
            examples: [
                'gn.new #channel "MAPNAME GOES HERE"',
                'gn.new #channel "MAPNAME GOES HERE" Y ANY ANY 0 0 1 N N',
            ],
            args: [
                {
                    key: 'targetChannel',
                    type: 'channel',
                    prompt: 'Designate channel on which to post notifications',
                },
                {
                    key: 'mapName',
                    type: 'string',
                    prompt: 'Provide name of the map (or substring)',
                    min: 3,
                    max: 64,
                },
                {
                    key: 'isMapNameExact',
                    type: 'boolean',
                    prompt: 'Should match map name exactly? [`YES`] | Or containing substring? [`NO`]',
                },
                {
                    key: 'region',
                    type: 'string',
                    prompt: 'Designate game region [US/EU/KR/ANY]',
                    validate: (val: string): boolean => {
                        val = val.toUpperCase();
                        if (val === 'ANY') return true;
                        if (GameRegion[val as any]) return true;
                        return false;
                    },
                    parse: (val: string): keyof typeof GameRegion => {
                        val = val.toUpperCase();
                        if (val === 'ANY') return void 0;
                        return val as keyof typeof GameRegion;
                    },
                },
                {
                    key: 'variant',
                    type: 'string',
                    prompt: 'Name of game variant [Use `ANY` to ignore this requirement]',
                    max: 64,
                    parse: (val: string) => {
                        if (val.trim().toUpperCase() === 'ANY') {
                            return null;
                        }
                        return val;
                    },
                },
                {
                    key: 'timeDelay',
                    type: 'integer',
                    prompt: 'For how long should game lobby be open before posting notification (in seconds)? [Use \`0\` to ignore this requirement]',
                    min: 0,
                    max: 3600,
                },
                {
                    key: 'humanSlotsMin',
                    type: 'integer',
                    prompt: 'How many players must join the lobby before posting notification? [Use \`0\` to ignore this requirement]',
                    min: 0,
                    max: 16,
                },
                {
                    key: 'showLeavers',
                    type: 'boolean',
                    prompt: 'Show players who left the lobby in addition to active ones? [Yes/No]',
                },
                {
                    key: 'deleteMessageStarted',
                    type: 'boolean',
                    prompt: 'Should the message be deleted once game has started? [Yes/No]',
                },
                {
                    key: 'deleteMessageDisbanded',
                    type: 'boolean',
                    prompt: 'Should the message be deleted if lobby is disbanded? [Yes/No]',
                },
            ],
        }, info);
        if (info.dmOnly) {
            info.args = info.args.splice(1);
        }
        super(client, info);
    }

    public async exec(msg: CommandMessage, args: NotificationSubscribeArgs) {
        const rule = new DsGameTrackRule();
        if (msg.channel instanceof TextChannel) {
            const chan = msg.channel;
            const rcount = await this.client.conn.getRepository(DsGameTrackRule).count({ guild: chan.guild.id, enabled: true });
            if (chan.guild.memberCount <= (5 * rcount) && !this.client.isOwner(msg.author)) {
                return msg.reply(`Exceeded curent limit - one subscription per 5 members of the guild. (Limit might be lifted in the future).`);
            }
            rule.guild = chan.guild.id;
            rule.channel = args.targetChannel.id;
        }
        else if (msg.channel instanceof DMChannel) {
            const chan = msg.channel;
            const rcount = await this.client.conn.getRepository(DsGameTrackRule).count({ user: chan.recipient.id, enabled: true });
            if (10 <= rcount && !this.client.isOwner(msg.author)) {
                return msg.reply(`Exceeded curent limit - 10 subscriptions per user. (Limit might be lifted in the future).`);
            }
            rule.user = chan.recipient.id;
        }
        else {
            throw new FriendlyError('Unsupported channel type');
        }

        rule.mapName = args.mapName;
        rule.isMapNamePartial = !args.isMapNameExact;
        if (args.region) {
            rule.region = await this.client.conn.getRepository(S2Region).findOneOrFail({ code: args.region });
        }
        rule.variant = args.variant;
        rule.timeDelay = args.timeDelay || null;
        rule.humanSlotsMin = args.humanSlotsMin || null;
        rule.showLeavers = args.showLeavers;
        rule.deleteMessageStarted = args.deleteMessageStarted;
        rule.deleteMessageDisbanded = args.deleteMessageDisbanded;
        await this.client.conn.getRepository(DsGameTrackRule).save(rule);
        this.client.tasks.gnotify.trackRules.set(rule.id, rule);

        return msg.reply(stripIndents`
            Success! Subscription has been setup, assigned ID: \`${rule.id}\`.
            From now on you'll be reported about **new** game lobbies which match the configuration.
            To verify its parameters use \`gn.list\`.
        `);
    }
}

class NotificationNewDmCommand extends NotificationNewCommand {
    constructor(client: DsBot) {
        const info: ExtendedCommandInfo = {
            name: 'gn.newdm',
            guildOnly: false,
            dmOnly: true,
        };
        super(client, info);
        this.description += ' (via DM)';
    }
}

class NotificationDeleteCommand extends GeneralCommand {
    constructor(client: DsBot) {
        super(client, {
            name: 'gn.del',
            description: 'Remove existing subscription.',
            userPermissions: ['MANAGE_GUILD'],
            args: [
                {
                    key: 'id',
                    type: 'integer',
                    prompt: 'Provie identifier of subscription',
                },
            ],
        });
    }

    public async exec(msg: CommandMessage, args: { id: number }) {
        const subscription = this.client.tasks.gnotify.trackRules.get(args.id);
        if (!subscription) {
            return msg.reply('Incorrect ID');
        }

        if (msg.channel instanceof TextChannel) {
            const chan = msg.channel;
            if (subscription.guild !== chan.guild.id) {
                return msg.reply('Incorrect ID');
            }
        }
        else if (msg.channel instanceof DMChannel) {
            const chan = msg.channel;
            if (subscription.user !== chan.recipient.id) {
                return msg.reply('Incorrect ID');
            }
        }
        else {
            throw new FriendlyError('Unsupported channel type');
        }

        this.client.tasks.gnotify.trackRules.delete(args.id);
        await this.client.conn.getRepository(DsGameTrackRule).update(args.id, { enabled: false });
        return msg.reply('Done');
    }
}

class NotificationListCommand extends GeneralCommand {
    constructor(client: DsBot) {
        super(client, {
            name: 'gn.list',
            description: 'List your existing subscriptions.',
            userPermissions: ['MANAGE_GUILD'],
        });
    }

    public async exec(msg: CommandMessage) {
        let rules: DsGameTrackRule[] = [];

        if (msg.channel instanceof TextChannel) {
            const chan = msg.channel;
            rules = Array.from(this.client.tasks.gnotify.trackRules.values()).filter(x => {
                return x.guild === chan.guild.id;
            });
        }
        else if (msg.channel instanceof DMChannel) {
            const chan = msg.channel;
            rules = Array.from(this.client.tasks.gnotify.trackRules.values()).filter(x => {
                return x.user === chan.recipient.id;
            });
        }
        else {
            throw new FriendlyError(`Expected a valid channel, received: "${String(msg.channel)}"`);
        }

        if (!rules.length) {
            return msg.reply(`You've no active subscriptions.`);
        }

        const rembed: RichEmbedOptions = {
            title: 'Active subscriptions',
            fields: [],
        };

        for (const rsub of rules) {
            rembed.fields.push({
                name: `Sub ID: **${rsub.id}**`,
                value: formatObjectAsMessage({
                    'Created at': rsub.createdAt.toUTCString(),
                    'Channel': (<TextChannel>this.client.channels.get(rsub.channel))?.name,
                    'Map name': rsub.mapName,
                    'Partial match of map name': rsub.isMapNamePartial,
                    'Region': rsub?.region?.code ?? 'ANY',
                    'Map variant': rsub?.variant ?? 'ANY',
                    'Delay of a notification': Number(rsub.timeDelay),
                    'Minimum number of human slots': Number(rsub.humanSlotsMin),
                    'Show players who left the lobby': rsub.showLeavers,
                    'Delete message after start': rsub.deleteMessageStarted,
                    'Delete message if disbanded': rsub.deleteMessageDisbanded,
                }),
                inline: false,
            });
        }

        return msg.reply('', { embed: rembed});
    }
}

class NotificationReloadCommand extends GeneralCommand {
    constructor(client: DsBot) {
        super(client, {
            name: 'gn.reload',
            ownerOnly: true,
        });
    }

    public async exec(msg: CommandMessage) {
        await this.client.tasks.gnotify.reloadSubscriptions();
        return msg.reply(`Done. Active subscriptions count: ${this.client.tasks.gnotify.trackRules.size}.`);
    }
}

interface GameLobbyCandidate {
    rule: DsGameTrackRule;
    lobby: S2GameLobby;
}

interface GameLobbyPost {
    // embed?: RichEmbedOptions;
    postedMessages: Set<DsGameLobbyMessage>;
}

export class LobbyNotifierTask extends BotTask {
    trackedLobbies = new Map<number, S2GameLobby>();
    trackRules = new Map<number, DsGameTrackRule>();

    candidates = new Map<number, Set<GameLobbyCandidate>>();
    lobbyPosts = new Map<number, GameLobbyPost>();

    offsetLobbyId = 0;
    firstUpdate = true;

    async reloadSubscriptions() {
        this.trackRules.clear();
        for (const rule of await this.conn.getRepository(DsGameTrackRule).find({
            relations: ['region'],
            where: { enabled: true },
        })) {
            this.trackRules.set(rule.id, rule);
        }
    }

    async load() {
        await this.reloadSubscriptions();

        this.client.registry.registerCommands([
            NotificationNewCommand,
            NotificationNewDmCommand,
            NotificationDeleteCommand,
            NotificationListCommand,
            NotificationReloadCommand,
        ]);

        setTimeout(this.update.bind(this), 1000).unref();
        setInterval(this.flushMessages.bind(this), 60000 * 3600).unref();
    }

    async unload() {
    }

    @logIt({
        resDump: true,
    })
    protected async flushMessages() {
        if (!await this.waitUntilReady()) return;
        const res = await this.conn.getRepository(DsGameLobbyMessage).delete([
            'updated_at < FROM_UNIXTIME(UNIX_TIMESTAMP()-3600*24)',
            'completed = true',
        ]);
        return res.affected;
    }

    @logIt()
    protected async restore() {
        const lobMessages = await this.conn.getRepository(DsGameLobbyMessage)
            .createQueryBuilder('lmsg')
            .innerJoinAndSelect('lmsg.rule', 'rule')
            .innerJoinAndSelect('lmsg.lobby', 'lobby')
            .innerJoinAndSelect('lobby.region', 'region')
            .innerJoinAndSelect('lobby.mapDocumentVersion', 'mapDocVer')
            .innerJoinAndSelect('mapDocVer.document', 'mapDoc')
            .innerJoinAndSelect('lobby.players', 'player')
            .andWhere('lmsg.completed = false')
            .getMany()
        ;

        for (const lmsg of lobMessages) {
            let s2gm: S2GameLobby;
            s2gm = this.trackedLobbies.get(lmsg.lobby.id);
            if (!s2gm) {
                s2gm = lmsg.lobby;
                this.trackedLobbies.set(s2gm.id, s2gm);
                this.lobbyPosts.set(s2gm.id, {
                    // embed: void 0,
                    postedMessages: new Set(),
                });
            }
            else {
                lmsg.lobby = s2gm;
            }

            this.lobbyPosts.get(s2gm.id).postedMessages.add(lmsg);
        }

        await Promise.all(Array.from(this.trackedLobbies.values()).map(x => this.updateLobbyMessage(x)));
    }

    @logIt()
    async update() {
        this.running = true;
        while (await this.waitUntilReady()) {
            if (this.firstUpdate) {
                await this.restore();
                await this.flushMessages();
                this.firstUpdate = false;
            }

            await this.updatePlayers();
            await sleepUnless(500, () => !this.client.doShutdown);

            await this.updateOpenLobbies();
            await this.evaluateCandidates();
            await this.updateClosedLobbies();
            // TODO: update lobby details
            await sleepUnless(500, () => !this.client.doShutdown);
        }
        this.running = false;
    }

    protected async updateOpenLobbies() {
        const newLobbies = await this.conn.getRepository(S2GameLobby)
            .createQueryBuilder('lobby')
            .innerJoinAndSelect('lobby.region', 'region')
            .innerJoinAndSelect('lobby.mapDocumentVersion', 'mapDocVer')
            .innerJoinAndSelect('mapDocVer.document', 'mapDoc')
            .innerJoinAndSelect('lobby.players', 'player')
            .andWhere('lobby.status = :status', { status: GameLobbyStatus.Open })
            .andWhere('lobby.id NOT IN (:trackedLobbies)', { 'trackedLobbies': [0].concat(Array.from(this.trackedLobbies.keys())) })
            .andWhere('lobby.id > :id', { id: this.offsetLobbyId })
            .orderBy('lobby.createdAt', 'ASC')
            .getMany()
        ;

        logger.debug(`newlobs: ${newLobbies.length}`);

        for (const s2gm of newLobbies) {
            if (s2gm.id > this.offsetLobbyId) {
                this.offsetLobbyId = s2gm.id;
            }

            if (this.lobbyPosts.has(s2gm.id)) {
                continue;
            }

            const candidates = new Set<GameLobbyCandidate>();

            for (const rule of this.trackRules.values()) {
                if (
                    (
                        (rule.isMapNameRegex && s2gm.mapDocumentVersion.document.name.match(new RegExp(rule.mapName, 'iu'))) ||
                        (rule.isMapNamePartial && s2gm.mapDocumentVersion.document.name.toLowerCase().indexOf(rule.mapName.toLowerCase()) !== -1) ||
                        (!rule.isMapNameRegex && !rule.isMapNamePartial && s2gm.mapDocumentVersion.document.name.toLowerCase() === rule.mapName.toLowerCase())
                    ) &&
                    (!rule.variant || rule.variant === s2gm.mapVariantMode) &&
                    (!rule.region || rule.region.id === s2gm.region.id)
                ) {
                    candidates.add({
                        lobby: s2gm,
                        rule: rule,
                    });
                }
            }

            if (candidates.size > 0) {
                this.candidates.set(s2gm.id, candidates);
                this.trackedLobbies.set(s2gm.id, s2gm);
                this.lobbyPosts.set(s2gm.id, {
                    // embed: embedGameLobby(s2gm),
                    postedMessages: new Set(),
                });
                logger.info(`New lobby ${s2gm.region.code}#${s2gm.bnetRecordId} for "${s2gm.mapDocumentVersion.document.name}". Matching rules=${candidates.size}`);
            }
        }
    }

    protected async evaluateCandidates() {
        const pendingPosts: Promise<void>[] = [];

        for (const [lobId, candidates] of this.candidates) {
            const s2gm = this.trackedLobbies.get(lobId);
            for (const currCand of candidates) {
                const timeDiff = (Date.now() - s2gm.createdAt.getTime()) / 1000;
                if (
                    (currCand.rule.timeDelay && currCand.rule.timeDelay > timeDiff) &&
                    (currCand.rule.humanSlotsMin && currCand.rule.humanSlotsMin > Math.max(s2gm.slotsHumansTaken, s2gm.activePlayers.length))
                ) {
                    continue;
                }
                pendingPosts.push(this.postLobbyMessage(s2gm, this.lobbyPosts.get(s2gm.id), currCand.rule));
                candidates.delete(currCand);
            }
        }

        await Promise.all(pendingPosts);
    }

    protected async updateClosedLobbies() {
        if (this.trackedLobbies.size <= 0) return;

        const closedLobbies = await this.conn.getRepository(S2GameLobby)
            .createQueryBuilder('lobby')
            .select(['lobby.id', 'lobby.status', 'lobby.closedAt', 'lobby.slotsHumansTaken', 'lobby.slotsHumansTotal', 'lobby.hostName', 'lobby.lobbyTitle'])
            .innerJoinAndSelect('lobby.players', 'player')
            .andWhereInIds(Array.from(this.trackedLobbies.keys()))
            .andWhere('lobby.status != :status', { status: GameLobbyStatus.Open })
            .getMany()
        ;
        const pendingUpdates: Promise<void>[] = [];

        for (const lob of closedLobbies) {
            const s2gm = this.trackedLobbies.get(lob.id);
            Object.assign(s2gm, lob);

            logger.info(`Lobby ${s2gm.region.code}#${s2gm.bnetRecordId} for "${s2gm.mapDocumentVersion.document.name}" has ${s2gm.status} | ${s2gm.closedAt.toUTCString()}`);

            this.trackedLobbies.delete(lob.id);
            this.candidates.delete(lob.id);

            pendingUpdates.push(this.updateLobbyMessage(s2gm));
        }

        await Promise.all(pendingUpdates);
    }

    async updatePlayers() {
        if (this.trackedLobbies.size <= 0) return;

        let trackedPlayers = Array.from(this.trackedLobbies.values()).map(x => x.activePlayers.map(v => v.id)).flat();
        if (!trackedPlayers.length) {
            trackedPlayers = [0];
        }

        if (trackedPlayers.length) {
            const newPlayers = await this.conn.getRepository(S2GameLobbySlot)
                .createQueryBuilder('player')
                .leftJoin('player.lobby', 'lobby')
                .addSelect(['lobby.id', 'lobby.slotsHumansTaken', 'lobby.slotsHumansTotal', 'lobby.hostName', 'lobby.lobbyTitle'])
                .andWhere('lobby.id IN (:trackedLobbies)', { 'trackedLobbies': Array.from(this.trackedLobbies.keys()) })
                .andWhere('player.id NOT IN (:allPlayers)', { 'allPlayers': trackedPlayers })
                .andWhere('player.leftAt IS NULL')
                .getMany()
            ;
            for (const player of newPlayers) {
                const s2gm = this.trackedLobbies.get(player.lobby.id);
                Object.assign(s2gm, player.lobby);
                logger.info(`Player "${player.name}" joined ${s2gm.region.code}#${s2gm.bnetRecordId} "${s2gm.mapDocumentVersion.document.name}" [${s2gm.slotsHumansTaken}/${s2gm.slotsHumansTotal}]`);
                s2gm.slots = s2gm.slots.filter(x => x.id !== player.id);
                s2gm.slots.push(player);
            }

            const leftPlayers = await this.conn.getRepository(S2GameLobbySlot)
                .createQueryBuilder('player')
                .innerJoin('player.lobby', 'lobby')
                .addSelect(['lobby.id', 'lobby.slotsHumansTaken', 'lobby.slotsHumansTotal', 'lobby.hostName', 'lobby.lobbyTitle'])
                .andWhere('lobby.id IN (:trackedLobbies)', { 'trackedLobbies': Array.from(this.trackedLobbies.keys()) })
                .andWhere('player.id IN (:ids)', { 'ids': trackedPlayers })
                .andWhere('player.leftAt IS NOT NULL')
                .getMany()
            ;
            for (const player of leftPlayers) {
                const s2gm = this.trackedLobbies.get(player.lobby.id);
                Object.assign(s2gm, player.lobby);
                logger.info(`Player "${player.name}" left ${s2gm.region.code}#${s2gm.bnetRecordId} "${s2gm.mapDocumentVersion.document.name}" [${s2gm.slotsHumansTaken}/${s2gm.slotsHumansTotal}]`);
                s2gm.slots = s2gm.slots.filter(x => x.id !== player.id);
                s2gm.slots.push(player);
            }


            const affectedLobbies = new Set(newPlayers.map(x => x.lobby.id).concat(leftPlayers.map(x => x.lobby.id)))
            const pendingUpdates: Promise<void>[] = [];
            for (const lobId of affectedLobbies) {
                const s2gm = this.trackedLobbies.get(lobId);
                pendingUpdates.push(this.updateLobbyMessage(s2gm));
            }
            await Promise.all(pendingUpdates);
        }
    }

    protected async fetchDestChannel(rule: DsGameTrackRule): Promise<TextChannel | DMChannel> {
        if (rule.user) {
            const destUser = await this.client.fetchUser(rule.user);
            if (!destUser) {
                logger.error(`User doesn't exist, rule #${rule.id}`, rule);
                return;
            }
            return destUser.dmChannel || (destUser.createDM());
        }
        else if (rule.guild) {
            const destGuild = this.client.guilds.get(rule.guild);
            if (!destGuild) {
                logger.error(`Guild doesn't exist, rule #${rule.id}`, rule);
                return;
            }

            const destGuildChan = destGuild.channels.get(rule.channel);
            if (!destGuildChan) {
                logger.error(`Guild chan doesn't exist, rule #${rule.id}`, rule);
                return;
            }
            if (!(destGuildChan instanceof TextChannel)) {
                logger.error(`Guild chan incorrect type=${destGuildChan.type}, rule #${rule.id}`, rule);
                return;
            }
            return destGuildChan;
        }
        else {
            logger.error(`Invalid rule #${rule.id}`, rule);
            return;
        }
    }

    protected async postLobbyMessage(s2gm: S2GameLobby, lpost: GameLobbyPost, rule: DsGameTrackRule) {
        const gameLobMessage = new DsGameLobbyMessage();
        gameLobMessage.lobby = s2gm;
        gameLobMessage.rule = rule;
        const lbEmbed = embedGameLobby(s2gm, rule);

        let chan: TextChannel | DMChannel;
        try {
            chan = await this.fetchDestChannel(rule);
            if (!chan) {
                logger.info(`Deleting rule #${rule.id}`);
                await this.conn.getRepository(DsGameTrackRule).update(rule.id, { enabled: false });
                this.trackRules.delete(rule.id);
                return;
            }
            const msg = await chan.send('', { embed: lbEmbed }) as Message;
            gameLobMessage.message = msg.id;
        }
        catch (err) {
            if (err instanceof DiscordAPIError) {
                if (err.code === DiscordErrorCode.MissingPermissions || err.code === DiscordErrorCode.MissingAccess) {
                    logger.error(`Failed to send message for lobby #${s2gm.id}, rule #${rule.id}`, err.message);
                    await this.conn.getRepository(DsGameTrackRule).update(rule.id, { enabled: false });
                    this.trackRules.delete(rule.id);
                    return;
                }
                logger.error(`Failed to send message for lobby #${s2gm.id}, rule #${rule.id}`, err, lbEmbed, rule, s2gm);
                return;
            }
            else {
                throw err;
            }
        }

        gameLobMessage.owner = rule.guild ?? rule.user;
        gameLobMessage.channel = chan.id;
        const res = await this.conn.getRepository(DsGameLobbyMessage).insert(gameLobMessage);
        gameLobMessage.id = res.identifiers[0].id;

        lpost.postedMessages.add(gameLobMessage);
    }

    protected async releaseLobbyMessage(lpost: GameLobbyPost, lmsg: DsGameLobbyMessage) {
        await this.conn.getRepository(DsGameLobbyMessage).update(lmsg.id, { updatedAt: new Date(), completed: true });
        lpost.postedMessages.delete(lmsg);
    }

    protected async editLobbyMessage(lpost: GameLobbyPost, lmsg: DsGameLobbyMessage) {
        const lbEmbed = embedGameLobby(lmsg.lobby, lmsg.rule);
        try {
            const chan = await this.fetchDestChannel(lmsg.rule);
            if (!chan) {
                await this.releaseLobbyMessage(lpost, lmsg);
                return;
            }
            const msg = await chan.fetchMessage(lmsg.message);
            if (!msg) {
                await this.releaseLobbyMessage(lpost, lmsg);
                return;
            }
            await msg.edit('', { embed: lbEmbed });
            if (
                (lmsg.lobby.status === GameLobbyStatus.Started && lmsg.rule.deleteMessageStarted) ||
                (lmsg.lobby.status === GameLobbyStatus.Abandoned && lmsg.rule.deleteMessageDisbanded) ||
                (lmsg.lobby.status === GameLobbyStatus.Unknown && lmsg.rule.deleteMessageDisbanded)
            ) {
                msg.delete(5000).then(async (msg) => {
                    await this.releaseLobbyMessage(lpost, lmsg);
                }, async (err) => {
                    if (err.code === DiscordErrorCode.UnknownMessage) {
                        await this.releaseLobbyMessage(lpost, lmsg);
                        return;
                    }
                    logger.error(`Failed to delete`, err);
                });
            }
            else if (lmsg.lobby.status !== GameLobbyStatus.Open) {
                await this.releaseLobbyMessage(lpost, lmsg);
            }
        }
        catch (err) {
            if (err instanceof DiscordAPIError) {
                if (err.code === DiscordErrorCode.UnknownMessage || err.code === DiscordErrorCode.MissingAccess) {
                    await this.releaseLobbyMessage(lpost, lmsg);
                    return;
                }
                logger.error(`Failed to update message for lobby #${lmsg.lobby.id}, rule #${lmsg.rule.id}`, err, lbEmbed, lmsg.rule);
            }
            else {
                throw err;
            }
        }
    }

    @logIt({
        argsDump: (s2gm: S2GameLobby) => [s2gm.id, s2gm.mapDocumentVersion.document.name, s2gm.hostName, s2gm.slotsHumansTaken, s2gm.slots.length]
    })
    protected async updateLobbyMessage(s2gm: S2GameLobby) {
        const pendingPosts: Promise<void>[] = [];
        const lpost = this.lobbyPosts.get(s2gm.id);
        // lpost.embed = embedGameLobby(s2gm);
        for (const lmsg of lpost.postedMessages) {
            pendingPosts.push(this.editLobbyMessage(lpost, lmsg));
        }
        await Promise.all(pendingPosts);
    }
}

function formatTimeDiff(a: Date, b: Date) {
    const secsDiff = ((a.getTime() - b.getTime()) / 1000);
    return `${(Math.floor(secsDiff / 60)).toFixed(0).padStart(2, '0')}:${Math.floor(secsDiff % 60).toFixed(0).padStart(2, '0')}`;
}

function embedGameLobby(s2gm: S2GameLobby, rule: DsGameTrackRule): RichEmbedOptions {
    // \`v${s2gm.mapDocumentVersion.majorVersion}.${s2gm.mapDocumentVersion.minorVersion}\`
    // battlenet:://starcraft/map/${s2gm.region.id}/${s2gm.mapDocumentVersion.document.bnetId}
    const em: RichEmbedOptions = {
        title: `${s2gm.mapDocumentVersion.document.name}`,
        fields: [],
        thumbnail: {
            url: `http://sc2arcade.talv.space/bnet/${s2gm.mapDocumentVersion.iconHash}.jpg`,
        },
        timestamp: s2gm.createdAt,
        footer: {
            text: `${s2gm.region.code}#${s2gm.bnetRecordId}`,
        },
    };

    switch (s2gm.region.id) {
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
    }

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
    if (s2gm.status !== GameLobbyStatus.Open) {
        statusm.push(` \`${formatTimeDiff(s2gm.closedAt, s2gm.createdAt)}\``);
    }

    em.fields.push({
        name: `Status`,
        value: statusm.join(''),
        inline: true,
    });

    if (s2gm.mapVariantMode.trim().length) {
        em.fields.push({
            name: `Variant`,
            value: `${s2gm.mapVariantMode}`,
            inline: true,
        });
    }

    if (s2gm.lobbyTitle) {
        em.fields.push({
            name: `Title`,
            value: s2gm.lobbyTitle,
            inline: false,
        });
    }

    const activePlayers = s2gm.activePlayers;
    if ((s2gm.status === GameLobbyStatus.Open || s2gm.status === GameLobbyStatus.Started) && activePlayers.length) {
        const ps: string[] = [];
        let i = 1;
        for (const player of activePlayers.sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())) {
            ps.push([
                `\`${i.toString().padStart(Math.floor(1 + activePlayers.length / 10), '0')}.`,
                ` +${formatTimeDiff(player.joinedAt, s2gm.createdAt)}\` `,
                ` **${player.name}**`,
                (player.name === s2gm.hostName ? '　(host)' : '')
            ].join(''));
            ++i;
        }
        em.fields.push({
            name: `Players [${activePlayers.length}/${s2gm.slotsHumansTotal}]`,
            value: ps.join('\n'),
            inline: false,
        });
    }

    // FIXME: leavers
    // const leftPlayers = s2gm.leftPlayers;
    // if (rule.showLeavers && leftPlayers.length) {
    //     const ps: string[] = [];
    //     let i = 1;
    //     for (const player of leftPlayers.sort((a, b) => a.leftAt.getTime() - b.leftAt.getTime())) {
    //         ps.push([
    //             `\`${i.toString().padStart(Math.floor(1 + leftPlayers.length / 10), '0')}.`,
    //             ` +${formatTimeDiff(player.joinedAt, s2gm.createdAt)} >`,
    //             ` +${formatTimeDiff(player.leftAt, s2gm.createdAt)}\` `,
    //             ` ~~${player.name}~~`,
    //         ].join(''));
    //         ++i;
    //     }

    //     while (ps.join('\n').length > 1024) {
    //         ps.splice(0, 1);
    //     }

    //     em.fields.push({
    //         name: `Seen players [${leftPlayers.length}]`,
    //         value: ps.join('\n'),
    //         inline: false,
    //     });
    // }

    return em;
}
