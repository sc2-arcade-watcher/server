import { DsBot } from '../../bin/dsbot';
import { GeneralCommand } from '../dscommon';
import { CommandMessage } from 'discord.js-commando';
import { S2GameLobbyRepository } from '../../repository/S2GameLobbyRepository';
import { TextChannel } from 'discord.js';

export class LobbyPublishCommand extends GeneralCommand {
    constructor(client: DsBot) {
        super(client, {
            name: 'lobby',
            description: '',
            guildOnly: true,
        });
    }

    public async exec(msg: CommandMessage) {
        // const lobby = await this.conn.getCustomRepository(S2GameLobbyRepository).findOne(4720294);
        const trackedLobby = Array.from(this.tasks.lreporter.trackedLobbies.values())[0];
        await this.tasks.lreporter.postTrackedLobby(msg.channel as TextChannel, trackedLobby);
        return msg.reply(`ok`);
    }
}
