import * as fp from 'fastify-plugin';
import { S2Map } from '../../../entity/S2Map';

export default fp(async (server, opts, next) => {
    server.get('/maps/:regionId/:mapId', {
        schema: {
            tags: ['Maps'],
            summary: 'Basic info about specific map',
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
        },
    }, async (request, reply) => {
        const result = await server.conn.getRepository(S2Map)
            .createQueryBuilder('map')
            .leftJoinAndSelect('map.currentVersion', 'mapHead')
            .andWhere('map.regionId = :regionId AND map.bnetId = :bnetId', {
                regionId: request.params.regionId,
                bnetId: request.params.mapId,
            })
            .getOne()
        ;

        if (!result) {
            return reply.type('application/json').code(404).send();
        }

        reply.header('Cache-control', 'public, s-maxage=60');
        return reply.type('application/json').code(200).send(result);
    });
});
