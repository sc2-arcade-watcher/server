import { Entity, Column, Index, PrimaryGeneratedColumn, OneToMany } from 'typeorm';
import { S2MapReviewRevision } from './S2MapReviewRevision';
import { S2Profile } from './S2Profile';

@Entity({
    engine: 'ROCKSDB',
})
@Index('author_region_map_idx', ['authorLocalProfileId', 'regionId', 'mapId'], { unique: true })
@Index('map_region_date_idx', ['mapId', 'regionId', 'updatedAt'])
@Index('map_region_rating_idx', ['mapId', 'regionId', 'rating'])
@Index('map_region_helpful_idx', ['mapId', 'regionId', 'helpfulCount'])
export class S2MapReview {
    @PrimaryGeneratedColumn({
        unsigned: true,
    })
    id: number;

    @Column({
        type: 'tinyint',
        unsigned: true,
    })
    regionId: number;

    @Column({
        type: 'int',
        unsigned: true,
    })
    authorLocalProfileId: number;

    @Column({
        type: 'mediumint',
        unsigned: true,
    })
    mapId: number;

    @Column({
        precision: 0,
    })
    createdAt: Date;

    @Column({
        precision: 0,
    })
    updatedAt: Date;

    @Column({
        type: 'tinyint',
        unsigned: true,
    })
    rating: number;

    @Column({
        type: 'mediumint',
        unsigned: true,
    })
    helpfulCount: number;

    @Column({
        type: 'text',
        nullable: true,
    })
    body: string;

    @OneToMany(type => S2MapReviewRevision, x => x.review, {
        persistence: false,
        cascade: false,
    })
    revisions: S2MapReviewRevision[];

    author?: S2Profile;
}
