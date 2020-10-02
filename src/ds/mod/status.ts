import { BotTask } from '../dscommon';
import { S2GameLobby } from '../../entity/S2GameLobby';
import { logger, logIt } from '../../logger';
import { sleep, sleepUnless } from '../../helpers';
import { GameLobbyStatus } from '../../gametracker';
import { S2GameLobbySlotKind } from '../../entity/S2GameLobbySlot';

export class StatusTask extends BotTask {
    readonly customMessage = String(process.env.DS_BOT_STATUS_MESSAGE).trim();

    async load() {
        setTimeout(this.update.bind(this), 500).unref();
    }

    async unload() {
    }

    protected async update() {
        this.running = true;
        while (await this.waitUntilReady()) {
            await this.showOpenLobbyCount();
            await sleepUnless(10000, () => !this.client.doShutdown);
            await this.showNumberOfRecentGames();
            await sleepUnless(10000, () => !this.client.doShutdown);

            if (this.customMessage.length) {
                await this.client.user.setActivity(this.customMessage, { type: 'PLAYING' });
                await sleepUnless(8000, () => !this.client.doShutdown);
            }
        }
        this.running = false;
    }

    @logIt()
    protected async showOpenLobbyCount() {
        await this.waitUntilReady();

        type rType = {
            lobbyCountUS: string;
            lobbyCountEU: string;
            lobbyCountKR: string;
            lobbyCountCN: string;
            playerCountUS: string;
            playerCountEU: string;
            playerCountKR: string;
            playerCountCN: string;
        };
        const result: rType = await this.conn.getRepository(S2GameLobby)
            .createQueryBuilder('lobby')
            .select([])
            .addSelect('SUM(CASE WHEN lobby.regionId = 1 THEN 1 ELSE 0 END)', 'lobbyCountUS')
            .addSelect('SUM(CASE WHEN lobby.regionId = 2 THEN 1 ELSE 0 END)', 'lobbyCountEU')
            .addSelect('SUM(CASE WHEN lobby.regionId = 3 THEN 1 ELSE 0 END)', 'lobbyCountKR')
            .addSelect('SUM(CASE WHEN lobby.regionId = 5 THEN 1 ELSE 0 END)', 'lobbyCountCN')
            .addSelect('SUM(CASE WHEN lobby.regionId = 1 THEN lobby.slotsHumansTaken ELSE 0 END)', 'playerCountUS')
            .addSelect('SUM(CASE WHEN lobby.regionId = 2 THEN lobby.slotsHumansTaken ELSE 0 END)', 'playerCountEU')
            .addSelect('SUM(CASE WHEN lobby.regionId = 3 THEN lobby.slotsHumansTaken ELSE 0 END)', 'playerCountKR')
            .addSelect('SUM(CASE WHEN lobby.regionId = 5 THEN lobby.slotsHumansTaken ELSE 0 END)', 'playerCountCN')
            .where('status = :status', { status: GameLobbyStatus.Open })
            .getRawOne()
        ;

        await this.client.user.setActivity([
            `Open lobbies:\n  US:${result.lobbyCountUS} EU:${result.lobbyCountEU} KR:${result.lobbyCountKR} CN:${result.lobbyCountCN}`,
            `Awaiting players:\n  US:${result.playerCountUS} EU:${result.playerCountEU} KR:${result.playerCountKR} CN:${result.playerCountCN}`,
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
            .leftJoin('lobby.slots', 'slot')
            .addSelect('COUNT(DISTINCT(lobby.id))', 'totalGames')
            .addSelect('COUNT(DISTINCT(slot.profile_id))', 'totalPlayers')
            .andWhere('status = :status', { status: GameLobbyStatus.Started })
            .andWhere('closed_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR)')
            .andWhere('slot.kind = :kind', { kind: S2GameLobbySlotKind.Human })
            .cache(60000)
            .getRawOne()
        ;

        await this.client.user.setActivity([
            `${result.totalGames} public games with ${result.totalPlayers}+ unique players, in last hour across all regions.`
        ].join(' | '), { type: 'WATCHING' });
    }
}
