import fp from 'fastify-plugin';
import { S2GameLobbySlot } from '../../../entity/S2GameLobbySlot';
import { S2GameLobbyRepository } from '../../../repository/S2GameLobbyRepository';
import { stripIndents } from 'common-tags';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/lobbies/history/player/:regionId/:realmId/:profileId', {
        schema: {
            tags: ['Lobbies'],
            summary: 'History of started lobbies where given player was present. Basically a "match history", limited to public games.',
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
                }
            },
            querystring: {
                type: 'object',
                properties: {
                    orderDirection: {
                        type: 'string',
                        enum: [
                            'asc',
                            'desc',
                        ],
                        default: 'desc',
                    },
                },
            },
        },
    }, async (request, reply) => {
        const pQuery = request.parseCursorPagination();

        const qb = server.conn.getRepository(S2GameLobbySlot)
            .createQueryBuilder('slot')
            .select([])
            .addSelect('slot.lobbyId', 'lobby_id')
            .innerJoin('slot.profile', 'profile')
            .andWhere('profile.regionId = :regionId AND profile.realmId = :realmId AND profile.profileId = :profileId', {
                regionId: request.params.regionId,
                realmId: request.params.realmId,
                profileId: request.params.profileId,
            })
            .limit(pQuery.fetchLimit)
        ;

        const sorder = pQuery.getOrderDirection(request.query.orderDirection?.toUpperCase());
        if (pQuery.before && sorder === 'ASC') {
            qb.andWhere(`slot.lobbyId < :id`, pQuery.before);
        }
        else if (pQuery.before && sorder === 'DESC') {
            qb.andWhere(`slot.lobbyId > :id`, pQuery.before);
        }
        else if (pQuery.after && sorder === 'ASC') {
            qb.andWhere(`slot.lobbyId > :id`, pQuery.after);
        }
        else if (pQuery.after && sorder === 'DESC') {
            qb.andWhere(`slot.lobbyId < :id`, pQuery.after);
        }
        qb.addOrderBy('slot.lobbyId', sorder);

        const lbIds = await qb.getRawMany();
        const qbFinal = server.conn.getCustomRepository(S2GameLobbyRepository).createQueryForEntriesInIds(
            lbIds.length ? lbIds.map(x => x.lobby_id) : [0],
            sorder
        );

        return reply.type('application/json').code(200).sendWithCursorPagination(await qbFinal.getRawAndEntities(), pQuery);
    });
});
