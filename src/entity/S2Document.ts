import { Entity, PrimaryGeneratedColumn, Column, OneToOne, ManyToOne, Index, Unique, OneToMany } from 'typeorm';
import { S2DocumentVersion } from './S2DocumentVersion';
import { S2Region } from './S2Region';

export enum S2DocumentType {
    Map = 'map',
    ExtensionMod = 'extension_mod',
    DependencyMod = 'dependency_mod',
}

@Entity()
@Unique('region_bnet_id', ['region', 'bnetId'])
export class S2Document {
    @PrimaryGeneratedColumn()
    id: number;

    @ManyToOne(type => S2Region, {
        nullable: false,
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
    })
    @Index()
    region: S2Region;

    @Column()
    regionId: number;

    @Column({
        type: 'mediumint',
        unsigned: true,
    })
    bnetId: number;

    @Column({
        type: 'enum',
        nullable: false,
        enum: S2DocumentType,
    })
    type: S2DocumentType;

    @Column({
        nullable: true,
    })
    isArcade: boolean;

    @Column()
    @Index('doc_name')
    name: string;

    @Column({
        nullable: true,
    })
    categoryId: number;

    @OneToMany(type => S2DocumentVersion, documentVersion => documentVersion.document, {
        cascade: false,
    })
    docVersions: S2DocumentVersion[];

    @Column({
        type: 'smallint',
        unsigned: true,
        nullable: true,
    })
    currentMajorVersion: number;

    @Column({
        type: 'smallint',
        unsigned: true,
        nullable: true,
    })
    currentMinorVersion: number;

    @Column({
        type: 'varchar',
        length: 64,
        nullable: true,
    })
    iconHash: string;

    currentVersion?: S2DocumentVersion;
}
