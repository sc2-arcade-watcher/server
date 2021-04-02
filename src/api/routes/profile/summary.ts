import fp from 'fastify-plugin';
import { S2Profile } from '../../../entity/S2Profile';
import { ProfileAccessAttributes } from '../../plugins/accessManager';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/profiles/:regionId/:realmId/:profileId/summary', {
        schema: {
            hide: true,
            tags: ['Profiles'],
            summary: 'Profile summary',
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
                'profile.profileGameId',
                'profile.battleTag',
                'profile.lastOnlineAt',
            ])
            .andWhere('profile.regionId = :regionId AND profile.realmId = :realmId AND profile.profileId = :profileId', {
                regionId: request.params.regionId,
                realmId: request.params.realmId,
                profileId: request.params.profileId,
            })
            .limit(1)
            .getOne()
        ;

        if (!profile) {
            return reply.code(404).send();
        }

        const canAccessDetails = await server.accessManager.isProfileAccessGranted(
            ProfileAccessAttributes.Details,
            profile,
            request.userAccount
        );
        if (!canAccessDetails) {
            return reply.code(403).send();
        }

        reply.header('Cache-control', 'private, max-age=60');
        return reply.code(200).send({
            profile: profile,
        });
    });
});
