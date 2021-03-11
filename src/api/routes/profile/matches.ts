import fp from 'fastify-plugin';
import { S2ProfileMatch } from '../../../entity/S2ProfileMatch';
import { S2Map } from '../../../entity/S2Map';
import { ProfileAccessAttributes } from '../../plugins/accessManager';
import { localProfileId, GameLocale, GameLocaleFlag, GameLocaleType } from '../../../common';
import { PlayerProfileParams } from '../../../bnet/common';
import { S2ProfileMatchMapName } from '../../../entity/S2ProfileMatchMapName';
import { S2GameLobby } from '../../../entity/S2GameLobby';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/profiles/:regionId/:realmId/:profileId/matches', {
        schema: {
            hide: true,
            tags: ['Profiles'],
            summary: 'Profile match history',
            params: {
                type: 'object',
                required: ['regionId', 'realmId', 'profileId'],
                properties: {
                    regionId: {
                        type: 'number',
                    },
                    realmId: {
                        type: 'number',
                    },
                    profileId: {
                        type: 'number',
                    },
                },
            },
            querystring: {
                orderDirection: {
                    type: 'string',
                    enum: [
                        'asc',
                        'desc',
                    ],
                    default: 'desc',
                },
            },
        },
    }, async (request, reply) => {
        const pQuery = request.parseCursorPagination({
            paginationKeys: ['profMatch.id'],
        });

        const profileParams: PlayerProfileParams = {
            regionId: request.params.regionId,
            realmId: request.params.realmId,
            profileId: request.params.profileId,
        };
        const canAccessDetails = await server.accessManager.isProfileAccessGranted(
            ProfileAccessAttributes.Details,
            profileParams,
            request.userAccount
        );
        if (!canAccessDetails) {
            return reply.code(403).send();
        }

        const qb = server.conn.getRepository(S2ProfileMatch)
            .createQueryBuilder('profMatch')
            .leftJoinAndMapOne('profMatch.map', S2Map, 'map', 'map.regionId = profMatch.regionId AND map.bnetId = profMatch.mapId')
            .leftJoin('profMatch.lobbyMatchProfile', 'lobMatchProf')
            .leftJoinAndMapOne('profMatch.lobby', S2GameLobby, 'lobby', 'lobby.id = lobMatchProf.lobbyId')
            .select([
                'profMatch.id',
                'profMatch.date',
                'profMatch.type',
                'profMatch.decision',
                'map.regionId',
                'map.bnetId',
                'map.name',
                'map.iconHash',
                'lobby.regionId',
                'lobby.bnetBucketId',
                'lobby.bnetRecordId',
                'lobby.createdAt',
                'lobby.closedAt',
                'lobby.slotsHumansTaken',
            ])
            .andWhere('profMatch.regionId = :regionId AND profMatch.localProfileId = :localProfileId', {
                regionId: request.params.regionId,
                localProfileId: localProfileId(profileParams),
            })
        ;

        qb.limit(pQuery.fetchLimit);
        pQuery.applyQuery(qb, request.query.orderDirection!.toUpperCase());

        reply.header('Cache-control', 'private, max-age=60');
        const results = await qb.getRawAndEntities();

        const unknownMaps = new Map(
            Array.from(results.entities.entries())
            .filter(x => x[1].map === null)
            .map(x => [x[1].id, x[0]])
        );
        if (unknownMaps.size) {
            const matchMapNames = await server.conn.getRepository(S2ProfileMatchMapName)
                .createQueryBuilder('matchMapName')
                .andWhere('matchMapName.match IN (:matchIds)', {
                    matchIds: Array.from(unknownMaps.keys()),
                })
                .getMany()
            ;
            for (const item of matchMapNames) {
                const rIdx = unknownMaps.get(item.matchId);
                const profMatchItem = results.entities[rIdx];
                if (typeof profMatchItem.mapNames === 'undefined') {
                    profMatchItem.mapNames = {} as any;
                    for (const x of Object.values(GameLocale)) {
                        profMatchItem.mapNames[x] = void 0;
                    }
                }
                for (const localeFlag of Object.values(GameLocaleFlag)) {
                    if (typeof localeFlag !== 'number') continue;
                    if (item.locales & localeFlag) {
                        profMatchItem.mapNames[GameLocaleFlag[localeFlag] as GameLocaleType] = item.name;
                    }
                }
            }
        }

        return reply.code(200).sendWithCursorPagination(results, pQuery);
    });
});
