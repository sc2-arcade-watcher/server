import { Command, CommandoClient, CommandoMessage } from 'discord.js-commando';
import { Message, ReactionEmoji, DiscordAPIError } from 'discord.js';
import { oneLine, stripIndents } from 'common-tags';
import { GeneralCommand } from '../dscommon';
import { DsBot } from '../../bin/dsbot';

function disambiguation(items: any, label: any, property = 'name') {
    const itemList = items.map((item: any) => `"${(property ? item[property] : item).replace(/ /g, '\xa0')}"`).join(',   ');
    return `Multiple ${label} found, please be more specific: ${itemList}`;
}

export type HelpArgs = {
    command?: string;
};

export class HelpCommand extends GeneralCommand {
    constructor(client: DsBot) {
        super(client, {
            name: 'help',
            group: 'util',
            description: 'Displays a list of available commands, or detailed information for a specified command.',
            details: oneLine`
                The command may be part of a command name or a whole command name.
                If it isn't specified, all available commands will be listed.
            `,
            examples: ['.help', '.help sub.new', '.help lobby'],
            args: [
                {
                    key: 'command',
                    prompt: 'Which command would you like to view the help for?',
                    type: 'string',
                    default: ''
                }
            ]
        });
    }

    public async exec(msg: CommandoMessage, args: HelpArgs): Promise<Message | Message[]> {
        const groupEmojis = {
            'util': '\u{1F6E0}\u{FE0F}',
            'subscription': '\u{1F4F0}',
            'admin': '\u{1F9F0}',
        };
        const groups = this.client.registry.groups
            .filter(x => (x.id !== 'admin' || this.client.isStaff(msg.author)))
            .filter(x => x.commands.size > 0)
        ;

        if (args.command.startsWith(this.client.commandPrefix)) {
            args.command = args.command.substr(1);
        }
        const commands = this.client.registry.findCommands(args.command, false, msg);
        const messages: Message[] = [];

        try {
            if (args.command) {
                if (commands.length === 1) {
                    let help = stripIndents`
                        ➤ Command **${commands[0].name}** — ${commands[0].description}
                        ${oneLine`
                            ${commands[0].guildOnly ? ' - *(Usable only in servers)*' : ''}
                            ${(commands[0] as GeneralCommand)?.info.dmOnly ? ' - *(Usable only in DM)*' : ''}
                        `}
                        **Usage:**\n${msg.anyUsage(`${commands[0].name}${commands[0].format ? ` ${commands[0].format}` : ''}`, void 0, null)}
                    `;
                    if (commands[0].aliases.length > 0) help += `\n**Aliases:**\n${commands[0].aliases.join(', ')}`;
                    if (commands[0].details) help += `\n**Details:**\n${commands[0].details}`;
                    if (commands[0].examples) help += `\n**Examples:**\n${commands[0].examples.join('\n')}`;
                    messages.push(await msg.direct(help));
                }
                else if (commands.length > 1) {
                    messages.push(await msg.direct(disambiguation(commands, 'commands')));
                }
                else {
                    messages.push(await msg.direct(`Unable to identify command.`));
                }
            }
            else {
                const staffMembersList = (await this.client.fetchStaffMembers()).map(x => `<@${x.id}> \`${x.tag}\``);
                messages.push(...(await msg.direct(stripIndents`
                    **${'Read the guide to get introduced'.toUpperCase()}: __<https://sc2arcade.com/info/discord-bot>__**

                    ${groups.map(grp => stripIndents`
                        — ${groupEmojis[grp.id as keyof typeof groupEmojis] ?? '➤'}  __${grp.name.toUpperCase()}__\n
                        ${(grp.commands).map(cmd => `\`${this.client.commandPrefix}${cmd.name}\` — ${cmd.description}`).join('\n')}
                    `).join('\n\n')}

                    > Notice: You can use ${this.usage('<command>', null, null)} to view detailed information about a specific command. For instance \`.help sub.new\`.

                    — \u{1F5F3}\u{FE0F} __SUPPORT__\n
                    If you need further help with setting up the bot, you can reach us over at:
                    \`SC2Mapster\` server \`#arcade-watcher\` channel. Invitation link: <https://discord.gg/VxAJYjF>.
                    Support staff: ${staffMembersList.join(' | ')}
                `, { split: true, disableMentions: 'everyone' })));
                // \u{1F4E9}
            }

            if (msg.channel.type !== 'dm') {
                return msg.reply('Sent you a DM with information.');
            }
        } catch (err) {
            if (err instanceof DiscordAPIError) {
                return msg.reply('Unable to send you the help DM. You probably have DMs disabled.');
            }
            else {
                throw err;
            }
        }
    }
}
