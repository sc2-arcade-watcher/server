import { Entity, PrimaryGeneratedColumn, Column, Unique } from 'typeorm';

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
    profileInfoUpdatedAt: Date;

    @Column({
        nullable: true,
    })
    matchHistoryUpdatedAt: Date;
}
