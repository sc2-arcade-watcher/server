import fp from 'fastify-plugin';
import { S2Profile } from '../../../entity/S2Profile';
import { S2ProfileMatch } from '../../../entity/S2ProfileMatch';
import { S2Map } from '../../../entity/S2Map';
import { ProfileAccessAttributes } from '../../plugins/accessManager';

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

        const canAccessDetails = await server.accessManager.isProfileAccessGranted(
            ProfileAccessAttributes.Details,
            {
                regionId: request.params.regionId,
                realmId: request.params.realmId,
                profileId: request.params.profileId,
            },
            request.userAccount
        );
        if (!canAccessDetails) {
            return reply.code(403).send();
        }

        const qb = server.conn.getRepository(S2ProfileMatch)
            .createQueryBuilder('profMatch')
            .leftJoinAndMapOne('profMatch.map', S2Map, 'map', 'map.regionId = profMatch.regionId AND map.bnetId = profMatch.mapId')
            .select([
                'profMatch.id',
                'profMatch.date',
                'profMatch.type',
                'profMatch.decision',
                'map.regionId',
                'map.bnetId',
                'map.name',
                'map.iconHash',
            ])
            .andWhere('profMatch.mapId != 0')
            .andWhere('profMatch.regionId = :regionId AND profMatch.realmId = :realmId AND profMatch.profileId = :profileId', {
                regionId: request.params.regionId,
                realmId: request.params.realmId,
                profileId: request.params.profileId,
            })
        ;

        qb.limit(pQuery.fetchLimit);
        pQuery.applyQuery(qb, request.query.orderDirection!.toUpperCase());

        reply.header('Cache-control', 'private, max-age=60');
        const results = await qb.getRawAndEntities();
        return reply.code(200).sendWithCursorPagination(results, pQuery);
    });
});