import { Command, CommandoClient, CommandMessage } from 'discord.js-commando';
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
            group: 'general',
            description: 'Displays a list of available commands, or detailed information for a specified command.',
            details: oneLine`
                The command may be part of a command name or a whole command name.
                If it isn't specified, all available commands will be listed.
            `,
            examples: ['help', 'help sub.new', 'help lobby'],
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

    public async exec(msg: CommandMessage, args: HelpArgs): Promise<Message | Message[]> {
        const groups = this.client.registry.groups;
        const commands = this.client.registry.findCommands(args.command, false, msg.message);
        const messages: Message[] = [];

        try {
            if (args.command) {
                if (commands.length === 1) {
                    let help = stripIndents`
                        ${oneLine`
                            __Command **${commands[0].name}** — __ ${commands[0].description}
                            ${commands[0].guildOnly ? ' (Usable only in servers)' : ''}
                        `}

                        **Format:** ${msg.anyUsage(`${commands[0].name}${commands[0].format ? ` ${commands[0].format}` : ''}`)}
                    `;
                    if (commands[0].aliases.length > 0) help += `\n**Aliases:** ${commands[0].aliases.join(', ')}`;
                    if (commands[0].details) help += `\n**Details:** ${commands[0].details}`;
                    if (commands[0].examples) help += `\n**Examples:**\n${commands[0].examples.join('\n')}`;
                    messages.push(<Message>await msg.direct(help));
                } else if (commands.length > 1) {
                    messages.push(<Message>await msg.direct(disambiguation(commands, 'commands')));
                } else {
                    messages.push(<Message>await msg.direct(`Unable to identify command.`));
                }
            }
            else {
                messages.push(<Message>await msg.direct(stripIndents`
                    Website: <https://sc2arcade.talv.space>
                    Support: <https://discord.gg/VxAJYjF> (SC2Mapster server, \`#arcade-watcher\` channel)
                    Issue tracker: <${this.client.issueTracker}>

                    Use ${this.usage('<command>', null, null)} to view detailed information about a specific command.

                    ${groups.filter(grp => grp.id !== 'admin' && grp.commands.size > 0)
                        .map(grp => stripIndents`
                            __${grp.name}__
                            ${(grp.commands).map(cmd => `**${cmd.name}** — ${cmd.description}`).join('\n')}
                        `).join('\n\n')
                    }
                `, { split: true }));
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
