import * as orm from 'typeorm';
import { User, TextChannel, RichEmbedOptions, DMChannel } from 'discord.js';
import { DsBot } from '../../bin/dsbot';
import { BotTask, DiscordErrorCode, GeneralCommand, formatObjectAsMessage, ExtendedCommandInfo } from '../dscommon';
import { GameRegion } from '../../gametracker';
import { logger, logIt } from '../../logger';
import { DsGameTrackRule } from '../../entity/DsGameTrackRule';
import { CommandMessage, FriendlyError } from 'discord.js-commando';
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

export class SubscriptionsTask extends BotTask {
    async load() {
        this.client.registry.registerCommands([
            NotificationNewCommand,
            NotificationNewDmCommand,
            NotificationDeleteCommand,
            NotificationListCommand,
            NotificationReloadCommand,
        ]);
    }
}
