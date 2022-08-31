import { Entity, Column, Index } from 'typeorm';

@Entity({
    engine: 'ROCKSDB',
})
@Index('region_dependency_idx', ['regionId', 'dependencyMapId'])
export class S2MapDependency {
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
    mapId: number;

    @Column({
        type: 'tinyint',
        unsigned: true,
        primary: true,
    })
    dependencyIndex: number;

    @Column({
        type: 'mediumint',
        unsigned: true,
    })
    dependencyMapId: number;

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
}
