import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, Index, Unique, JoinColumn } from 'typeorm';
import { S2Region } from './S2Region';
import { S2Map } from './S2Map';

@Entity()
@Unique('region_map_ver_idx', ['region', 'bnetId', 'majorVersion', 'minorVersion'])
export class S2MapHeader {
    @PrimaryGeneratedColumn()
    id: number;

    @ManyToOne(type => S2Region, {
        nullable: false,
    })
    @Index()
    region: S2Region;

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
        type: 'smallint',
        unsigned: true,
    })
    majorVersion: number;

    @Column({
        type: 'smallint',
        unsigned: true,
    })
    minorVersion: number;

    @Column({
        type: 'char',
        length: 64,
    })
    headerHash: string;

    @Column()
    isPrivate: boolean;

    @Column()
    isExtensionMod: boolean;

    @Column({
        type: 'char',
        length: 64,
        nullable: true,
    })
    archiveHash: string;

    @Column({
        unsigned: true,
        nullable: true,
    })
    archiveSize: number;

    @Column({
        nullable: true,
    })
    @Index('uploaded_at_idx')
    uploadedAt: Date;

    map?: S2Map;
}
