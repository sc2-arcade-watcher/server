import { EntityRepository, Repository, SelectQueryBuilder } from 'typeorm';
import { S2GameLobby } from '../entity/S2GameLobby';
import { S2Map } from '../entity/S2Map';
import { S2ProfileMatch } from '../entity/S2ProfileMatch';
import { S2LobbyMatchProfile } from '../entity/S2LobbyMatchProfile';
import { S2Profile } from '../entity/S2Profile';

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
                'map.mainCategoryId',
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
        ;
        return qb;
    }

    addSlotsProfile(qb: SelectQueryBuilder<S2GameLobby>) {
        qb
            .leftJoin('slot.profile', 'profile')
            .addSelect([
                'profile.regionId',
                'profile.realmId',
                'profile.profileId',
                'profile.name',
                'profile.discriminator',
                'profile.avatar',
            ])
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
        ;
        return qb;
    }

    addTitleHistory(qb: SelectQueryBuilder<S2GameLobby>) {
        qb
            .leftJoin('lobby.titleHistory', 'titleHistory')
            .leftJoin('titleHistory.profile', 'titleHistoryProfile')
            .addSelect([
                'titleHistory.date',
                'titleHistory.title',
                'titleHistory.hostName',
                'titleHistoryProfile.regionId',
                'titleHistoryProfile.realmId',
                'titleHistoryProfile.profileId',
                'titleHistoryProfile.name',
                'titleHistoryProfile.discriminator',
            ])
            .addOrderBy('titleHistory.date', 'ASC')
        ;
        return qb;
    }

    addMatchResult(qb: SelectQueryBuilder<S2GameLobby>, opts?: { playerResults?: boolean; playerProfiles?: boolean; }) {
        qb
            .leftJoin('lobby.match', 'lobMatch')
            .addSelect([
                'lobMatch.result',
                'lobMatch.completedAt',
            ])
        ;
        if (opts?.playerResults || opts?.playerProfiles) {
            qb
                .leftJoin(
                    S2LobbyMatchProfile,
                    'lobMatchProf',
                    'lobMatch.lobbyId IS NOT NULL AND lobMatch.lobbyId = lobMatchProf.lobbyId AND lobMatch.result = 0'
                )
                // .leftJoinAndMapMany(
                //     'lobMatch.lobbyMatchProfiles',
                //     S2LobbyMatchProfile,
                //     'lobMatchProf', 'lobMatch.lobbyId IS NOT NULL AND lobMatch.lobbyId = lobMatchProf.lobbyId AND lobMatch.result = 0'
                // )
                .leftJoinAndMapMany('lobMatch.profileMatches', S2ProfileMatch, 'profMatch', 'profMatch.id = lobMatchProf.profileMatch')
            ;
            if (opts?.playerProfiles) {
                qb
                    .leftJoinAndMapOne(
                        'profMatch.profile',
                        S2Profile,
                        'pmProfile',
                        'pmProfile.regionId = profMatch.regionId AND pmProfile.localProfileId = profMatch.localProfileId'
                    )
                ;
            }
        }
        return qb;
    }
}
