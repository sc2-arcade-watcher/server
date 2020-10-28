import { Entity, Column, Index } from 'typeorm';
import { GameLocale } from '../common';

@Entity()
@Index('name_region_idx', ['name', 'regionId'])
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
    })
    majorVersion: number;

    @Column({
        type: 'smallint',
        unsigned: true,
    })
    minorVersion: number;

    @Column()
    inLatestVersion: boolean;

    @Column()
    isMain: boolean;

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
