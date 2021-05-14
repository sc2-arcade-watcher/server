import { User, TextChannel, MessageEmbedOptions, DMChannel, Channel, NewsChannel, Util, DiscordAPIError } from 'discord.js';
import { DsBot } from '../../bin/dsbot';
import { BotTask, DiscordErrorCode, GeneralCommand, formatObjectAsMessage, ExtendedCommandInfo, csvCombineRow } from '../dscommon';
import { logger, logIt } from '../../logger';
import { DsGameLobbySubscription } from '../../entity/DsGameLobbySubscription';
import { CommandoMessage, FriendlyError, ArgumentType, Argument } from 'discord.js-commando';
import { stripIndents } from 'common-tags';
import { GameRegion } from '../../common';


interface SubscriptionArgs {
    targetChannel?: TextChannel | DMChannel;
    mapName: string;
    isMapNameExact: boolean;
    region: keyof typeof GameRegion;
    variant: string | null;
    timeDelay: number;
    humanSlotsMin: number;
    showLeavers: boolean;
    deleteMessageStarted: boolean;
    deleteMessageAbandoned: boolean;
}

class SubscriptionArgument extends ArgumentType {
    constructor(client: DsBot) {
        super(client, 'sub_lobby');
    }

    protected getChannelSubscription(channel: TextChannel | DMChannel | NewsChannel, id: number) {
        const sub = (this.client as DsBot).tasks.lreporter.trackRules.get(id);
        if (!sub) {
            return;
        }

        if (channel instanceof DMChannel) {
            if (String(sub.userId) !== channel.recipient.id) {
                return;
            }
        }
        else {
            if (String(sub.guildId) !== channel.guild.id) {
                return;
            }
        }

        return sub;
    }

    parse(val: string, msg: CommandoMessage, arg: Argument) {
        return this.getChannelSubscription(msg.channel, Number(val));
    }

    validate(val: string, msg: CommandoMessage, arg: Argument) {
        if (typeof this.getChannelSubscription(msg.channel, Number(val)) === 'undefined') {
            return 'Incorrect ID of a subscription';
        }
        return true;
    }
}

abstract class AbstractSubscriptionCommand extends GeneralCommand {
    get lreporter() {
        return this.client.tasks.lreporter;
    }

    getChannelSubscription(channel: Channel, id: number) {
        const sub = this.lreporter.trackRules.get(id);
        if (!sub) {
            return;
        }

        if (channel instanceof TextChannel) {
            if (String(sub.guildId) !== channel.guild.id) {
                return;
            }
        }
        else if (channel instanceof DMChannel) {
            if (String(sub.userId) !== channel.recipient.id) {
                return;
            }
        }
        else {
            throw new FriendlyError(`Unsupported channel type: ${channel.type}`);
        }

        return sub;
    }
}

class SubscriptionNewCommand extends AbstractSubscriptionCommand {
    constructor(client: DsBot, info: ExtendedCommandInfo) {
        info = Object.assign(<ExtendedCommandInfo>{
            name: 'sub.new',
            description: 'Create new subscription for game lobby.',
            details: 'https://i.imgur.com/yVjsHOF.png',
            guildOnly: true,
            group: 'subscription',
            userPermissions: ['MANAGE_GUILD'],
            args: [
                {
                    key: 'mapName',
                    type: 'string',
                    prompt: 'Provide full name of the map or an extension mod',
                    min: 3,
                    max: 64,
                },
                {
                    key: 'targetChannel',
                    type: 'channel',
                    prompt: 'Specify a text channel where the reported lobbies should be posted',
                    default: (msg: CommandoMessage, cmd: this) => {
                        return msg.channel;
                    },
                },
                {
                    key: 'region',
                    type: 'string',
                    prompt: 'Designate game region [`US` | `EU` | `KR`] or use [`ANY`]',
                    validate: (val: string): boolean => {
                        val = val.toUpperCase();
                        if (val === 'ANY') return true;
                        // if (val === 'CN') return false;
                        if (GameRegion[val as any]) return true;
                        return false;
                    },
                    parse: (val: string): keyof typeof GameRegion => {
                        val = val.toUpperCase();
                        if (val === 'ANY') return void 0;
                        return val as keyof typeof GameRegion;
                    },
                    default: 'ANY',
                },
            ],
        }, info);
        if (info.dmOnly) {
            info.args = info.args.filter(x => x.key !== 'targetChannel');
        }
        super(client, info);
    }

    public async exec(msg: CommandoMessage, args: SubscriptionArgs) {
        const sub = new DsGameLobbySubscription();
        if (msg.channel instanceof TextChannel && args.targetChannel instanceof TextChannel) {
            if (
                !args.targetChannel.permissionsFor(this.client.user).has('VIEW_CHANNEL') ||
                !args.targetChannel.permissionsFor(this.client.user).has('SEND_MESSAGES') ||
                !args.targetChannel.permissionsFor(this.client.user).has('EMBED_LINKS')
            ) {
                return msg.reply(stripIndents`
                    Error: The bot is not allowed to view/send/embed messages in <#${args.targetChannel}>. Correct its permissions in order to continue.
                `);
            }

            sub.guildId = msg.channel.guild.id;
            if (args.targetChannel) {
                sub.channelId = args.targetChannel.id;
            }
            else {
                sub.channelId = msg.channel.id;
            }
        }
        else if (msg.channel instanceof DMChannel) {
            const chan = msg.channel;
            sub.userId = chan.recipient.id;
        }
        else {
            throw new FriendlyError('Unsupported channel type');
        }

        const limits = this.lreporter.getPostingLimits(sub);
        const allTargetSubs = Array.from(this.lreporter.trackRules.values()).filter(x => x.targetId === sub.targetId);
        if (allTargetSubs.length >= limits.subLimit) {
            return msg.reply(`You've reached maximum number of subscriptions of ${limits.subLimit} for this channel/server.`);
        }

        if (this.client.isStaff(msg.author) && args.mapName.length >= 3 && args.mapName.startsWith('/') && args.mapName.endsWith('/')) {
            sub.mapName = args.mapName.substring(1, args.mapName.length - 1);
            sub.isMapNameRegex = true;
            try {
                new RegExp(sub.mapName);
            }
            catch (e) {
                return msg.reply(`Invalid regex: ${e}`);
            }
        }
        else {
            sub.mapName = args.mapName;
        }
        if (args.region) {
            sub.regionId = GameRegion[args.region];
        }
        else {
            sub.regionId = null;
        }
        await this.client.conn.getRepository(DsGameLobbySubscription).save(sub);
        this.lreporter.trackRules.set(sub.id, sub);
        this.lreporter.testSubscription(sub);

        return msg.reply(stripIndents`
            Success! Subscription has been setup, assigned ID: \`${sub.id}\`.
            From now on you'll be reported about game lobbies which match the configuration.
            To customize its parameters use \`.sub.config ${sub.id}\`.
        `);
    }
}

class SubscriptionNewDmCommand extends SubscriptionNewCommand {
    constructor(client: DsBot) {
        const info: ExtendedCommandInfo = {
            name: 'sub.new.dm',
            guildOnly: false,
            dmOnly: true,
        };
        super(client, info);
        this.description += ' (via DM)';
    }
}

class SubscriptionConfigCommand extends AbstractSubscriptionCommand {
    constructor(client: DsBot) {
        super(client, {
            name: 'sub.config',
            description: 'Configure existing subscription.',
            group: 'subscription',
            userPermissions: ['MANAGE_GUILD'],
            args: [
                {
                    key: 'sub',
                    type: 'sub_lobby',
                    prompt: 'Provie identifier of a subscription',
                },
                {
                    key: 'isMapNameExact',
                    type: 'boolean',
                    prompt: 'Should match map name exactly? [`YES`] | Or containing substring? [`NO`]',
                },
                {
                    key: 'region',
                    type: 'string',
                    prompt: 'Designate game region [`US` | `EU` | `KR`] or use [`ANY`]',
                    validate: (val: string): boolean => {
                        val = val.toUpperCase();
                        if (val === 'ANY') return true;
                        // if (val === 'CN') return false;
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
                    prompt: 'Name of game variant [`ANY` to ignore this requirement]',
                    max: 64,
                    parse: (val: string) => {
                        if (val.trim().toUpperCase() === 'ANY') {
                            return null;
                        }
                        return val;
                    },
                },
                {
                    key: 'deleteMessageStarted',
                    type: 'boolean',
                    prompt: 'Should the message be deleted once game has started? [`YES` | `NO`]',
                },
                {
                    key: 'deleteMessageAbandoned',
                    type: 'boolean',
                    prompt: 'Should the message be deleted if lobby is abandoned? [`YES` | `NO`]',
                },
                {
                    key: 'showLeavers',
                    type: 'boolean',
                    prompt: 'Show complete list of players who left the lobby in addition to active ones? [`YES` | `NO`]',
                    default: false,
                },
                {
                    key: 'timeDelay',
                    type: 'integer',
                    prompt: 'For how long should game lobby be open before posting (in seconds)?',
                    min: 0,
                    max: 3600,
                    default: 0,
                },
                {
                    key: 'humanSlotsMin',
                    type: 'integer',
                    prompt: 'How many players must join the lobby before posting?',
                    min: 0,
                    max: 16,
                    default: 0,
                },
            ],
        });
    }

    public async exec(msg: CommandoMessage, args: { sub: DsGameLobbySubscription } & SubscriptionArgs) {
        const sub = args.sub;

        sub.isMapNamePartial = !args.isMapNameExact;
        if (args.region) {
            sub.regionId = GameRegion[args.region];
        }
        else {
            sub.regionId = null;
        }
        sub.variant = args.variant;
        sub.timeDelay = args.timeDelay;
        sub.humanSlotsMin = args.humanSlotsMin;
        sub.showLeavers = args.showLeavers;
        sub.deleteMessageStarted = args.deleteMessageStarted;
        sub.deleteMessageAbandoned = args.deleteMessageAbandoned;
        await this.client.conn.getRepository(DsGameLobbySubscription).save(sub);
        this.lreporter.trackRules.set(sub.id, sub);

        return msg.reply('Subscription reconfigured. You can use `.sub.list` to verify its parameters.');
    }
}

class SubscriptionDeleteCommand extends AbstractSubscriptionCommand {
    constructor(client: DsBot) {
        super(client, {
            name: 'sub.delete',
            aliases: ['sub.del'],
            description: 'Remove existing subscription.',
            group: 'subscription',
            userPermissions: ['MANAGE_GUILD'],
            args: [
                {
                    key: 'sub',
                    type: 'sub_lobby',
                    prompt: 'Provie identifier of a subscription',
                }
            ],
            argsPromptLimit: 0,
        });
    }

    public async exec(msg: CommandoMessage, args: { sub: DsGameLobbySubscription }) {
        await this.lreporter.removeSubscription(args.sub);
        return msg.reply('Subscription removed.');
    }
}

class SubscriptionDetailsCommand extends AbstractSubscriptionCommand {
    constructor(client: DsBot) {
        super(client, {
            name: 'sub.details',
            description: 'Shows details about subscription with a given ID',
            group: 'subscription',
            userPermissions: ['MANAGE_GUILD'],
            args: [
                {
                    key: 'sub',
                    type: 'sub_lobby',
                    prompt: 'Provie identifier of a subscription',
                }
            ],
            argsPromptLimit: 0,
        });
    }

    public async exec(msg: CommandoMessage, args: { sub: DsGameLobbySubscription }) {
        const sub = args.sub;
        return msg.reply({
            embed: {
                title: `Subscription ID: **${sub.id}**`,
                fields: [
                    {
                        name: 'Channel',
                        value: `<#${sub.channelId}>`,
                    },
                    {
                        name: 'Name of the map/mod',
                        value: sub.mapName,
                    },
                    {
                        name: 'Partial match of the name',
                        value: sub.isMapNamePartial,
                    },
                    {
                        name: 'Region',
                        value: sub.regionId === null ? 'ANY' : GameRegion[sub.regionId],
                    },
                    {
                        name: 'Map variant',
                        value: sub?.variant ?? 'ANY',
                    },
                    {
                        name: 'Delay before posting (in seconds)',
                        value: Number(sub.timeDelay),
                    },
                    {
                        name: 'Minimum number of human slots',
                        value: Number(sub.humanSlotsMin),
                    },
                    {
                        name: 'Show players who left the lobby',
                        value: sub.showLeavers,
                    },
                    {
                        name: 'Delete message after start',
                        value: sub.deleteMessageStarted,
                    },
                    {
                        name: 'Delete message if abandoned',
                        value: sub.deleteMessageAbandoned,
                    },
                ],
            } as MessageEmbedOptions
        });
    }
}

class SubscriptionListCommand extends AbstractSubscriptionCommand {
    constructor(client: DsBot) {
        super(client, {
            name: 'sub.list',
            description: 'List your existing subscriptions.',
            details: `Notice: If your subscriptions disappear shortly after initial setup, it likely means bot doesn't have the permissions to send messages in the specified channel.`,
            group: 'subscription',
            userPermissions: ['MANAGE_GUILD'],
        });
    }

    public async exec(msg: CommandoMessage) {
        let subs: DsGameLobbySubscription[] = [];

        if (msg.channel instanceof DMChannel) {
            const chan = msg.channel;
            subs = Array.from(this.lreporter.trackRules.values()).filter(x => {
                return String(x.userId) === chan.recipient.id;
            });
        }
        else {
            const chan = msg.channel;
            subs = Array.from(this.lreporter.trackRules.values()).filter(x => {
                return String(x.guildId) === chan.guild.id;
            });
        }

        if (!subs.length) {
            return msg.reply(`You've no active subscriptions.`);
        }

        const out: string[] = [];

        for (const cs of subs) {
            out.push(`#\`${cs.id}\` <#${cs.channelId}> ${cs.mapName} \`${cs.regionId === null ? 'GLOBAL' : GameRegion[cs.regionId]}\``);
        }

        return msg.reply(`Active subscriptions:\n${out.join('\n')}`);
    }
}

class SubscriptionStatusCommand extends AbstractSubscriptionCommand {
    constructor(client: DsBot) {
        super(client, {
            name: 'sub.status',
            description: 'Display status',
            group: 'subscription',
            userPermissions: ['MANAGE_GUILD'],
            argsType: 'single',
        });
    }

    public async exec(msg: CommandoMessage, args: string) {
        let targetId: string = msg.channel instanceof DMChannel ? msg.channel.recipient.id : msg.channel.guild.id;
        let targetDesc: { guildId?: string, userId?: string };
        if (this.client.isStaff(msg.author)) {
            if (args === 'all') {
                const out: string[] = [];

                out.push(csvCombineRow(
                    'ID',
                    'G/U',
                    'Name',
                    'Lobby publish requests (5m)',
                    'Lobby content requests (5m)',
                    'Active subscriptions',
                ));

                for (const targetId of Array.from(this.lreporter.actionCountersLastFiveMin).sort((a, b) => b[1] - a[1]).map(x => x[0])) {
                    const subs = Array.from(this.lreporter.trackRules.values()).filter(x => x.targetId === targetId);
                    const isGuild = this.client.guilds.cache.has(targetId);
                    out.push(csvCombineRow(
                        targetId,
                        isGuild ? 'Guild' : 'User',
                        isGuild ? this.client.guilds.cache.get(targetId)?.name : this.client.users.cache.get(targetId)?.username,
                        (this.lreporter.postCountersLastFiveMin.get(targetId) ?? 0).toFixed(3),
                        (this.lreporter.actionCountersLastFiveMin.get(targetId) ?? 0).toFixed(3),
                        subs.reduce<number>((x) => x + 1, 0),
                    ));
                }

                return msg.reply('', {
                    files: [
                        {
                            name: `aw-stats-${Date.now()}.csv`,
                            attachment: Buffer.from(out.join('\n')),
                        }
                    ]
                });
            }
            else if (args.trim().match(/^\d+$/)) {
                targetId = args.trim();
                if (this.client.guilds.cache.has(targetId)) {
                    targetDesc = {
                        guildId: targetId,
                    };
                }
                else if (this.client.users.cache.has(targetId)) {
                    targetDesc = {
                        userId: targetId,
                    };
                }
                else {
                    try {
                        targetDesc = {
                            userId: (await this.client.users.fetch(targetId)).id,
                        };
                    }
                    catch (err) {
                        if (err instanceof DiscordAPIError && err.code === DiscordErrorCode.UnknownUser) {
                            return msg.reply(`${err.message}`);
                        }
                        else {
                            throw err;
                        }
                    }
                }
            }
            else {
                return msg.reply({
                    content: `Unknown argument: "${Util.escapeMarkdown(args)}"\nExpected "all" or valid guild/user ID.`,
                    disableMentions: 'all',
                });
            }
        }
        else {
            targetDesc = msg.channel instanceof DMChannel ? { userId: msg.channel.recipient.id } : { guildId: msg.channel.guild.id };
        }

        const subs = Array.from(this.lreporter.trackRules.values()).filter(x => x.targetId === targetId);
        const limits = this.lreporter.getPostingLimits(targetDesc);

        const postedMsgsTotal = Array.from(this.lreporter.trackedLobbies.values())
            .map(x => Array.from(x.postedMessages.values()))
            .flat(1)
        ;
        const postedMsgsCurrent = postedMsgsTotal.filter(x => x.msg.targetId === targetId);

        const scheduledLobbiesTotal = Array.from(this.lreporter.trackedLobbies.values())
            .map(x => Array.from(x.candidates.values()))
            .flat(1)
        ;
        const scheduledLobbiesCurrent = scheduledLobbiesTotal.filter(x => x.targetId === targetId);

        return msg.reply({
            content: stripIndents`
            // ${this.lreporter.getPostingTargetName(targetDesc)}
             - Active lobby messages       : ${postedMsgsCurrent.length}
             - Scheduled lobby posts       : ${scheduledLobbiesCurrent.length}
             - Active subscriptions        : ${subs.length}
             -                  limited to : ~${limits.subLimit}
             - Lobby publish requests (5m) : ${(this.lreporter.postCountersLastFiveMin.get(targetId) ?? 0).toFixed(3)}
             -                  limited to : ~${limits.postLimit * 5}
             - Lobby content requests (5m) : ${(this.lreporter.actionCountersLastFiveMin.get(targetId) ?? 0).toFixed(3)}
             -                  limited to : ~${limits.actionLimit * 5}

            // GLOBAL
             - Active lobby messages       : ${postedMsgsTotal.length}
             - Scheduled lobby posts       : ${scheduledLobbiesTotal.length}
             - Active subscriptions        : ${this.lreporter.trackRules.size}
             - Lobby publish requests (5m) : ${Array.from(this.lreporter.postCountersLastFiveMin.values()).reduce((prev, curr) => prev + curr, 0).toFixed(3)}
             - Lobby content requests (5m) : ${Array.from(this.lreporter.actionCountersLastFiveMin.values()).reduce((prev, curr) => prev + curr, 0).toFixed(3)}
             - Tracked lobbies total       : ${this.lreporter.trackedLobbies.size}
             - DAPI queue size             : ${this.lreporter.postingQueue.size}
            `,
            code: 'ts',
        });
    }
}

class SubscriptionReloadCommand extends AbstractSubscriptionCommand {
    constructor(client: DsBot) {
        super(client, {
            name: 'sub.reload',
            group: 'admin',
            description: 'Reload subscriptions list from database',
            staffOnly: true,
        });
    }

    public async exec(msg: CommandoMessage) {
        await this.lreporter.reloadSubscriptions();
        return msg.reply(`Done. Active subscriptions count: ${this.lreporter.trackRules.size}.`);
    }
}

class SubscriptionRestoreCommand extends AbstractSubscriptionCommand {
    constructor(client: DsBot) {
        super(client, {
            name: 'sub.restore',
            group: 'admin',
            description: 'Restore deleted subscription',
            staffOnly: true,
            args: [
                {
                    key: 'id',
                    type: 'integer',
                    prompt: 'Provie identifier of subscription',
                },
            ],
        });
    }

    public async exec(msg: CommandoMessage, args: { id: number }) {
        if (this.lreporter.trackRules.has(args.id)) {
            return msg.reply('That subscription is already active.');
        }
        const sub = await this.client.conn.getRepository(DsGameLobbySubscription).findOne(args.id);
        if (!sub) {
            return msg.reply('Invalid ID.');
        }
        sub.deletedAt = null;
        this.lreporter.trackRules.set(sub.id, sub);
        await this.client.conn.getRepository(DsGameLobbySubscription).save(sub);
        return msg.reply(`Subscription \`${sub.id}\` restored.`);
    }
}

export class SubscriptionsTask extends BotTask {
    async load() {
        this.client.registry.registerTypes([
            SubscriptionArgument,
        ]);

        this.client.registry.registerCommands([
            SubscriptionNewCommand,
            SubscriptionNewDmCommand,
            SubscriptionConfigCommand,
            SubscriptionDeleteCommand,
            SubscriptionDetailsCommand,
            SubscriptionListCommand,
            SubscriptionStatusCommand,
            SubscriptionReloadCommand,
            SubscriptionRestoreCommand,
        ]);
    }
}
