import * as fp from 'fastify-plugin';
import { S2Profile } from '../../../entity/S2Profile';

export default fp(async (server, opts, next) => {
    server.get('/profiles/:regionId/:realmId/:profileId', {
        schema: {
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
        },
    }, async (request, reply) => {
        const profile = await server.conn.getRepository(S2Profile)
            .createQueryBuilder('profile')
            .andWhere('profile.regionId = :regionId AND profile.realmId = :realmId AND profile.profileId = :profileId', {
                regionId: request.params.regionId,
                realmId: request.params.realmId,
                profileId: request.params.profileId,
            })
            .getOne()
        ;

        if (!profile) {
            return reply.code(404).send();
        }

        reply.header('Cache-control', 'public, max-age=60');
        return reply.type('application/json').code(200).send(profile);
    });
});
