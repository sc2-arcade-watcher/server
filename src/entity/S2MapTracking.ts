import { Entity, PrimaryGeneratedColumn, Column, Index, Unique } from 'typeorm';

@Entity()
@Unique('region_bnet_idx', ['regionId', 'bnetId'])
export class S2MapTracking {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({
        type: 'tinyint',
        unsigned: true,
    })
    regionId: number;

    @Column({
        type: 'mediumint',
        unsigned: true,
    })
    bnetId: number;

    @Column()
    @Index('last_checked_at_idx')
    lastCheckedAt: Date;

    @Column({
        nullable: true,
    })
    lastSeenAvailableAt: Date;

    @Column({
        nullable: true,
    })
    firstSeenUnvailableAt: Date;

    @Column({
        default: 0,
    })
    unavailabilityCounter: number = 0;
}
