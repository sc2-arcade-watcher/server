import { EntityRepository, Repository, SelectQueryBuilder } from 'typeorm';
import { S2ProfileTracking } from '../entity/S2ProfileTracking';
import { PlayerProfileParams } from '../bnet/common';

@EntityRepository(S2ProfileTracking)
export class S2ProfileTrackingRepository extends Repository<S2ProfileTracking> {
    async fetchOrCreate(params: PlayerProfileParams) {
        let pTracking = await this.findOne({
            where: {
                regionId: params.regionId,
                realmId: params.realmId,
                profileId: params.profileId,
            },
        });

        if (!pTracking) {
            pTracking = new S2ProfileTracking();
            pTracking.regionId = params.regionId;
            pTracking.realmId = params.realmId;
            pTracking.profileId = params.profileId;
            pTracking.battleAPIErrorCounter = 0;
            pTracking.preferPublicGateway = false;
            pTracking.nameUpdatedAt = new Date(0);
            await this.insert(pTracking);
        }

        return pTracking;
    }
}
