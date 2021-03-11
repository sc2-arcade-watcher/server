import { EntityRepository, Repository, SelectQueryBuilder } from 'typeorm';
import { S2Profile, BareS2Profile } from '../entity/S2Profile';
import { BnAccount } from '../entity/BnAccount';
import { S2ProfileAccountLink } from '../entity/S2ProfileAccountLink';

@EntityRepository(S2Profile)
export class S2ProfileRepository extends Repository<S2Profile> {
    async findByBattleAccount(bnAccountId: number, params?: { regionId?: number }) {
        const qb = this.createQueryBuilder('profile')
            .innerJoin(
                S2ProfileAccountLink,
                'pal',
                'profile.regionId = pal.regionId AND profile.realmId = pal.realmId AND profile.profileId = pal.profileId'
            )
            .andWhere('pal.account = :account', { account: bnAccountId })
        ;

        if (params?.regionId) {
            qb.andWhere('profile.regionId = :regionId', { regionId: params.regionId });
        }

        return qb.getMany();
    }
}
