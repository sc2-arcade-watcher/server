import { EntityRepository, Repository, SelectQueryBuilder } from 'typeorm';
import { S2GameLobby } from '../entity/S2GameLobby';
import { GameLobbyStatus } from '../gametracker';
import { S2Map } from '../entity/S2Map';

@EntityRepository(S2GameLobby)
export class S2GameLobbyRepository extends Repository<S2GameLobby> {
    prepareDetailedSelect() {
        return this
            .createQueryBuilder('lobby')

            // map & ext mod
            .leftJoinAndMapOne('lobby.map', S2Map, 'map', 'map.regionId = lobby.regionId AND map.bnetId = lobby.mapBnetId')
            .leftJoinAndMapOne('lobby.extMod', S2Map, 'extMod', 'extMod.regionId = lobby.regionId AND extMod.bnetId = lobby.extModBnetId')

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

    addMapInfo(qb: SelectQueryBuilder<S2GameLobby>, resetSelect = false) {
        qb
            .leftJoinAndMapOne('lobby.map', S2Map, 'map', 'map.regionId = lobby.regionId AND map.bnetId = lobby.mapBnetId')
            .leftJoinAndMapOne('lobby.extMod', S2Map, 'extMod', 'extMod.regionId = lobby.regionId AND extMod.bnetId = lobby.extModBnetId')
            .leftJoinAndMapOne('lobby.multiMod', S2Map, 'multiMod', 'multiMod.regionId = lobby.regionId AND multiMod.bnetId = lobby.multiModBnetId')
            .select(resetSelect ? [] : void 0)
            .addSelect([
                'map.regionId',
                'map.bnetId',
                'map.name',
                'map.iconHash',
            ])
            .addSelect([
                'extMod.regionId',
                'extMod.bnetId',
                'extMod.name',
                'extMod.iconHash',
            ])
            .addSelect([
                'multiMod.regionId',
                'multiMod.bnetId',
                'multiMod.name',
                'multiMod.iconHash',
            ])
        ;
        return qb;
    }

    addSlots(qb: SelectQueryBuilder<S2GameLobby>) {
        qb
            .leftJoin('lobby.slots', 'slot')
            .addSelect([
                'slot.slotNumber',
                'slot.team',
                'slot.kind',
                'slot.name',
            ])
            .leftJoin('slot.profile', 'profile')
            .addSelect([
                'profile.regionId',
                'profile.realmId',
                'profile.profileId',
                'profile.name',
                'profile.discriminator',
            ])
            .addOrderBy('slot.slotNumber', 'ASC')
        ;
        return qb;
    }

    addSlotsJoinInfo(qb: SelectQueryBuilder<S2GameLobby>) {
        qb
            .leftJoin('slot.joinInfo', 'joinInfo')
            .addSelect([
                'joinInfo.joinedAt',
                'joinInfo.leftAt',
            ])
        ;
        return qb;
    }

    addJoinHistory(qb: SelectQueryBuilder<S2GameLobby>) {
        qb
            .leftJoin('lobby.joinHistory', 'joinHistory')
            .leftJoin('joinHistory.profile', 'joinHistoryProfile')
            .addSelect([
                'joinHistory.joinedAt',
                'joinHistory.leftAt',
                'joinHistoryProfile.regionId',
                'joinHistoryProfile.realmId',
                'joinHistoryProfile.profileId',
                'joinHistoryProfile.name',
                'joinHistoryProfile.discriminator',
            ])
            .addOrderBy('joinHistory.id', 'ASC')
        ;
        return qb;
    }

    createQueryForEntriesInIds(recordIds: number[], orderDirection: 'ASC' | 'DESC' = 'DESC') {
        const qb = this.createQueryBuilder('lobby')
            .select([])
        ;
        this.addMapInfo(qb, true);
        qb
            .addSelect([
                'lobby.id',
                'lobby.regionId',
                'lobby.bnetBucketId',
                'lobby.bnetRecordId',
                'lobby.mapBnetId',
                'lobby.extModBnetId',
                'lobby.multiModBnetId',
                'lobby.createdAt',
                'lobby.closedAt',
                'lobby.status',
                'lobby.mapVariantIndex',
                'lobby.mapVariantMode',
                'lobby.lobbyTitle',
                'lobby.hostName',
            ])
            .leftJoin('lobby.slots', 'slot')
            .addSelect([
                'slot.slotNumber',
                'slot.team',
                'slot.kind',
                'slot.name',
            ])
            // .leftJoin('slot.profile', 'profile')
            // .addSelect([
            //     'profile.regionId',
            //     'profile.realmId',
            //     'profile.profileId',
            //     'profile.name',
            //     'profile.discriminator',
            // ])
            .andWhereInIds(recordIds)
            .addOrderBy('lobby.id', orderDirection)
            .addOrderBy('slot.slotNumber', 'ASC')
        ;
        return qb;
    }
}
