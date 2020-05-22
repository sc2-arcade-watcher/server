import { DsBot } from '../../bin/dsbot';
import { GeneralCommand } from '../dscommon';
import { CommandMessage } from 'discord.js-commando';

export class InviteCommand extends GeneralCommand {
    constructor(client: DsBot) {
        super(client, {
            name: 'invite',
            description: 'Generate invite',
        });
    }

    public async exec(msg: CommandMessage) {
        return msg.reply(`<https://discordapp.com/oauth2/authorize?client_id=${this.client.user.id}&scope=bot&permissions=379968>`);
    }
}
