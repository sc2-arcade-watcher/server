import { DsBot } from '../../bin/dsbot';
import { GeneralCommand, csvCombineRow } from '../dscommon';
import { CommandoMessage } from 'discord.js-commando';

export class GuildsOverviewCommand extends GeneralCommand {
    constructor(client: DsBot) {
        super(client, {
            group: 'admin',
            name: 'a.guilds',
            description: 'Shows info about all connected guilds',
            staffOnly: true,
            dmOnly: true,
        });
    }

    public async exec(msg: CommandoMessage) {
        const guildsData: string[] = [];

        guildsData.push(csvCombineRow(
            'ID',
            'Name',
            'Region',
            'Joined at',
            'Channels',
            'Members',
            'Active subscriptions',
        ));

        for (const guild of this.client.guilds.cache.array().sort((a, b) => a.joinedTimestamp - b.joinedTimestamp).values()) {
            const subs = Array.from(this.client.tasks.lreporter.trackRules.values())
                .filter(x => String(x.guildId) === guild.id)
            ;
            guildsData.push(csvCombineRow(
                guild.id,
                guild.name,
                guild.region,
                guild.joinedAt,
                guild.channels.cache.size,
                guild.memberCount,
                subs.reduce<number>((x) => x + 1, 0),
            ));
        }

        return msg.reply('', {
            files: [
                {
                    name: `aw-guilds-${Date.now()}.csv`,
                    attachment: Buffer.from(guildsData.join('\n')),
                }
            ]
        });
    }
}
