import { DsBot } from '../../bin/dsbot';
import { GeneralCommand } from '../dscommon';
import { CommandoMessage } from 'discord.js-commando';

export class InviteCommand extends GeneralCommand {
    constructor(client: DsBot) {
        super(client, {
            name: 'invite',
            description: 'Generate an invitation link, allowing you to add the bot to the server.',
        });
    }

    public async exec(msg: CommandoMessage) {
        return msg.reply(`Use this link to install bot on the server you're owner of: <https://discord.com/oauth2/authorize?client_id=${this.client.user.id}&scope=bot&permissions=379968>`);
    }
}
