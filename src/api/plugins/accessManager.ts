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

// TODO: temporary restrictive settings, to be replaced with `defaultAccountSettings`
export const publicAccountSettings: Required<UserPrivacyPreferences> = {
    profilePrivate: false,
    mapPubDownload: true,
    mapPrivDownload: false,
    mapPrivDetails: false,
    mapPrivListed: false,
};

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

function getEffectiveAccountPreferences(account?: BnAccount): Required<UserPrivacyPreferences> {
    const preferences: Required<UserPrivacyPreferences> = {} as any;
    for (const key of Object.keys(publicAccountSettings)) {
        if (account !== null && account?.settings && (account.settings as any)[key] !== null) {
            (preferences as any)[key] = (account.settings as any)[key];
        }
        else {
            (preferences as any)[key] = (publicAccountSettings as any)[key];
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

        const qb = this.conn.getRepository(S2Profile).createQueryBuilder('profile')
            .select([
                'profile.id',
                'profile.account'
            ])
            .leftJoinAndSelect('profile.account', 'bnAccount')
            .leftJoinAndSelect('bnAccount.settings', 'bnSettings')
        ;

        if (mapOrHeader instanceof S2Map && mapOrHeader.author) {
            qb.andWhere('profile.id = :pid', { pid: mapOrHeader.author.id });
        }
        else if (mhead.regionId && mhead.bnetId) {
            const mapAuthorQuery = qb.subQuery().select()
                .from(S2Map, 'map')
                .select('map.author')
                .andWhere('map.regionId = :regionId AND map.bnetId = :bnetId')
                .limit(1)
                .getQuery()
            ;
            qb.andWhere('profile.id = ' + mapAuthorQuery, { regionId: mhead.regionId, bnetId: mhead.bnetId })
        }
        else {
            throw new Error(`isMapAccessGranted, missing map params`);
        }

        // TODO: cache the result
        let authorProfile = await qb.getOne();

        const results: boolean[] = [];
        const kinds = Array.isArray(kind) ? kind : [kind];
        for (const currKind of kinds) {
            if (userAccount?.privileges & AccountPrivileges.SuperAdmin) {
                results.push(true);
                continue;
            }

            if (!authorProfile) {
                logger.warn(`couldn't fetch authorProfile of ${mhead.linkVer}`);
                results.push(false);
                continue;
            }

            // allow access to author's own content
            if (userAccount && userAccount.bnAccountId === authorProfile?.account?.id) {
                results.push(true);
                continue;
            }

            const preferences = getEffectiveAccountPreferences(authorProfile?.account);

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

    async isProfileAccessGranted(kind: ProfileAccessAttributes, profile: S2Profile | PlayerProfileParams, userAccount?: AppAccount) {
        let profileAccount: BnAccount;

        if (typeof (profile as S2Profile).account === 'undefined') {
            const profileQuery = this.conn.getRepository(S2Profile).createQueryBuilder().subQuery()
                .from(S2Profile, 'profile')
                .select('profile.id')
                .andWhere('profile.regionId = :regionId AND profile.realmId = :realmId AND profile.profileId = :profileId')
                .limit(1)
                .getQuery()
            ;
            const result = await this.conn.getRepository(S2Profile).createQueryBuilder('profile')
                .select([
                    'profile.id',
                    'profile.account'
                ])
                .leftJoinAndSelect('profile.account', 'bnAccount')
                .leftJoinAndSelect('bnAccount.settings', 'bnSettings')
                .andWhere('profile.id = ' + profileQuery, {
                    regionId: profile.regionId,
                    realmId: profile.realmId,
                    profileId: profile.profileId,
                })
                .getOne()
            ;
            profileAccount = result.account;
        }
        else if ((profile as S2Profile).account !== null) {
            profileAccount = (profile as S2Profile).account;
        }

        if (userAccount?.privileges & AccountPrivileges.SuperAdmin) {
            return true;
        }

        // allow access to author's own content
        if (userAccount && userAccount.bnAccountId === profileAccount?.id) {
            return true;
        }

        const preferences = getEffectiveAccountPreferences(profileAccount);

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
