import { Entity, PrimaryGeneratedColumn, Column, Unique, Index } from 'typeorm';

@Entity()
@Unique('region_bnet_idx', ['regionId', 'realmId', 'profileId'])
export class S2ProfileTracking {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({
        type: 'tinyint',
        unsigned: true,
    })
    regionId: number;

    @Column({
        type: 'tinyint',
        unsigned: true,
    })
    realmId: number;

    @Column({
        unsigned: true,
    })
    profileId: number;

    @Column({
        nullable: true,
    })
    mapStatsUpdatedAt: Date | null;

    @Column({
        default: '1000-01-01 00:00:00',
    })
    nameUpdatedAt: Date;
}
