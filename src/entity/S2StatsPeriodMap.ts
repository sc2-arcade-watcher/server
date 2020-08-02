import { Entity, PrimaryGeneratedColumn, Column, Index, Unique, ManyToOne, OneToMany } from 'typeorm';
import { S2Document } from './S2Document';
import { S2StatsPeriod } from './S2StatsPeriod';

@Entity()
@Unique('period_map_idx', ['period', 'document'])
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
    lobbiesHosted: number;

    @Column({
        default: 0,
        unsigned: true,
    })
    lobbiesStarted: number;

    @Column({
        default: 0,
        unsigned: true,
    })
    participantsTotal: number;

    @Column({
        default: 0,
        unsigned: true,
        nullable: true,
    })
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
