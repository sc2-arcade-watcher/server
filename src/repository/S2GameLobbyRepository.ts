import { EntityRepository, Repository } from 'typeorm';
import { S2GameLobby } from '../entity/S2GameLobby';
import { GameLobbyStatus } from '../gametracker';

@EntityRepository(S2GameLobby)
export class S2GameLobbyRepository extends Repository<S2GameLobby> {
    prepareDetailedSelect() {
        return this
            .createQueryBuilder('lobby')

            // region
            .innerJoinAndSelect('lobby.region', 'region')

            // map info
            .innerJoinAndSelect('lobby.mapDocumentVersion', 'mapDocVer')
            .innerJoinAndSelect('mapDocVer.document', 'mapDoc')

            // ext mod info
            .leftJoinAndSelect('lobby.extModDocumentVersion', 'extModDocVer')
            .leftJoinAndSelect('extModDocVer.document', 'extModDoc')

            // slots
            .leftJoinAndSelect('lobby.slots', 'slot')
            .leftJoinAndSelect('slot.profile', 'profile')
            .leftJoinAndSelect('slot.joinInfo', 'joinInfo')

            // joinInfos for leavers
            .leftJoinAndSelect('lobby.joinHistory', 'joinHistory')
            .leftJoinAndSelect('joinHistory.profile', 'joinHistoryProfile')

            .addOrderBy('lobby.createdAt', 'ASC')
            .addOrderBy('slot.slotNumber', 'ASC')
        ;
    }

    async getActive() {
        return this
            .prepareDetailedSelect()
            .andWhere('lobby.status = :status OR lobby.closedAt >= FROM_UNIXTIME(UNIX_TIMESTAMP()-20)', { status: GameLobbyStatus.Open })
            .getMany()
        ;
    }
}
