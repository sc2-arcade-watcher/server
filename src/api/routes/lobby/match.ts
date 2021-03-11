import fp from 'fastify-plugin';
import { S2GameLobby } from '../../../entity/S2GameLobby';
import { S2LobbyMatch } from '../../../entity/S2LobbyMatch';
import { S2LobbyMatchProfile } from '../../../entity/S2LobbyMatchProfile';
import { S2ProfileMatch } from '../../../entity/S2ProfileMatch';
import { S2Profile } from '../../../entity/S2Profile';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/lobbies/:regionId/:bnetBucketId/:bnetRecordId/match', {
        schema: {
            tags: ['Lobbies'],
            params: {
                type: 'object',
                required: ['regionId', 'bnetBucketId', 'bnetRecordId'],
                properties: {
                    regionId: {
                        type: 'number',
                    },
                    bnetBucketId: {
                        type: 'number',
                    },
                    bnetRecordId: {
                        type: 'number',
                    },
                }
            },
        },
    }, async (request, reply) => {
        const sqbLobbyId = server.conn.createQueryBuilder().subQuery()
            .from(S2GameLobby, 'lobby')
            .select('lobby.id')
            .andWhere('lobby.bnetBucketId = :bnetBucketId AND lobby.bnetRecordId = :bnetRecordId')
            .limit(1)
            .getQuery()
        ;

        const qb = server.conn.getRepository(S2LobbyMatch)
            .createQueryBuilder('lobMatch')
            .leftJoin(
                S2LobbyMatchProfile,
                'lobMatchProf',
                'lobMatch.lobbyId IS NOT NULL AND lobMatch.lobbyId = lobMatchProf.lobbyId AND lobMatch.result = 0'
            )
            .leftJoinAndMapMany('lobMatch.profileMatches', S2ProfileMatch, 'profMatch', 'profMatch.id = lobMatchProf.profileMatch')
            .leftJoinAndMapOne(
                'profMatch.profile',
                S2Profile,
                'pmProfile',
                'pmProfile.regionId = profMatch.regionId AND pmProfile.localProfileId = profMatch.localProfileId'
            )
            .select([
                'lobMatch.result',
                'lobMatch.completedAt',
                'profMatch.decision',
                'pmProfile.regionId',
                'pmProfile.realmId',
                'pmProfile.profileId',
                'pmProfile.name',
                'pmProfile.discriminator',
                'pmProfile.avatar',
            ])
            .andWhere('lobMatch.lobby = ' + sqbLobbyId, {
                bnetBucketId: request.params.bnetBucketId,
                bnetRecordId: request.params.bnetRecordId,
            })
        ;

        const result = await qb.getOne();
        if (!result) {
            return reply.code(404).send();
        }

        return reply.send(result);
    });
});
