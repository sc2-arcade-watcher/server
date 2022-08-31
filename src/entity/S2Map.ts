import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, Index, Unique, JoinColumn, OneToMany } from 'typeorm';
import { GameLocale, GameLocaleFlag } from '../common';
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

@Entity({
    engine: 'ROCKSDB',
})
@Unique('region_bnet_idx', ['regionId', 'bnetId'])
@Index('local_profile_region_idx', ['authorLocalProfileId', 'regionId'])
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

    @Column({
        type: 'enum',
        enum: S2MapType,
    })
    type: S2MapType;

    @ManyToOne(type => S2MapHeader, {
        nullable: false,
        // foreign keys not supported on RocksDB
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
    })
    @Index('current_version_idx')
    currentVersion: S2MapHeader;

    @ManyToOne(type => S2MapHeader, {
        nullable: false,
        // foreign keys not supported on RocksDB
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
    })
    @Index('initial_version_idx')
    initialVersion: S2MapHeader;

    @Column({
        unsigned: true,
        type: 'int',
    })
    authorLocalProfileId: number;

    @Column({
        type: 'int',
        unsigned: true,
    })
    availableLocales: GameLocaleFlag;

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
        default: 0,
    })
    maxPlayers: number;

    @Column({
        type: 'tinyint',
        unsigned: true,
        default: 0,
    })
    maxHumanPlayers: number;

    @Column()
    @Index('updated_at_idx')
    updatedAt: Date;

    @Column()
    @Index('published_at_idx')
    publishedAt: Date;

    @Column({
        type: 'smallint',
        unsigned: true,
        default: 0,
    })
    @Index('user_reviews_count_idx')
    userReviewsCount: number;

    @Column({
        type: 'decimal',
        unsigned: true,
        precision: 4,
        scale: 3,
        default: 0,
    })
    @Index('user_reviews_rating')
    userReviewsRating: number;

    @Column({
        default: false,
    })
    removed: boolean;

    @OneToMany(type => S2MapVariant, variant => variant.map, {
        persistence: false,
        cascade: false,
    })
    variants: S2MapVariant[];

    author?: S2Profile;

    revisions?: S2MapHeader[];

    locales?: S2MapLocale[];

    dependencies?: S2MapDependency[];

    getLocalization(locale: GameLocale) {
        return this.locales?.find(x => x.locale === locale);
    }
}
