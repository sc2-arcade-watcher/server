import { EntityRepository, Repository, SelectQueryBuilder } from 'typeorm';
import { S2Map } from '../entity/S2Map';
import { S2MapLocale } from '../entity/S2MapLocale';
import { S2MapDependency } from '../entity/S2MapDependency';

@EntityRepository(S2Map)
export class S2MapRepository extends Repository<S2Map> {
    prepareDetailedSelect() {
        return this
            .createQueryBuilder('map')
            .innerJoinAndSelect('map.initialVersion', 'initVer')
            .innerJoinAndSelect('map.currentVersion', 'currVer')
            .leftJoinAndSelect('map.author', 'author')
            .leftJoinAndMapMany('map.locales', S2MapLocale, 'locale', 'map.regionId = locale.regionId AND map.bnetId = locale.bnetId')
            .leftJoinAndMapMany('map.dependencies', S2MapDependency, 'mapDep', 'map.regionId = mapDep.regionId AND map.bnetId = mapDep.mapId')
            .addOrderBy('mapDep.dependencyIndex', 'ASC')
        ;
    }

    findOneWithMetadata(regionId: number, mapId: number) {
        const qb = this.prepareDetailedSelect();
        return qb
            .andWhere('map.regionId = :regionId AND map.bnetId = :bnetId', {
                regionId: regionId,
                bnetId: mapId,
            })
            .getOne()
        ;
    }
}
