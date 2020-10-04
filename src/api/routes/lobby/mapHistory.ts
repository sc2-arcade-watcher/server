import fp from 'fastify-plugin';
import { GameLobbyStatus } from '../../../gametracker';
import { S2GameLobby } from '../../../entity/S2GameLobby';
import { S2GameLobbyRepository } from '../../../repository/S2GameLobbyRepository';
import { S2GameLobbyMap } from '../../../entity/S2GameLobbyMap';
import { stripIndents } from 'common-tags';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/lobbies/history/map/:regionId/:mapId', {
        schema: {
            tags: ['Lobbies'],
            summary: 'History of hosted lobbies of a specific map or mod.',
            description: stripIndents`
                NOTICE: This endpoint is not yet stable and might be changed in the future.
            `,
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
                    status: {
                        type: 'string',
                        enum: [
                            ...Object.values(GameLobbyStatus),
                            'any',
                        ],
                    },
                },
            },
        },
    }, async (request, reply) => {
        const pQuery = request.parseCursorPagination({
            paginationKeys: ['lobby.id'],
        });

        const qb = server.conn.getRepository(S2GameLobby)
            .createQueryBuilder('lobby')
            .innerJoin(S2GameLobbyMap, 'lmap', 'lmap.lobby = lobby.id AND lmap.regionId = :regionId AND lmap.bnetId = :bnetId', {
                regionId: request.params.regionId,
                bnetId: request.params.mapId,
            })
            .select(pQuery.paginationKeys)
            .limit(pQuery.fetchLimit)
        ;

        if (request.query.status && request.query.status !== 'any') {
            qb.andWhere('lobby.status = :status', { status: request.query.status });
        }
        else {
            qb.andWhere('lobby.status IN (:status)', {
                status: [ GameLobbyStatus.Started, GameLobbyStatus.Abandoned, GameLobbyStatus.Unknown ],
            });
        }

        pQuery.applyQuery(qb, request.query.orderDirection!.toUpperCase());

        const lbIds = await qb.getRawMany();

        const qbFinal = server.conn.getCustomRepository(S2GameLobbyRepository).createQueryForEntriesInIds(
            lbIds.length ? lbIds.map(x => x.lobby_id) : [0],
            pQuery.getOrderDirection(request.query.orderDirection!.toUpperCase())
        );

        return reply.type('application/json').code(200).sendWithCursorPagination({
            raw: lbIds,
            entities: (await qbFinal.getRawAndEntities()).entities,
        }, pQuery);
    });
});
