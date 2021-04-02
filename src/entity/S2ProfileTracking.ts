import { Entity, Column } from 'typeorm';
import { PlayerProfileParams } from '../bnet/common';
import { localProfileId } from '../common';

@Entity({
    engine: 'ROCKSDB',
})
export class S2ProfileTracking {
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
    mapStatsUpdatedAt: Date | null;

    @Column({
        nullable: true,
    })
    nameUpdatedAt: Date | null;

    @Column({
        nullable: true,
    })
    battleTagUpdatedAt: Date | null;

    static create(params: PlayerProfileParams) {
        const obj = new S2ProfileTracking();

        obj.regionId = params.regionId;
        obj.localProfileId = localProfileId(params);

        obj.mapStatsUpdatedAt = null;
        obj.nameUpdatedAt = null;
        obj.battleTagUpdatedAt = null;

        return obj;
    }
}
