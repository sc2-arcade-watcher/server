import * as orm from 'typeorm';
import * as http from 'http';
import * as fp from 'fastify-plugin';
import { AppAccount } from '../../entity/AppAccount';
import { S2Map } from '../../entity/S2Map';
import { S2Profile } from '../../entity/S2Profile';
import { logger, logIt } from '../../logger';
import { defaultAccountSettings, MapAuthorPreferences } from '../../entity/BnAccountSettings';

// TODO: temporary restrictive settings, to be replaced with `defaultAccountSettings`
export const publicAccountSettings: Required<MapAuthorPreferences> = {
    mapPubDownload: true,
    mapPrivDownload: false,
    mapPrivDetails: false,
    mapPrivListed: false,
};

export enum MapAccessAttributes {
    Details,
    Download,
}

export enum ProfileAccessAttributes {
    PrivateMapList,
}

interface IAccessManager {
    isMapAccessGranted(kind: MapAccessAttributes, map: S2Map, userAccount?: AppAccount): Promise<boolean>;
    isMapAccessGranted(kind: MapAccessAttributes[], map: S2Map, userAccount?: AppAccount): Promise<boolean[]>;
}

class AccessManager implements IAccessManager {
    constructor (protected conn: orm.Connection) {
    }

    // @ts-ignore
    async isMapAccessGranted(kind: MapAccessAttributes | MapAccessAttributes[], map: S2Map, userAccount?: AppAccount) {
        const isMapPublic = map.currentVersion.isPrivate === false;

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

        if (map.author) {
            qb.andWhere('profile.id = :pid', { pid: map.author.id });
        }
        else if (map.id) {
            const mapAuthorQuery = qb.subQuery().select()
                .from(S2Map, 'map')
                .select('map.author')
                .andWhere('map.id = :mid')
                .limit(1)
                .getQuery()
            ;
            qb.andWhere('profile.id = ' + mapAuthorQuery, { mid: map.id })
        }
        else if (map.regionId && map.bnetId) {
            const mapAuthorQuery = qb.subQuery().select()
                .from(S2Map, 'map')
                .select('map.author')
                .andWhere('map.regionId = :regionId AND map.bnetId = :bnetId')
                .limit(1)
                .getQuery()
            ;
            qb.andWhere('profile.id = ' + mapAuthorQuery, { regionId: map.regionId, bnetId: map.bnetId })
        }
        else {
            throw new Error(`isMapAccessGranted, missing map params`);
        }

        // TODO: cache the result
        let authorProfile = await qb.getOne();

        const results: boolean[] = [];
        const kinds = Array.isArray(kind) ? kind : [kind];
        for (const currKind of kinds) {
            if (!authorProfile) {
                logger.warn(`couldn't fetch authorProfile of ${map.currentVersion.linkVer}`);
                results.push(false);
                continue;
            }

            // allow access to author's own content
            if (userAccount && userAccount.id === authorProfile?.account?.id) {
                results.push(true);
                continue;
            }

            // try to get configured prefs and fallback to defaults
            const authorSettings = authorProfile?.account?.settings ?? publicAccountSettings;

            switch (currKind) {
                case MapAccessAttributes.Details: {
                    results.push(isMapPublic ? true : authorSettings.mapPrivDetails);
                    break;
                }

                case MapAccessAttributes.Download: {
                    results.push(isMapPublic ? authorSettings.mapPubDownload : authorSettings.mapPrivDownload);
                    break;
                }
            }
        }

        return Array.isArray(kind) ? results : results.shift();
    }
}

declare module 'fastify' {
    export interface FastifyInstance<
    HttpServer = http.Server,
    HttpRequest = http.IncomingMessage,
    HttpResponse = http.ServerResponse
    > {
        accessManager: IAccessManager;
    }
}

export default fp(async (server, opts, next) => {
    server.decorate('accessManager', new AccessManager(server.conn));
});
