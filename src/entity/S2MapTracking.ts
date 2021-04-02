import { Entity, Column, Index, Unique } from 'typeorm';

@Entity({
    engine: 'ROCKSDB',
})
export class S2MapTracking {
    @Column({
        type: 'mediumint',
        unsigned: true,
        primary: true,
    })
    mapId: number;

    @Column({
        type: 'tinyint',
        unsigned: true,
        primary: true,
    })
    regionId: number;

    @Column({
        nullable: true,
    })
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
        type: 'smallint',
        unsigned: true,
        default: 0,
    })
    @Index('unavailability_counter_idx')
    unavailabilityCounter: number;

    @Column({
        nullable: true,
    })
    @Index('reviews_updated_entirely_at_idx')
    reviewsUpdatedEntirelyAt: Date;

    @Column({
        nullable: true,
    })
    reviewsUpdatedPartiallyAt: Date;

    static create(params: { regionId: number, mapId: number }): S2MapTracking {
        return Object.assign(new S2MapTracking(), <S2MapTracking>{
            lastCheckedAt: null,
            lastSeenAvailableAt: null,
            firstSeenUnvailableAt: null,
            unavailabilityCounter: 0,
            reviewsUpdatedEntirelyAt: null,
            reviewsUpdatedPartiallyAt: null,
        }, params);
    }
}
