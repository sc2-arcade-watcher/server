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
        default: false,
    })
    preferPublicGateway: boolean;

    @Column({
        nullable: true,
    })
    mapStatsUpdatedAt: Date | null;
}
