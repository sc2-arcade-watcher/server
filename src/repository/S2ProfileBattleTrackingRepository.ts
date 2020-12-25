import { EntityRepository, Repository, SelectQueryBuilder } from 'typeorm';
import { S2ProfileBattleTracking } from '../entity/S2ProfileBattleTracking';
import { PlayerProfileParams } from '../bnet/common';
import { localProfileId } from '../common';

@EntityRepository(S2ProfileBattleTracking)
export class S2ProfileBattleTrackingRepository extends Repository<S2ProfileBattleTracking> {
    async fetchOrCreate(params: PlayerProfileParams) {
        let pTracking = await this.findOne({
            where: {
                regionId: params.regionId,
                localProfileId: localProfileId(params),
            },
        });

        if (!pTracking) {
            pTracking = S2ProfileBattleTracking.create(params);
            await this.insert(pTracking);
        }

        return pTracking;
    }
}
