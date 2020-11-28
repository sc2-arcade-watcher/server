import fp from 'fastify-plugin';
import { S2Profile } from '../../../entity/S2Profile';
import { ProfileAccessAttributes } from '../../plugins/accessManager';
import { S2StatsPlayerMap } from '../../../entity/S2StatsPlayerMap';
import { S2Map } from '../../../entity/S2Map';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/profiles/:regionId/:realmId/:profileId/most-played', {
        schema: {
            hide: true,
            tags: ['Profiles'],
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
        const profile = await server.conn.getRepository(S2Profile).findOne({
            where: {
                regionId: request.params.regionId,
                realmId: request.params.realmId,
                profileId: request.params.profileId,
            },
        });

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

        const mapStats = await server.conn.getRepository(S2StatsPlayerMap).createQueryBuilder('statPlayer')
            .innerJoinAndMapOne('statPlayer.map', S2Map, 'map', 'map.regionId = statPlayer.regionId AND map.bnetId = statPlayer.mapId')
            .select([
                'statPlayer.lobbiesStarted',
                'statPlayer.lobbiesStartedDiffDays',
                'statPlayer.lobbiesJoined',
                'statPlayer.lobbiesHosted',
                'statPlayer.lobbiesHostedStarted',
                'statPlayer.timeSpentWaiting',
                'statPlayer.timeSpentWaitingAsHost',
                'statPlayer.lastPlayedAt',
            ])
            .addSelect([
                'map.regionId',
                'map.bnetId',
                'map.name',
                'map.iconHash',
                'map.mainCategoryId',
            ])
            .andWhere('statPlayer.regionId = :regionId AND statPlayer.realmId = :realmId AND statPlayer.profileId = :profileId', {
                regionId: request.params.regionId,
                realmId: request.params.realmId,
                profileId: request.params.profileId,
            })
            .addOrderBy('statPlayer.lobbiesStarted', 'DESC')
            .getMany()
        ;

        reply.header('Cache-control', 'private, max-age=60');
        return reply.code(200).send(mapStats);
    });
});
