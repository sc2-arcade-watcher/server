import { Entity, PrimaryGeneratedColumn, Column, Index, Unique, ManyToOne } from 'typeorm';
import { S2Map } from './S2Map';

@Entity()
@Unique('map_variant_idx', ['map', 'variantIndex'])
export class S2MapVariant {
    @PrimaryGeneratedColumn()
    id: number;

    @ManyToOne(type => S2Map, map => map.variants, {
        nullable: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @Index('map_idx')
    map: S2Map;

    @Column()
    mapId: number;

    @Column({
        type: 'tinyint',
        unsigned: true,
    })
    variantIndex: number;

    @Column()
    name: string;

    @Column({
        type: 'tinyint',
        unsigned: true,
    })
    lobbyDelay: number;
}
