import * as orm from 'typeorm';
import { BareS2Profile, S2Profile } from '../entity/S2Profile';
import { S2ProfileBattleTracking } from '../entity/S2ProfileBattleTracking';
import { localProfileId } from '../common';

export class ProfileManager {
    static async create(params: BareS2Profile, conn: orm.Connection) {
        const profile = S2Profile.create(params);
        profile.name = params.name;
        profile.discriminator = params.discriminator;
        profile.avatar = params.avatar ?? '';
        if (params.profileGameId) {
            profile.profileGameId = params.profileGameId;
        }
        if (params.battleTag) {
            profile.battleTag = params.battleTag;
        }
        profile.battleTracking = S2ProfileBattleTracking.create(params);

        await conn.transaction(async (tsManager) => {
            await tsManager.getRepository(S2Profile).insert(profile);
            await tsManager.getRepository(S2ProfileBattleTracking).insert(profile.battleTracking);
        });

        return profile;
    }

    static async fetchOrCreate(params: BareS2Profile, conn: orm.Connection) {
        let profile = await conn.getRepository(S2Profile).findOne({
            where: {
                regionId: params.regionId,
                localProfileId: localProfileId(params),
            },
        });

        if (!profile) {
            profile = await ProfileManager.create(params, conn);
        }

        return profile;
    }
}
