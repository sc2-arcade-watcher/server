import fp from 'fastify-plugin';
import { S2ProfileMatch } from '../../../entity/S2ProfileMatch';
import { S2Map } from '../../../entity/S2Map';
import { ProfileAccessAttributes } from '../../plugins/accessManager';
import { localProfileId, GameLocale } from '../../../common';
import { PlayerProfileParams } from '../../../bnet/common';

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
            .leftJoinAndSelect('profMatch.names', 'mapNames', 'profMatch.mapId = 0 AND mapNames.locale = :mainLocale', {
                mainLocale: GameLocale.enUS,
            })
            .select([
                'profMatch.id',
                'profMatch.date',
                'profMatch.type',
                'profMatch.decision',
                'map.regionId',
                'map.bnetId',
                'map.name',
                'map.iconHash',
                'mapNames.locale',
                'mapNames.name',
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
        return reply.code(200).sendWithCursorPagination(results, pQuery);
    });
});
