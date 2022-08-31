import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, Index, Unique, JoinColumn } from 'typeorm';
import { S2Map } from './S2Map';

@Entity({
    engine: 'ROCKSDB',
})
@Unique('region_map_ver_idx', ['regionId', 'bnetId', 'majorVersion', 'minorVersion'])
export class S2MapHeader {
    @PrimaryGeneratedColumn()
    id: number;

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
        collation: 'ascii_bin',
    })
    headerHash: string;

    @Column()
    isPrivate: boolean;

    @Column()
    isExtensionMod: boolean;

    @Index('archive_hash_idx')
    @Column({
        type: 'char',
        length: 64,
        collation: 'ascii_bin',
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
    archiveFilename: string;

    @Column({
        nullable: true,
    })
    @Index('uploaded_at_idx')
    uploadedAt: Date;

    map?: S2Map;

    get linkVer() {
        return `${this.regionId}/${this.bnetId} v${this.majorVersion}.${this.minorVersion}`;
    }

    get absoluteVersion() {
        return ((this.majorVersion & 0xFFFF) << 16) | this.minorVersion & 0xFFFF;
    }
}
