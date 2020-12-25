import fp from 'fastify-plugin';
import { S2ProfileMatch } from '../../../entity/S2ProfileMatch';
import { S2Profile } from '../../../entity/S2Profile';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/maps/:regionId/:mapId/match-history', {
        schema: {
            hide: true,
            tags: ['Maps'],
            params: {
                type: 'object',
                required: ['regionId', 'mapId'],
                properties: {
                    regionId: {
                        type: 'number',
                    },
                    mapId: {
                        type: 'number',
                    },
                },
            },
            querystring: {
                orderBy: {
                    type: 'string',
                    enum: [
                        'id',
                        'date',
                    ],
                    default: 'date',
                },
                orderDirection: {
                    type: 'string',
                    enum: [
                        'asc',
                        'desc',
                    ],
                    default: 'desc',
                },
            },
        }
    }, async (request, reply) => {
        let orderByKey: string | string[];
        switch (request.query.orderBy) {
            case 'id':
            case 'date': {
                orderByKey = `profMatch.${request.query.orderBy}`;
                break;
            }
            default: {
                return reply.code(400).send();
            }
        }

        const pQuery = request.parseCursorPagination({
            paginationKeys: orderByKey,
        });

        const qb = server.conn.getRepository(S2ProfileMatch)
            .createQueryBuilder('profMatch')
            .innerJoinAndMapOne(
                'profMatch.profile',
                S2Profile,
                'profile',
                'profile.regionId = profMatch.regionId AND profile.localProfileId = profMatch.localProfileId'
            )
            .select([
                'profMatch.date',
                'profMatch.type',
                'profMatch.decision',
                'profile.regionId',
                'profile.realmId',
                'profile.profileId',
                'profile.name',
                'profile.discriminator',
                'profile.avatar',
            ])
            .andWhere('profMatch.regionId = :regionId AND profMatch.mapId = :mapId', {
                regionId: request.params.regionId,
                mapId: request.params.mapId,
            })
        ;

        qb.limit(pQuery.fetchLimit);
        pQuery.applyQuery(qb, request.query.orderDirection!.toUpperCase());

        reply.header('Cache-control', 'public, s-maxage=60');
        const results = await qb.getRawAndEntities();
        return reply.code(200).sendWithCursorPagination(results, pQuery);
    });
});
