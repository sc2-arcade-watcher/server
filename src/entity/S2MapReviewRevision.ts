import { Entity, Column, Index, PrimaryGeneratedColumn, ManyToOne } from 'typeorm';
import { S2MapReview } from './S2MapReview';

@Entity({
    engine: 'ROCKSDB',
})
export class S2MapReviewRevision {
    @ManyToOne(type => S2MapReview, x => x.revisions, {
        primary: true,
        nullable: false,
        // foreign keys not supported on RocksDB
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
    })
    @Index('review_idx')
    review: S2MapReview;

    @Column({
        primary: true,
        type: 'int',
        unsigned: true,
    })
    reviewId: number;

    @Column({
        primary: true,
        nullable: false,
        precision: 0,
    })
    date: Date;

    @Column({
        type: 'tinyint',
        unsigned: true,
    })
    rating: number;

    @Column({
        type: 'text',
        nullable: true,
    })
    body: string;
}
