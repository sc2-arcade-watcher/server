import { Entity, PrimaryGeneratedColumn, Column, Index, ManyToOne, Unique, OneToOne } from 'typeorm';
import { S2Region } from './S2Region';
import { SysFeedPosition } from './SysFeedPosition';

@Entity()
@Unique('region_name', ['region', 'name'])
export class SysFeedProvider {
    @PrimaryGeneratedColumn()
    id: number;

    @ManyToOne(type => S2Region, {
        nullable: false,
        eager: true,
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
    })
    @Index()
    region: S2Region;

    @Column()
    @Index()
    name: string;

    @Column({
        default: false,
    })
    enabled: boolean;

    @OneToOne(type => SysFeedPosition, position => position.provider, {
        nullable: false,
        eager: true,
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
    })
    position: SysFeedPosition;
}
