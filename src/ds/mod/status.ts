import { BotTask } from '../dscommon';
import { S2GameLobby } from '../../entity/S2GameLobby';
import { logger, logIt } from '../../logger';
import { sleep, sleepUnless } from '../../helpers';
import { GameLobbyStatus } from '../../gametracker';

export class StatusTask extends BotTask {
    async load() {
        setTimeout(this.update.bind(this), 500).unref();
    }

    async unload() {
    }

    @logIt()
    protected async update() {
        this.running = true;
        while (await this.waitUntilReady()) {
            for (let i = 0; i < 2 && !this.client.doShutdown; ++i) {
                await this.showOpenLobbyCount();
                await sleepUnless(10000, () => !this.client.doShutdown);
            }
            for (let i = 0; i < 1 && !this.client.doShutdown; ++i) {
                await this.showNumberOfRecentGames();
                await sleepUnless(20000, () => !this.client.doShutdown);
            }
        }
        this.running = false;
    }

    protected async showOpenLobbyCount() {
        await this.waitUntilReady();

        type rType = {
            lobbyCountUS: string;
            lobbyCountEU: string;
            lobbyCountKR: string;
            playerCountUS: string;
            playerCountEU: string;
            playerCountKR: string;
        };
        const result: rType = await this.conn.getRepository(S2GameLobby)
            .createQueryBuilder('lobby')
            .select([])
            .innerJoin('lobby.region', 'region')
            .addSelect('SUM(CASE WHEN region.code = \'US\' THEN 1 ELSE 0 END)', 'lobbyCountUS')
            .addSelect('SUM(CASE WHEN region.code = \'EU\' THEN 1 ELSE 0 END)', 'lobbyCountEU')
            .addSelect('SUM(CASE WHEN region.code = \'KR\' THEN 1 ELSE 0 END)', 'lobbyCountKR')
            .addSelect('SUM(CASE WHEN region.code = \'US\' THEN lobby.slotsHumansTaken ELSE 0 END)', 'playerCountUS')
            .addSelect('SUM(CASE WHEN region.code = \'EU\' THEN lobby.slotsHumansTaken ELSE 0 END)', 'playerCountEU')
            .addSelect('SUM(CASE WHEN region.code = \'KR\' THEN lobby.slotsHumansTaken ELSE 0 END)', 'playerCountKR')
            .where('status = :status', { status: GameLobbyStatus.Open })
            .getRawOne()
        ;

        await this.client.user.setActivity([
            `Open lobbies:\n  US:${result.lobbyCountUS} EU:${result.lobbyCountEU} KR:${result.lobbyCountKR}`,
            `Awaiting players:\n  US:${result.playerCountUS} EU:${result.playerCountEU} KR:${result.playerCountKR}`,
        ].join('\n'), { type: 'WATCHING' });
    }

    protected async showNumberOfRecentGames() {
        await this.waitUntilReady();

        type rType = {
            totalGames: string;
            totalPlayers: string;
        };
        const result: rType = await this.conn.getRepository(S2GameLobby)
            .createQueryBuilder('lobby')
            .select([])
            .leftJoin('lobby.players', 'player', 'player.lobby = lobby.id AND player.leftAt IS NULL')
            .addSelect('COUNT(DISTINCT(lobby.id))', 'totalGames')
            .addSelect('COUNT(DISTINCT(player.name))', 'totalPlayers')
            .andWhere('status = :status', { status: GameLobbyStatus.Started })
            .andWhere('created_at >= FROM_UNIXTIME(UNIX_TIMESTAMP()-3600*1)')
            .getRawOne()
        ;

        await this.client.user.setActivity([
            `${result.totalGames} public games with ${result.totalPlayers}+ unique players, in last hour across all regions.`
        ].join(' | '), { type: 'WATCHING' });
    }
}
