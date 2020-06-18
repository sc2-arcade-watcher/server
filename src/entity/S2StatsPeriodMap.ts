import { Entity, PrimaryGeneratedColumn, Column, Index, Unique, ManyToOne, OneToMany } from 'typeorm';
import { S2Document } from './S2Document';
import { S2StatsPeriod } from './S2StatsPeriod';

@Entity()
// TODO: enable indexes
// @Unique('period_map_idx', ['period', 'document'])
export class S2StatsPeriodMap {
    @PrimaryGeneratedColumn()
    id: number;

    @ManyToOne(type => S2StatsPeriod, statPeriod => statPeriod.mapStats, {
        nullable: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @Index()
    period: S2StatsPeriod;

    @ManyToOne(type => S2Document, {
        nullable: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @Index()
    document: S2Document;

    @Column({
        default: 0,
        unsigned: true,
    })
    // @Index()
    lobbiesHosted: number;

    @Column({
        default: 0,
        unsigned: true,
    })
    // @Index()
    lobbiesStarted: number;

    @Column({
        default: 0,
        unsigned: true,
    })
    // @Index()
    participantsTotal: number;

    @Column({
        default: 0,
        unsigned: true,
    })
    // @Index()
    participantsUniqueTotal: number;

    @Column({
        type: 'decimal',
        precision: 8,
        scale: 2,
        default: 0,
        unsigned: true,
    })
    pendingTimeAverage: number;
}
