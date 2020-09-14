import * as fp from 'fastify-plugin';
import { S2Profile } from '../../../entity/S2Profile';

export default fp(async (server, opts, next) => {
    server.get('/profiles/:regionId/:mapId', {
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
        const profile = await server.conn.getRepository(S2Profile)
            .createQueryBuilder('profile')
            .andWhere('map.regionId = :regionId AND map.bnetId = :bnetId', {
                regionId: request.params.regionId,
                realmId: request.params.realmId,
                profileId: request.params.profileId,
            })
            .getOne()
        ;

        reply.header('Cache-control', 'public, max-age=60, s-maxage=60');
        return reply.type('application/json').code(200).send(profile);
    });
});
