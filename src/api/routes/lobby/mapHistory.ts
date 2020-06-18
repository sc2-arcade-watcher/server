import * as fp from 'fastify-plugin';
import { S2GameLobby } from '../../../entity/S2GameLobby';
import { GameLobbyStatus } from '../../../gametracker';

export default fp(async (server, opts, next) => {
    server.get('/lobbies/history/map/:regionId/:mapId', {
        schema: {
            tags: ['Lobbies'],
            summary: 'History of hosted lobbies of a specific map',
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
                            'any',
                            'open',
                            'started',
                            'abandoned',
                            'unknown',
                        ],
                        default: 'any',
                    },
                },
            },
        },
    }, async (request, reply) => {
        const { limit, offset } = request.parsePagination();

        const qb = server.conn.getRepository(S2GameLobby)
            .createQueryBuilder('lobby')
            .select([
                'lobby.bnetBucketId',
                'lobby.bnetRecordId',
                'lobby.status',
                'lobby.closedAt',
            ])
            .andWhere('lobby.regionId = :regionId', { regionId: request.params.regionId })
            .andWhere('lobby.mapBnetId = :bnetId', { bnetId: request.params.mapId })
        ;
        if (request.query.status && request.query.status !== 'any') {
            qb.andWhere('lobby.status = :status', { status: request.query.status });
        }
        else {
            qb.andWhere('lobby.status IN (:status)', {
                status: [ GameLobbyStatus.Started, GameLobbyStatus.Abandoned, GameLobbyStatus.Unknown ],
            });
        }
        const [ result, count ] = await qb
            .addOrderBy('lobby.id', request.query.orderDirection?.toUpperCase() ?? 'DESC')
            // .limit(limit)
            // .offset(offset)
            .take(limit)
            .skip(offset)
            .cache(60000)
            .getManyAndCount()
        ;

        reply.header('Cache-control', 'public, s-maxage=60');
        return reply.type('application/json').code(200).sendWithPagination({ count: count, page: result });
    });
});
