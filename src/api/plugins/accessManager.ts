import * as orm from 'typeorm';
import fp from 'fastify-plugin';
import { subMonths } from 'date-fns';
import { AppAccount, AccountPrivileges } from '../../entity/AppAccount';
import { S2Map } from '../../entity/S2Map';
import { S2Profile } from '../../entity/S2Profile';
import { logger, logIt } from '../../logger';
import { defaultAccountSettings, UserPrivacyPreferences } from '../../entity/BnAccountSettings';
import { S2MapHeader } from '../../entity/S2MapHeader';
import { BnAccount } from '../../entity/BnAccount';
import { PlayerProfileParams } from '../../bnet/common';

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

function getEffectiveAccountPreferences(account: BnAccount | null, profile?: S2Profile): Required<UserPrivacyPreferences> {
    let defaultPreferences: Required<UserPrivacyPreferences> = Object.assign({}, defaultAccountSettings);

    if (profile && !(profile.name === 'blizzmaps' && profile.discriminator === 1)) {
        // restrict access to maps on profiles where author has been active in last X months
        if (profile.lastOnlineAt! > subMonths(new Date(), 1)) {
            defaultPreferences.mapPrivDetails = false;
        }
        if (profile.lastOnlineAt! > subMonths(new Date(), 9)) {
            defaultPreferences.mapPrivDownload = false;
            defaultPreferences.mapPrivListed = false;
        }
    }

    const preferences: Required<UserPrivacyPreferences> = {} as any;
    for (const key of Object.keys(defaultPreferences)) {
        if (account?.settings && (account.settings as any)[key] !== null) {
            (preferences as any)[key] = (account.settings as any)[key];
        }
        else {
            (preferences as any)[key] = (defaultPreferences as any)[key];
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
            .leftJoinAndSelect('profile.account', 'bnAccount')
            .leftJoinAndSelect('bnAccount.settings', 'bnSettings')
        ;

        if (mapOrHeader instanceof S2Map && mapOrHeader.author?.id) {
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
            if (userAccount && userAccount.privileges & AccountPrivileges.SuperAdmin) {
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

            const preferences = getEffectiveAccountPreferences(authorProfile?.account ?? null, authorProfile);

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

    async isProfileAccessGranted(kind: ProfileAccessAttributes, profile: S2Profile | PlayerProfileParams, userAccount?: AppAccount): Promise<boolean> {
        let profileAccount: BnAccount | null = null;

        if (profile instanceof S2Profile) {
            profileAccount = profile.account;
        }
        else {
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
            profileAccount = result?.account ?? null;
        }

        if (userAccount && userAccount.privileges & AccountPrivileges.SuperAdmin) {
            return true;
        }

        // allow access to author's own content
        if (userAccount && userAccount.bnAccountId === profileAccount?.id) {
            return true;
        }

        const preferences = getEffectiveAccountPreferences(profileAccount, profile instanceof S2Profile ? profile : void 0);

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
