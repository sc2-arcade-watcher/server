import { Entity, PrimaryGeneratedColumn, Column, OneToOne, ManyToOne, Index, Unique, OneToMany, JoinColumn } from 'typeorm';
import { S2Region } from './S2Region';

@Entity()
export class S2RegionMapProgress {
    @OneToOne(type => S2Region, {
        nullable: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        primary: true,
    })
    @JoinColumn()
    region: S2Region;

    regionId: number;

    @Column({
        default: 0,
    })
    offsetMapId: number;
}
