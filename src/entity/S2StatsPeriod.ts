import { Entity, PrimaryGeneratedColumn, Column, Index, Unique, OneToMany } from 'typeorm';
import { S2StatsPeriodMap } from './S2StatsPeriodMap';
import { S2StatsPeriodRegion } from './S2StatsPeriodRegion';

export enum S2StatsPeriodKind {
    Daily = 'daily',
    Weekly = 'weekly',
    Monthly = 'monthly',
}

@Entity()
@Unique('kind_date_from_idx', ['kind', 'dateFrom'])
export class S2StatsPeriod {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({
        type: 'enum',
        nullable: false,
        enum: S2StatsPeriodKind,
    })
    kind: S2StatsPeriodKind;

    @Column({
        type: 'date',
    })
    dateFrom: Date;

    @Column({
        type: 'date',
    })
    dateTo: Date;

    @Column({
        type: 'boolean',
        default: false,
    })
    completed: boolean;

    @OneToMany(type => S2StatsPeriodMap, statPeriodMap => statPeriodMap.period, {
        cascade: false,
    })
    mapStats: S2StatsPeriodMap[];

    @OneToMany(type => S2StatsPeriodRegion, statPeriodRegion => statPeriodRegion.period, {
        cascade: false,
    })
    regionStats: S2StatsPeriodRegion[];
}
