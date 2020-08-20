import { createHash } from 'crypto';
import * as orm from 'typeorm';
import { PermissionResolvable, Message, Util as DiscordUtil } from 'discord.js';
import { CommandoClient, Command, CommandInfo, CommandMessage, FriendlyError, ArgumentCollector } from 'discord.js-commando';
import { DsBot } from '../bin/dsbot';
import { logger } from '../logger';
import { sleep, sleepUnless } from '../helpers';
import { stripIndents } from 'common-tags';

export enum DiscordClientStatus {
    Ready        = 0,
    Connecting   = 1,
    Reconnecting = 2,
    Idle         = 3,
    Nearly       = 4,
    Disconnected = 5,
}

export enum DiscordErrorCode {
    UnknownAccount                                = 10001,
    UnknownApplication                            = 10002,
    UnknownChannel                                = 10003,
    UnknownGuild                                  = 10004,
    UnknownIntegration                            = 10005,
    UnknownInvite                                 = 10006,
    UnknownMember                                 = 10007,
    UnknownMessage                                = 10008,
    UnknownOverwrite                              = 10009,
    UnknownProvider                               = 10010,
    UnknownRole                                   = 10011,
    UnknownToken                                  = 10012,
    UnknownUser                                   = 10013,
    UnknownEmoji                                  = 10014,
    UnknownWebhook                                = 10015,
    BotsCannotUseThisEndpoint                     = 20001,
    OnlyBotsCanUseThisEndpoint                    = 20002,
    MaximumNumberOfGuildsReached                  = 30001,
    MaximumNumberOfFriendsReached                 = 30002,
    MaximumNumberOfPinsReached                    = 30003,
    MaximumNumberOfGuildRolesReached              = 30005,
    MaximumNumberOfReactionsReached               = 30010,
    MaximumNumberOfGuildChannelsReached           = 30013,
    MaximumNumberOfInvitesReached                 = 30016,
    Unauthorized                                  = 40001,
    TheUserIsBannedFromThisGuild                  = 40007,
    MissingAccess                                 = 50001,
    InvalidAccountType                            = 50002,
    CannotExecuteActionOnADmChannel               = 50003,
    WidgetDisabled                                = 50004,
    CannotEditAMessageAuthoredByAnotherUser       = 50005,
    CannotSendAnEmptyMessage                      = 50006,
    CannotSendMessagesToThisUser                  = 50007,
    CannotSendMessagesInAVoiceChannel             = 50008,
    ChannelVerificationLevelIsTooHigh             = 50009,
    OAuth2ApplicationDoesNotHaveABot              = 50010,
    OAuth2ApplicationLimitReached                 = 50011,
    InvalidOAuthState                             = 50012,
    MissingPermissions                            = 50013,
    InvalidAuthenticationToken                    = 50014,
    NoteIsTooLong                                 = 50015,
    ProvidedTooFewOrTooManyMessagesToDelete       = 50016,
    MessageCanOnlyBePinnedToTheChannelItWasSentIn = 50019,
    InviteCodeIsEitherInvalidOrTaken              = 50020,
    CannotExecuteActionOnASystemMessage           = 50021,
    InvalidOAuth2AccessToken                      = 50025,
    AMessageProvidedWasTooOldToBulkDelete         = 50034,
    InvalidFormBody                               = 50035,
    AnInviteWasAcceptedToAGuildTheBotIsNotIn      = 50036,
    InvalidApiVersion                             = 50041,
    ReactionBlocked                               = 90001,
    ResourceOverloaded                            = 130000,
}

export type ExtendedCommandInfo = Partial<CommandInfo> & {
    name: string;
    deleteOnUserCommandDelete?: boolean;
    dmOnly?: boolean;
    userPermissions?: PermissionResolvable[];
};

export abstract class GeneralCommand extends Command {
    public readonly client: DsBot;
    public readonly info: ExtendedCommandInfo;
    argsCollector?: ArgumentCollector;

    constructor(client: DsBot, info: ExtendedCommandInfo) {
        const tmpInfo = Object.assign(<ExtendedCommandInfo>{
            group: 'general',
            memberName: info.name,
            description: '',
            dmOnly: false,
            deleteOnUserCommandDelete: false,
        }, info);
        if (tmpInfo.args) {
            for (const arg of tmpInfo.args) {
                if (arg.wait === void 0) {
                    arg.wait = 60;
                }
            }
        }
        super(client, tmpInfo as CommandInfo);
        this.info = tmpInfo;
    }

    protected get conn() {
        return this.client.conn;
    }

    protected get tasks() {
        return this.client.tasks;
    }

    isUsable(msg?: Message) {
        if (msg && this.info.dmOnly && msg.channel.type !== 'dm') {
            return false;
        }
        return super.isUsable(msg);
    }

    async run(msg: CommandMessage, args: object | string | string[], fromPattern: boolean): Promise<Message | Message[]> {
        if (this.info.dmOnly && msg.channel.type !== 'dm') {
            throw new FriendlyError(`Given command \`${this.name}\` is meant to be used only in a DM channel.`);
        }

        try {
            return await this.exec(msg, args, fromPattern);
        }
        catch (err) {
            const reportId = createHash('sha1').update(JSON.stringify([err?.name, err?.message, Date.now()])).digest('hex');
            logger.error(`Failed to execute command. Report #${reportId}`, err, msg, args);

            return msg.reply(stripIndents`
                An error occurred while running the command.
                If the problem persists please report it on the issue tracker: <${this.client.issueTracker}>.
                Report ID: \`${reportId}\` (please include it, when reporting issue).
            `);
        }
    }

    public abstract async exec(message: CommandMessage, args: object | string | string[], fromPattern: boolean): Promise<Message | Message[]>;
}

export abstract class BotTask {
    readonly conn: orm.Connection;
    running = false;

    constructor(public readonly client: DsBot) {
        this.conn = this.client.conn;
    }

    protected async waitUntilReady() {
        if (this.client.doShutdown) return false;

        let prevStatus: DiscordClientStatus | null = null;
        while (this.client.status !== DiscordClientStatus.Ready) {
            if (prevStatus !== this.client.status) {
                logger.warn(`Task "${this.constructor.name}" cannot proceed, status: ${DiscordClientStatus[this.client.status]}`);
                prevStatus = this.client.status;
            }
            await sleepUnless(500, () => !this.client.doShutdown);
            if (this.client.doShutdown) {
                return false;
            }
        }
        if (prevStatus !== null) {
            logger.info(`Task "${this.constructor.name}" resumed.`);
        }

        return true;
    }

    async load() {}
    async unload() {}
}

export function formatObjectAsMessage(inp: {[k: string]: any}, escape: boolean = true) {
    const longestKey = Math.max(...Object.keys(inp).map(x => x.length));
    const out: string[] = [];
    for (const [key, val] of Object.entries(inp)) {
        let x: string = 'None';
        if (val === void 0 || val === null) {
        }
        else if (typeof val === 'object') {
            x = '?';
        }
        else {
            x = String(val);
        }
        // out.push(`${key.padStart(longestKey)} = ${x}`);
        if (escape) {
            out.push(`${key} = \`${x}\``);
        }
        else {
            out.push(`${key} = ${x}`);
        }
    }
    return out.join('\n');
}
