import { Entity, PrimaryGeneratedColumn, Column, Index, Unique, OneToMany } from 'typeorm';
import { S2StatsPeriodMap } from './S2StatsPeriodMap';

@Entity()
@Unique('length_from', ['length', 'dateFrom'])
export class S2StatsPeriod {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({
        type: 'tinyint',
        unsigned: true,
    })
    @Index()
    length: number;

    @Column({
        type: 'date',
    })
    dateFrom: Date;

    @OneToMany(type => S2StatsPeriodMap, statPeriodMap => statPeriodMap.period, {
        cascade: false,
    })
    mapStats: S2StatsPeriodMap[];

    @Column({
        type: 'boolean',
        default: false,
    })
    completed: boolean;
}
