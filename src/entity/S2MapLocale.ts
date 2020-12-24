import { Entity, Column, Index } from 'typeorm';
import { GameLocale } from '../common';

@Entity()
@Index('name_idx', ['name'])
@Index('original_name_idx', ['originalName'])
export class S2MapLocale {
    @Column({
        type: 'tinyint',
        unsigned: true,
        primary: true,
    })
    regionId: number;

    @Column({
        type: 'mediumint',
        unsigned: true,
        primary: true,
    })
    bnetId: number;

    @Column({
        type: 'enum',
        enum: GameLocale,
        primary: true,
    })
    locale: GameLocale;

    @Column({
        type: 'smallint',
        unsigned: true,
        default: 0,
    })
    initialMajorVersion: number;

    @Column({
        type: 'smallint',
        unsigned: true,
        default: 0,
    })
    initialMinorVersion: number;

    @Column({
        type: 'smallint',
        unsigned: true,
    })
    latestMajorVersion: number;

    @Column({
        type: 'smallint',
        unsigned: true,
    })
    latestMinorVersion: number;

    @Column()
    inLatestVersion: boolean;

    @Column()
    isMain: boolean;

    @Column({
        type: 'char',
        length: 64,
        collation: 'ascii_bin',
        nullable: true,
    })
    tableHash: string;

    @Column({
        nullable: true,
    })
    originalName: string | null;

    @Column()
    name: string;

    @Column({
        length: 3072,
    })
    description: string;

    @Column({
        length: 512,
    })
    website: string;
}
