import { EntityRepository, Repository, SelectQueryBuilder } from 'typeorm';
import { S2MapTracking } from '../entity/S2MapTracking';

@EntityRepository(S2MapTracking)
export class S2MapTrackingRepository extends Repository<S2MapTracking> {
    async fetchOrCreate(params: { regionId: number, mapId: number }) {
        let mpTrack = await this.findOne({
            where: {
                regionId: params.regionId,
                mapId: params.mapId,
            },
        });

        if (!mpTrack) {
            mpTrack = S2MapTracking.create(params);
            await this.insert(mpTrack);
        }

        return mpTrack;
    }
}
