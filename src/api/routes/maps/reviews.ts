import fp from 'fastify-plugin';
import { S2MapReview } from '../../../entity/S2MapReview';
import { S2Profile } from '../../../entity/S2Profile';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/maps/:regionId/:mapId/reviews', {
        schema: {
            tags: ['Maps'],
            summary: `User reviews`,
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
                orderDirection: {
                    type: 'string',
                    enum: [
                        'asc',
                        'desc',
                    ],
                    default: 'desc',
                },
                orderBy: {
                    type: 'string',
                    enum: [
                        'updated',
                        'rating',
                        'helpful',
                    ],
                    default: 'updated',
                },
            },
        },
    }, async (request, reply) => {
        let orderByKey: string;
        switch (request.query.orderBy) {
            case 'updated': {
                orderByKey = 'review.updatedAt';
                break;
            }
            case 'rating': {
                orderByKey = 'review.rating';
                break;
            }
            case 'helpful': {
                orderByKey = 'review.helpfulCount';
                break;
            }
            default: {
                orderByKey = 'review.id';
                break;
            }
        }
        const pQuery = request.parseCursorPagination({
            paginationKeys: orderByKey,
        });

        const qb = server.conn.getRepository(S2MapReview)
            .createQueryBuilder('review')
            .leftJoinAndMapOne('review.author', S2Profile, 'author', 'review.regionId = author.regionId AND review.authorLocalProfileId = author.localProfileId')
            .select([
                'review.createdAt',
                'review.updatedAt',
                'review.rating',
                'review.helpfulCount',
                'review.body',
                'author.regionId',
                'author.realmId',
                'author.profileId',
                'author.name',
                'author.discriminator',
                'author.avatar',
            ])
            .andWhere('review.regionId = :regionId AND review.mapId = :mapId', {
                regionId: request.params.regionId,
                mapId: request.params.mapId,
            })
            .limit(pQuery.fetchLimit)
        ;

        pQuery.applyQuery(qb, request.query.orderDirection?.toUpperCase());

        reply.header('Cache-control', 'public, s-maxage=60');
        return reply.code(200).sendWithCursorPagination(await qb.getRawAndEntities(), pQuery);
    });
});
