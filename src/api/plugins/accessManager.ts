import * as fs from 'fs-extra';
import * as orm from 'typeorm';
import fp from 'fastify-plugin';
import { AppAccount, AccountPrivileges } from '../../entity/AppAccount';
import { S2Map } from '../../entity/S2Map';
import { S2Profile } from '../../entity/S2Profile';
import { logger, logIt } from '../../logger';
import { defaultAccountSettings, UserPrivacyPreferences } from '../../entity/BnAccountSettings';
import { S2MapHeader } from '../../entity/S2MapHeader';
import { BnAccount } from '../../entity/BnAccount';
import { PlayerProfileParams, profileHandle } from '../../bnet/common';
import { realmIdFromLocalProfileId } from '../../common';
import { S2ProfileAccountLink } from '../../entity/S2ProfileAccountLink';

export enum MapAccessAttributes {
    Details,
    Download,
    DownloadPrivateRevision,
}

export enum ProfileAccessAttributes {
    Details,
    PrivateMapList,
}

interface IAccessManager {
    isMapAccessGranted(kind: MapAccessAttributes, mapOrHeadermap: S2Map | S2MapHeader, userAccount?: AppAccount): Promise<boolean>;
    isMapAccessGranted(kind: MapAccessAttributes[], mapOrHeader: S2Map | S2MapHeader, userAccount?: AppAccount): Promise<boolean[]>;
    isProfileAccessGranted(kind: ProfileAccessAttributes, profile: S2Profile | PlayerProfileParams, userAccount?: AppAccount): Promise<boolean>;
}

type RestrictionOverrides = {
    profiles: { [handle: string]: 'allow' | 'deny' };
};

function getEffectiveAccountPreferences(account: BnAccount | null, profile?: S2Profile): Required<UserPrivacyPreferences> {
    const preferences: Required<UserPrivacyPreferences> = {} as any;
    const dayDiff = (Date.now() - (profile?.lastOnlineAt?.getTime() ?? 0)) / 1000 / 3600 / 24;

    for (const key of Object.keys(defaultAccountSettings)) {
        if (account?.settings && (account.settings as any)[key] !== null) {
            (preferences as any)[key] = (account.settings as any)[key];
        }
        else {
            if (
                ['mapPubDownload', 'mapPrivDownload'].indexOf(key) !== -1 &&
                dayDiff <= 365 * 2
            ) {
                (preferences as any)[key] = false;
            }
            else {
                (preferences as any)[key] = (defaultAccountSettings as any)[key];
            }
        }
    }

    return preferences;
}

class AccessManager implements IAccessManager {
    protected customRestrictions = <RestrictionOverrides>fs.readJSONSync('data/config/api-restrictions.json', { encoding: 'utf8' });

    constructor (protected conn: orm.Connection) {
    }

    // @ts-ignore
    async isMapAccessGranted(kind: MapAccessAttributes | MapAccessAttributes[], mapOrHeader: S2Map | S2MapHeader, userAccount?: AppAccount) {
        let mhead: S2MapHeader;

        if (mapOrHeader instanceof S2Map) {
            mhead = mapOrHeader.currentVersion;
        }
        else {
            mhead = mapOrHeader;
        }
        const isMapPublic = mhead.isPrivate === false;

        // exit early for public maps when only Details are wanted
        if (isMapPublic && kind === MapAccessAttributes.Details) {
            return true;
        }

        const qbAuthorProfile = this.conn.getRepository(S2Profile)
            .createQueryBuilder('profile')
            .leftJoinAndMapOne(
                'profile.accountLink',
                S2ProfileAccountLink,
                'plink',
                'plink.regionId = profile.regionId AND plink.realmId = profile.realmId AND plink.profileId = profile.profileId AND plink.accountVerified = 1'
            )
            .leftJoinAndSelect('plink.account', 'bnAccount')
            .leftJoinAndSelect('bnAccount.settings', 'bnSettings')
        ;

        if (
            mapOrHeader instanceof S2Map &&
            typeof mapOrHeader?.regionId === 'number' &&
            typeof mapOrHeader?.authorLocalProfileId === 'number'
        ) {
            qbAuthorProfile.andWhere('profile.regionId = :regionId AND profile.realmId = :realmId AND profile.profileId = :profileId', {
                regionId: mapOrHeader.regionId,
                ...realmIdFromLocalProfileId(mapOrHeader.authorLocalProfileId)
            });
        }
        else if (mhead.regionId && mhead.bnetId) {
            qbAuthorProfile
                .innerJoin(S2Map, 'map', 'map.regionId = :regionId AND map.bnetId = :bnetId', {
                    regionId: mhead.regionId,
                    bnetId: mhead.bnetId,
                })
                .andWhere('map.regionId = profile.regionId AND map.authorLocalProfileId = profile.localProfileId')
            ;
        }
        else {
            throw new Error(`isMapAccessGranted, missing map params`);
        }

        // TODO: cache the result
        const authorProfile = await qbAuthorProfile.limit(1).getOne();
        if (!authorProfile) {
            throw new Error(`map author unknown`);
        }
        const authorBattleAccount = authorProfile?.accountLink?.account;

        const results: boolean[] = [];
        const kinds = Array.isArray(kind) ? kind : [kind];
        for (const currKind of kinds) {
            if (userAccount && userAccount.privileges & AccountPrivileges.SuperAdmin) {
                results.push(true);
                continue;
            }

            // allow access to author's own content
            if (userAccount && userAccount.bnAccountId === authorBattleAccount?.id) {
                results.push(true);
                continue;
            }

            const crestrict = this.customRestrictions.profiles[profileHandle(authorProfile)];
            if (typeof crestrict === 'string') {
                if (crestrict === 'allow') results.push(true);
                if (crestrict === 'deny') results.push(false);
                continue;
            }

            const preferences = getEffectiveAccountPreferences(authorBattleAccount ?? null, authorProfile);

            switch (currKind) {
                case MapAccessAttributes.Details: {
                    results.push(isMapPublic ? true : preferences.mapPrivDetails);
                    break;
                }

                case MapAccessAttributes.Download: {
                    results.push(isMapPublic ? preferences.mapPubDownload : preferences.mapPrivDownload);
                    break;
                }

                case MapAccessAttributes.DownloadPrivateRevision: {
                    results.push(preferences.mapPrivDownload);
                    break;
                }
            }
        }

        return Array.isArray(kind) ? results : results.shift();
    }

    async isProfileAccessGranted(kind: ProfileAccessAttributes, profile: PlayerProfileParams, userAccount?: AppAccount): Promise<boolean> {
        if (userAccount && userAccount.privileges & AccountPrivileges.SuperAdmin) {
            return true;
        }

        const profileBattleAccount = await this.conn.getRepository(BnAccount)
            .createQueryBuilder('bnAccount')
            .leftJoinAndSelect('bnAccount.settings', 'bnSettings')
            .innerJoin('bnAccount.profileLinks', 'plink', 'plink.accountVerified = 1')
            .andWhere('plink.regionId = :regionId AND plink.realmId = :realmId AND plink.profileId = :profileId', {
                regionId: profile.regionId,
                realmId: profile.realmId,
                profileId: profile.profileId,
            })
            .limit(1)
            .getOne()
        ;

        // allow access to author's own content
        if (userAccount && userAccount.bnAccountId === profileBattleAccount?.id) {
            return true;
        }

        const crestrict = this.customRestrictions.profiles[profileHandle(profile)];
        if (typeof crestrict === 'string') {
            if (crestrict === 'allow') return true;
            if (crestrict === 'deny') return false;
        }

        const preferences = getEffectiveAccountPreferences(profileBattleAccount);

        switch (kind) {
            case ProfileAccessAttributes.Details: {
                return !preferences.profilePrivate;
                break;
            }

            case ProfileAccessAttributes.PrivateMapList: {
                return preferences.mapPrivListed;
                break;
            }

            default: {
                return false;
                break;
            }
        }
    }
}

declare module 'fastify' {
    export interface FastifyInstance {
        accessManager: IAccessManager;
    }
}

export default fp(async (server, opts) => {
    server.decorate('accessManager', new AccessManager(server.conn));
});
