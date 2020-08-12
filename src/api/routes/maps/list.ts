import * as fp from 'fastify-plugin';
import { S2Map, S2MapType } from '../../../entity/S2Map';

export default fp(async (server, opts, next) => {
    server.get('/maps', {
        schema: {
            tags: ['Maps'],
            summary: 'List of maps',
            querystring: {
                type: 'object',
                properties: {
                    regionId: {
                        type: 'number',
                    },
                    name: {
                        type: 'string',
                    },
                    type: {
                        type: 'string',
                        enum: Object.values(S2MapType),
                    },
                }
            },
        },
    }, async (request, reply) => {
        const { limit, offset } = request.parsePagination();

        const qb = server.conn.getRepository(S2Map)
            .createQueryBuilder('map')
            .select([
                'map.regionId',
                'map.bnetId',
                'map.type',
                'map.name',
                'map.description',
                'map.iconHash',
                'map.mainCategoryId',
            ])
            .take(limit)
            .skip(offset)
        ;

        if (request.query.name !== void 0) {
            qb.andWhere('map.name LIKE :name', { name: '%' + request.query.name + '%' });
        }
        if (request.query.type !== void 0) {
            qb.andWhere('map.type = :type', { type: request.query.type });
        }
        if (request.query.regionId !== void 0) {
            qb.andWhere('map.regionId = :regionId', { regionId: request.query.regionId });
        }

        const [ result, count ] = await qb.getManyAndCount();

        reply.header('Cache-control', 'public, s-maxage=60');
        return reply.type('application/json').code(200).sendWithPagination({ count: count, page: result });
    });
});
