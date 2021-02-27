import * as orm from 'typeorm';
import { User, TextChannel, RichEmbedOptions, DMChannel, GroupDMChannel } from 'discord.js';
import { DsBot } from '../../bin/dsbot';
import { BotTask, DiscordErrorCode, GeneralCommand, formatObjectAsMessage, ExtendedCommandInfo } from '../dscommon';
import { logger, logIt } from '../../logger';
import { DsGameLobbySubscription } from '../../entity/DsGameLobbySubscription';
import { CommandMessage, FriendlyError } from 'discord.js-commando';
import { S2Region } from '../../entity/S2Region';
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

abstract class AbstractSubscriptionCommand extends GeneralCommand {
    protected get lreporter() {
        return this.client.tasks.lreporter;
    }

    protected getChannelSubscription(channel: TextChannel | DMChannel | GroupDMChannel, id: number) {
        const sub = this.lreporter.trackRules.get(id);
        if (!sub) {
            return;
        }

        if (channel instanceof TextChannel) {
            const chan = channel;
            if (sub.guildId !== chan.guild.id) {
                return;
            }
        }
        else if (channel instanceof DMChannel) {
            const chan = channel;
            if (sub.userId !== chan.recipient.id) {
                return;
            }
        }
        else {
            throw new FriendlyError('Unsupported channel type');
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
            group: 'subscriptions',
            userPermissions: ['MANAGE_GUILD'],
            examples: [
                'sub.new "Ice Baneling Escape" #channel',
                'sub.new "Scion Custom Races (Mod)" #channel',
            ],
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
                },
            ],
        }, info);
        if (info.dmOnly) {
            info.args = info.args.filter(x => x.key !== 'targetChannel');
        }
        super(client, info);
    }

    public async exec(msg: CommandMessage, args: SubscriptionArgs) {
        const sub = new DsGameLobbySubscription();
        if (msg.channel instanceof TextChannel) {
            const chan = msg.channel;
            sub.guildId = chan.guild.id;
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

        sub.mapName = args.mapName;
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
            examples: [
                'sub.new.dm "Ice Baneling Escape"',
                'sub.new.dm "Scion Custom Races (Mod)"',
            ],
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
            group: 'subscriptions',
            userPermissions: ['MANAGE_GUILD'],
            args: [
                {
                    key: 'id',
                    type: 'integer',
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
                    prompt: 'Designate game region [`US` | `EU` | `KR` | `CN`] or use [`ANY`]',
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

    public async exec(msg: CommandMessage, args: { id: number } & SubscriptionArgs) {
        const sub = this.getChannelSubscription(msg.channel, args.id);
        if (!sub) {
            return msg.reply('Incorrect ID');
        }

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
            name: 'sub.del',
            description: 'Remove existing subscription.',
            group: 'subscriptions',
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
        const sub = this.getChannelSubscription(msg.channel, args.id);
        if (!sub) {
            return msg.reply('Incorrect ID');
        }
        this.lreporter.trackRules.delete(args.id);
        await this.client.conn.getRepository(DsGameLobbySubscription).update(args.id, { enabled: false });
        return msg.reply('Subscription removed.');
    }
}

class SubscriptionListCommand extends AbstractSubscriptionCommand {
    constructor(client: DsBot) {
        super(client, {
            name: 'sub.list',
            description: 'List your existing subscriptions.',
            details: `Notice: If your subscriptions disappear shortly after initial setup, it likely means bot doesn't have the permissions to send messages in the specified channel.`,
            group: 'subscriptions',
            userPermissions: ['MANAGE_GUILD'],
        });
    }

    public async exec(msg: CommandMessage) {
        let rules: DsGameLobbySubscription[] = [];

        if (msg.channel instanceof TextChannel) {
            const chan = msg.channel;
            rules = Array.from(this.lreporter.trackRules.values()).filter(x => {
                return x.guildId === chan.guild.id;
            });
        }
        else if (msg.channel instanceof DMChannel) {
            const chan = msg.channel;
            rules = Array.from(this.lreporter.trackRules.values()).filter(x => {
                return x.userId === chan.recipient.id;
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
                name: `Subscription ID: **${rsub.id}**`,
                value: [
                    formatObjectAsMessage({
                        'Channel': `<#${rsub.channelId}>`,
                    }, false),
                    formatObjectAsMessage({
                        'Name of the map/mod': rsub.mapName,
                        'Partial match of the name': rsub.isMapNamePartial,
                        'Region': rsub.regionId === null ? 'ANY' : GameRegion[rsub.regionId],
                        'Map variant': rsub?.variant ?? 'ANY',
                        'Delay before posting (in seconds)': Number(rsub.timeDelay),
                        'Minimum number of human slots': Number(rsub.humanSlotsMin),
                        'Show players who left the lobby': rsub.showLeavers,
                        'Delete message after start': rsub.deleteMessageStarted,
                        'Delete message if abandoned': rsub.deleteMessageAbandoned,
                    })
                ].join('\n'),
                inline: false,
            });
        }

        return msg.reply('', { embed: rembed});
    }
}

class SubscriptionReloadCommand extends AbstractSubscriptionCommand {
    constructor(client: DsBot) {
        super(client, {
            name: 'sub.reload',
            group: 'admin',
            ownerOnly: true,
        });
    }

    public async exec(msg: CommandMessage) {
        await this.lreporter.reloadSubscriptions();
        return msg.reply(`Done. Active subscriptions count: ${this.lreporter.trackRules.size}.`);
    }
}

export class SubscriptionsTask extends BotTask {
    async load() {
        this.client.registry.registerCommands([
            SubscriptionNewCommand,
            SubscriptionNewDmCommand,
            SubscriptionConfigCommand,
            SubscriptionDeleteCommand,
            SubscriptionListCommand,
            SubscriptionReloadCommand,
        ]);
    }
}
