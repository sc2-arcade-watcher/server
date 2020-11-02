import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, Index, Unique, JoinColumn, OneToMany } from 'typeorm';
import { GameLocale } from '../common';
import { S2MapHeader } from './S2MapHeader';
import { S2Profile } from './S2Profile';
import { S2MapVariant } from './S2MapVariant';
import { S2MapLocale } from './S2MapLocale';
import { S2MapDependency } from './S2MapDependency';

export enum S2MapType {
    MeleeMap = 'melee_map',
    ArcadeMap = 'arcade_map',
    ExtensionMod = 'extension_mod',
    DependencyMod = 'dependency_mod',
}

@Entity()
@Unique('region_bnet_idx', ['regionId', 'bnetId'])
@Index('category_type_region_idx', ['mainCategoryId', 'type', 'regionId'])
@Index('type_region_idx', ['type', 'regionId'])
export class S2Map {
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

    @ManyToOne(type => S2Profile, {
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
    })
    @Index('author_idx')
    author: S2Profile;

    @Column({
        type: 'enum',
        enum: S2MapType,
    })
    type: S2MapType;

    @ManyToOne(type => S2MapHeader, {
        nullable: false,
    })
    @Index('current_version_idx')
    currentVersion: S2MapHeader;

    @ManyToOne(type => S2MapHeader, {
        nullable: true,
    })
    @Index('initial_version_idx')
    initialVersion: S2MapHeader;

    @Column({
        type: 'enum',
        enum: GameLocale,
    })
    mainLocale: GameLocale;

    @Column({
        type: 'char',
        length: 64,
        collation: 'ascii_bin',
    })
    mainLocaleHash: string;

    @Column({
        type: 'char',
        length: 64,
        nullable: true,
        collation: 'ascii_bin',
    })
    iconHash: string;

    @Column({
        type: 'char',
        length: 64,
        nullable: true,
        collation: 'ascii_bin',
    })
    thumbnailHash: string;

    @Column()
    @Index('name_fulltext_idx', {
        fulltext: true,
    })
    @Index('name_idx')
    name: string;

    @Column({
        nullable: true,
        length: 3072,
    })
    description: string;

    @Column({
        nullable: true,
        length: 512,
    })
    website: string;

    @Column({
        type: 'tinyint',
        unsigned: true,
    })
    mainCategoryId: number;

    @Column({
        type: 'tinyint',
        unsigned: true,
        nullable: true,
    })
    maxPlayers: number;

    @Column({
        nullable: true,
    })
    @Index('updated_at_idx')
    updatedAt: Date;

    @Column({
        nullable: true,
    })
    @Index('published_at_idx')
    publishedAt: Date;

    @OneToMany(type => S2MapVariant, variant => variant.map, {
        persistence: false,
        cascade: false,
    })
    variants: S2MapVariant[];

    revisions?: S2MapHeader[];

    locales?: S2MapLocale[];

    dependencies?: S2MapDependency[];

    getLocalization(locale: GameLocale) {
        return this.locales?.find(x => x.locale === locale);
    }
}
