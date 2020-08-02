import { Entity, PrimaryGeneratedColumn, Column, Index, Unique, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { S2StatsPeriod } from './S2StatsPeriod';
import { S2Region } from './S2Region';

@Entity()
@Unique('period_region_idx', ['period', 'region'])
export class S2StatsPeriodRegion {
    @PrimaryGeneratedColumn()
    id: number;

    @ManyToOne(type => S2StatsPeriod, statPeriod => statPeriod.mapStats, {
        nullable: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @Index()
    period: S2StatsPeriod;

    @ManyToOne(type => S2Region, {
        nullable: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @Index()
    region: S2Region;

    @Column({
        unsigned: true,
        type: 'tinyint',
    })
    regionId: number;

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
}
