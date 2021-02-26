import * as orm from 'typeorm';
import fp from 'fastify-plugin';
import { AppAccount, AccountPrivileges } from '../../entity/AppAccount';
import { S2Map } from '../../entity/S2Map';
import { S2Profile } from '../../entity/S2Profile';
import { logger, logIt } from '../../logger';
import { defaultAccountSettings, UserPrivacyPreferences } from '../../entity/BnAccountSettings';
import { S2MapHeader } from '../../entity/S2MapHeader';
import { BnAccount } from '../../entity/BnAccount';
import { PlayerProfileParams } from '../../bnet/common';
import { realmIdFromLocalProfileId } from '../../common';

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

function getEffectiveAccountPreferences(account: BnAccount | null): Required<UserPrivacyPreferences> {
    const preferences: Required<UserPrivacyPreferences> = {} as any;

    for (const key of Object.keys(defaultAccountSettings)) {
        if (account?.settings && (account.settings as any)[key] !== null) {
            (preferences as any)[key] = (account.settings as any)[key];
        }
        else {
            (preferences as any)[key] = (defaultAccountSettings as any)[key];
        }
    }

    return preferences;
}

class AccessManager implements IAccessManager {
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

        const qb = this.conn.getRepository(BnAccount)
            .createQueryBuilder('bnAccount')
            .leftJoinAndSelect('bnAccount.settings', 'bnSettings')
            .innerJoin('bnAccount.profileLinks', 'plink', 'plink.accountVerified = 1')
        ;

        if (
            mapOrHeader instanceof S2Map &&
            typeof mapOrHeader?.regionId === 'number' &&
            typeof mapOrHeader?.authorLocalProfileId === 'number'
        ) {
            qb.andWhere('plink.regionId = :regionId AND plink.realmId = :realmId AND plink.profileId = :profileId', {
                regionId: mapOrHeader.regionId,
                ...realmIdFromLocalProfileId(mapOrHeader.authorLocalProfileId)
            });
        }
        else if (mhead.regionId && mhead.bnetId) {
            qb.innerJoin(S2Map, 'map', 'map.regionId = :regionId AND map.bnetId = :bnetId', {
                regionId: mhead.regionId,
                bnetId: mhead.bnetId,
            });
            qb.innerJoin(S2Profile, 'profile', 'map.regionId = profile.regionId AND map.authorLocalProfileId = profile.localProfileId');
            qb.andWhere('plink.regionId = profile.regionId AND plink.realmId = profile.realmId AND plink.profileId = profile.profileId');
        }
        else {
            throw new Error(`isMapAccessGranted, missing map params`);
        }

        // TODO: cache the result
        let authorBattleAccount = await qb.limit(1).getOne();

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

            const preferences = getEffectiveAccountPreferences(authorBattleAccount ?? null);

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
        const profileBatteAccount = await this.conn.getRepository(BnAccount)
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

        if (userAccount && userAccount.privileges & AccountPrivileges.SuperAdmin) {
            return true;
        }

        // allow access to author's own content
        if (userAccount && userAccount.bnAccountId === profileBatteAccount?.id) {
            return true;
        }

        const preferences = getEffectiveAccountPreferences(profileBatteAccount);

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
