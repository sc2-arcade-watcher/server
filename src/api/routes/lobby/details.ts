import fp from 'fastify-plugin';
import { S2GameLobbyRepository } from '../../../repository/S2GameLobbyRepository';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/lobbies/:regionId/:bnetBucketId/:bnetRecordId', {
        schema: {
            tags: ['Lobbies'],
            summary: 'Lobby details',
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
        const lobbyRepo = server.conn.getCustomRepository(S2GameLobbyRepository);
        const qb = lobbyRepo
            .createQueryBuilder('lobby')
            .andWhere('lobby.regionId = :regionId AND lobby.bnetBucketId = :bnetBucketId AND lobby.bnetRecordId = :bnetRecordId', {
                regionId: request.params.regionId,
                bnetBucketId: request.params.bnetBucketId,
                bnetRecordId: request.params.bnetRecordId,
            })
        ;

        lobbyRepo.addMapInfo(qb, true);
        lobbyRepo.addSlots(qb);
        lobbyRepo.addSlotsProfile(qb);
        lobbyRepo.addSlotsJoinInfo(qb);
        lobbyRepo.addJoinHistory(qb);
        lobbyRepo.addTitleHistory(qb);
        // lobbyRepo.addMatchResult(qb);

        qb.addSelect([
            'profile.avatar',
            'joinHistoryProfile.avatar',
            'titleHistoryProfile.avatar',
            'map.updatedAt',
            'extMod.updatedAt',
            'multiMod.updatedAt',
        ]);

        qb.addSelect([
            'lobby.regionId',
            'lobby.bnetBucketId',
            'lobby.bnetRecordId',
            'lobby.mapBnetId',
            'lobby.extModBnetId',
            'lobby.multiModBnetId',
            'lobby.createdAt',
            'lobby.closedAt',
            'lobby.status',
            'lobby.mapVariantIndex',
            'lobby.mapVariantMode',
            'lobby.lobbyTitle',
            'lobby.hostName',
            'lobby.slotsUpdatedAt',
            // these below might be removed in the future
            'lobby.slotsHumansTaken',
            'lobby.slotsHumansTotal',
            'lobby.snapshotUpdatedAt',
        ]);

        qb.addOrderBy('slot.slotNumber', 'ASC');
        qb.addOrderBy('joinHistory.id', 'ASC');

        const result = await qb.getOne();
        if (!result) {
            return reply.type('application/json').code(404).send();
        }

        return reply.type('application/json').send(result);
    });
});
