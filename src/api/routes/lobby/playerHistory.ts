import * as fp from 'fastify-plugin';
import { S2GameLobby } from '../../../entity/S2GameLobby';
import { GameLobbyStatus } from '../../../gametracker';
import { logger } from '../../../logger';

export default fp(async (server, opts, next) => {
    server.get('/lobbies/history/player/:regionId/:realmId/:profileId', {
        schema: {
            tags: ['Lobbies'],
            summary: 'History of started lobbies where particular player has appeared. Basically a "match history", limited to public games.',
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
        const { limit, offset } = request.parsePagination();

        logger.verbose(`orderDirection`, request.query);

        const [ result, count ] = await server.conn.getRepository(S2GameLobby)
            .createQueryBuilder('lobby')
            .innerJoin('lobby.slots', 'slot')
            .innerJoin('slot.profile', 'profile')
            .select([
                'lobby.bnetBucketId',
                'lobby.bnetRecordId',
                'lobby.status',
                'lobby.closedAt',
            ])
            .andWhere('profile.regionId = :regionId AND profile.realmId = :realmId AND profile.profileId = :profileId', {
                regionId: request.params.regionId,
                realmId: request.params.realmId,
                profileId: request.params.profileId,
            })
            .andWhere('lobby.status = :status', { status: GameLobbyStatus.Started })
            .addOrderBy('lobby.id', request.query.orderDirection?.toUpperCase() ?? 'DESC')
            .limit(limit)
            .offset(offset)
            // .take(limit)
            // .skip(offset)
            .cache(60000)
            .getManyAndCount()
        ;

        reply.header('Cache-control', 'public, s-maxage=60');
        return reply.type('application/json').code(200).sendWithPagination({ count: count, page: result });
    });
});
