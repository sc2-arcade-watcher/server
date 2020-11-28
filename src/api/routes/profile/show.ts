import fp from 'fastify-plugin';
import { S2Profile } from '../../../entity/S2Profile';
import { stripIndents } from 'common-tags';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/profiles/:regionId/:realmId/:profileId', {
        schema: {
            tags: ['Profiles'],
            summary: 'Info about player profile',
            description: stripIndents`
                NOTICE: This endpoint is not yet stable and might be changed in the future.
            `,
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
            .select([
                'profile.regionId',
                'profile.realmId',
                'profile.profileId',
                'profile.name',
                'profile.discriminator',
                'profile.avatar',
                'profile.lastOnlineAt',
            ])
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
        return reply.code(200).send(profile);
    });
});
