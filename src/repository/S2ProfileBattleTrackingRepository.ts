import { EntityRepository, Repository, SelectQueryBuilder } from 'typeorm';
import { S2ProfileBattleTracking } from '../entity/S2ProfileBattleTracking';

@EntityRepository(S2ProfileBattleTracking)
export class S2ProfileBattleTrackingRepository extends Repository<S2ProfileBattleTracking> {
}
