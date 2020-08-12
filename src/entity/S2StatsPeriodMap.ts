import { Entity, PrimaryGeneratedColumn, Column, Index, Unique, ManyToOne, OneToMany } from 'typeorm';
import { S2StatsPeriod } from './S2StatsPeriod';

@Entity()
@Unique('period_map_idx', ['period', 'regionId', 'bnetId'])
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
