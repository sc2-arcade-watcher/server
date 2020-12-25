import { Entity, Column, Unique, Index } from 'typeorm';
import { PlayerProfileParams } from '../bnet/common';
import { localProfileId } from '../common';

@Entity({
    engine: 'ROCKSDB',
})
export class S2ProfileBattleTracking {
    @Column({
        primary: true,
        type: 'int',
        unsigned: true,
    })
    localProfileId: number;

    @Column({
        primary: true,
        type: 'tinyint',
        unsigned: true,
    })
    regionId: number;

    @Column({
        nullable: true,
    })
    profileInfoUpdatedAt: Date | null;

    @Column({
        nullable: true,
    })
    matchHistoryUpdatedAt: Date | null;

    @Column({
        nullable: true,
    })
    matchHistoryIntegritySince: Date | null;

    @Column({
        type: 'tinyint',
        unsigned: true,
        default: 0,
    })
    battleAPIErrorCounter: number;

    @Column({
        nullable: true,
    })
    battleAPIErrorLast: Date | null;

    @Column({
        nullable: true,
    })
    publicGatewaySince: Date | null;

    static create(params: PlayerProfileParams) {
        const obj = new S2ProfileBattleTracking();

        obj.regionId = params.regionId;
        obj.localProfileId = localProfileId(params);

        obj.profileInfoUpdatedAt = null;
        obj.matchHistoryUpdatedAt = null;
        obj.matchHistoryIntegritySince = null;

        obj.battleAPIErrorCounter = 0;
        obj.battleAPIErrorLast = null;

        obj.publicGatewaySince = null;

        return obj;
    }
}
