import { EntityRepository, Repository, SelectQueryBuilder } from 'typeorm';
import { S2ProfileTracking } from '../entity/S2ProfileTracking';
import { PlayerProfileParams } from '../bnet/common';
import { localProfileId } from '../common';

@EntityRepository(S2ProfileTracking)
export class S2ProfileTrackingRepository extends Repository<S2ProfileTracking> {
    async fetchOrCreate(params: PlayerProfileParams) {
        let pTracking = await this.findOne({
            where: {
                regionId: params.regionId,
                localProfileId: localProfileId(params),
            },
        });

        if (!pTracking) {
            pTracking = S2ProfileTracking.create(params);
            await this.insert(pTracking);
        }

        return pTracking;
    }
}
