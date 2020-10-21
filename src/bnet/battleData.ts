import * as orm from 'typeorm';
import { BattleAPI, BattleUserInfo, BattleSC2ProfileBase } from './battleAPI';
import { BnAccount } from '../entity/BnAccount';
import { profileHandle } from './common';
import { S2Profile } from '../entity/S2Profile';
import { S2ProfileTracking } from '../entity/S2ProfileTracking';
import { isAxiosError } from '../helpers';
import { logger } from '../logger';

export class BattleDataUpdater {
    protected bAPI = new BattleAPI();

    constructor (protected conn: orm.Connection) {
    }

    protected async updateAccountProfiles(bAccount: BnAccount) {
        let bProfiles: BattleSC2ProfileBase[];
        try {
            bProfiles = (await this.bAPI.sc2.getAccount(bAccount.id)).data;
        }
        catch (err) {
            if (isAxiosError(err) && err.response!.status === 503) {
                // supress error if there's at least one profile already associated with the account
                // (due to <https://us.forums.blizzard.com/en/blizzard/t/starcraft-ii-account-endpoint-returning-503-repeatedly/12645>)
                if (bAccount.profiles.length > 0) {
                    return;
                }
                else {
                    throw Error(`couldn't acquire list of SC2 profiles`);
                }
            }
            else {
                throw err;
            }
        }

        for (const bCurrProfile of bProfiles) {
            let s2profile = bAccount.profiles.find(x => profileHandle(x) === profileHandle(bCurrProfile));
            if (!s2profile) {
                s2profile = await this.conn.getRepository(S2Profile).findOne({
                    where: {
                        regionId: bCurrProfile.regionId,
                        realmId: bCurrProfile.realmId,
                        profileId: bCurrProfile.profileId,
                    },
                });
                if (!s2profile) {
                    s2profile = new S2Profile();
                    s2profile.regionId = bCurrProfile.regionId;
                    s2profile.realmId = bCurrProfile.realmId;
                    s2profile.profileId = bCurrProfile.profileId;
                    s2profile.name = bCurrProfile.name;
                    s2profile.nameUpdatedAt = new Date();
                }

                const updatedData: Partial<S2Profile> = {};
                if (!s2profile.account || s2profile.account.id !== bAccount.id) {
                    updatedData.account = bAccount;
                }
                if (s2profile.avatarUrl !== bCurrProfile.avatarUrl) {
                    updatedData.avatarUrl = bCurrProfile.avatarUrl;
                }

                Object.assign(s2profile, updatedData);
                if (this.conn.getRepository(S2Profile).hasId(s2profile)) {
                    if (Object.keys(updatedData).length) {
                        await this.conn.getRepository(S2Profile).update(s2profile.id, updatedData);
                    }
                }
                else {
                    await this.conn.getRepository(S2Profile).save(s2profile);
                }
                bAccount.profiles.push(s2profile);
            }
            else {
                if (s2profile.avatarUrl !== bCurrProfile.avatarUrl) {
                    s2profile.avatarUrl = bCurrProfile.avatarUrl;
                    await this.conn.getRepository(S2Profile).update(s2profile.id, {
                        avatarUrl: bCurrProfile.avatarUrl,
                    });
                }
            }
        }

        if (bAccount.profiles.length > bProfiles.length) {
            const detachedProfiles = bAccount.profiles.filter(x => !bProfiles.find(y => profileHandle(x) === profileHandle(y)))
            for (const dItem of detachedProfiles) {
                logger.verbose(`Detaching profile ${dItem.name}#${dItem.discriminator} from account ${dItem.account.id}`);
                dItem.account = null;
                bAccount.profiles.splice(bAccount.profiles.findIndex(x => x === dItem), 1);
                await this.conn.getRepository(S2Profile).update(dItem.id, { account: null });
            }
        }
    }

    async updateAccount(accountInfo: BattleUserInfo | number) {
        const accountId = typeof accountInfo === 'number' ? accountInfo : accountInfo.id;
        let bAccount = await this.conn.getRepository(BnAccount).findOne(accountId, {
            relations: ['profiles', 'settings'],
        });
        if (!bAccount) {
            bAccount = new BnAccount();
            bAccount.id = accountId;
            bAccount.profiles = [];
            await this.conn.getRepository(BnAccount).insert(bAccount);
        }
        if (typeof accountInfo === 'object') {
            bAccount.battleTag = accountInfo.battletag;
            bAccount.updatedAt = new Date();
            await this.conn.getRepository(BnAccount).save(bAccount);
        }
        await this.updateAccountProfiles(bAccount);
        return bAccount;
    }

    async updateProfileData(profile: S2Profile) {
        if (profile.tracking === null) {
            profile.tracking = new S2ProfileTracking();
            profile.tracking.regionId = profile.regionId;
            profile.tracking.realmId = profile.realmId;
            profile.tracking.profileId = profile.profileId;
            await this.conn.getRepository(S2ProfileTracking).insert(profile.tracking);
        }

        try {
            const bCurrProfile = (await this.bAPI.sc2.getProfile(profile)).data;

            const updatedData: Partial<S2Profile> = {};
            if (profile.avatarUrl !== bCurrProfile.summary.portrait) {
                updatedData.avatarUrl = bCurrProfile.summary.portrait;
            }

            if (Object.keys(updatedData).length) {
                Object.assign(profile, updatedData);
                await this.conn.getRepository(S2Profile).update(profile.id, updatedData);
            }
        }
        catch (err) {
            if (isAxiosError(err)) {
                if (err.response.status === 404 || err.response.status === 500) {
                    logger.verbose(`Profile "${profile.name}" ${profileHandle(profile)}: got ${err.response.status}`);
                }
                else if (err.response.status === 504) {
                    return;
                }
                else {
                    throw err;
                }
            }
            else {
                throw err;
            }
        }

        await this.conn.getRepository(S2ProfileTracking).update(profile.tracking.id, {
            profileInfoUpdatedAt: new Date(),
        });
    }
}
