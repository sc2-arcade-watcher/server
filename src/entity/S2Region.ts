import { Entity, PrimaryColumn, Column, Index, OneToOne } from 'typeorm';
import { S2RegionMapProgress } from './S2RegionMapProgress';

@Entity()
export class S2Region {
    @PrimaryColumn({
        unsigned: true,
        type: 'tinyint',
    })
    id: number;

    @Column({
        type: 'varchar',
        length: 2,
    })
    @Index({
        unique: true,
    })
    code: string;

    @Column({
        length: 32
    })
    name: string;

    @OneToOne(type => S2RegionMapProgress, mapProgress => mapProgress.region, {
    })
    mapProgress: S2RegionMapProgress;
}
