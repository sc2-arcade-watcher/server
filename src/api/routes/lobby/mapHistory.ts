import * as fp from 'fastify-plugin';
import { GameLobbyStatus } from '../../../gametracker';
import { S2GameLobby } from '../../../entity/S2GameLobby';

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
        const pQuery = request.parseCursorPagination();

        const qb = server.conn.getRepository(S2GameLobby)
            .createQueryBuilder('lobby')
            .select(['lobby.id'])
            // .addSelect(qb => {
            //     return qb.subQuery().from(S2GameLobbySlot, 'slot').select('COUNT(slot.id)').where('slot.lobby = lobby.id AND slot.kind = \'human\'');
            // }, 'slotsHumanCount')
            // .addSelect(qb => {
            //     return qb.subQuery().from(S2GameLobbySlot, 'slot').select('COUNT(slot.id)').where('slot.lobby = lobby.id');
            // }, 'slotsTotalCount')
            .limit(pQuery.fetchLimit)
        ;

        const sorder = pQuery.getOrderDirection(request.query.orderDirection?.toUpperCase());
        if (pQuery.before && sorder === 'ASC') {
            qb.andWhere(`lobby.id < :id`, pQuery.before);
        }
        else if (pQuery.before && sorder === 'DESC') {
            qb.andWhere(`lobby.id > :id`, pQuery.before);
        }
        else if (pQuery.after && sorder === 'ASC') {
            qb.andWhere(`lobby.id > :id`, pQuery.after);
        }
        else if (pQuery.after && sorder === 'DESC') {
            qb.andWhere(`lobby.id < :id`, pQuery.after);
        }
        qb.addOrderBy('lobby.id', sorder);

        qb
            .andWhere('lobby.regionId = :regionId AND lobby.mapBnetId = :bnetId', {
                regionId: request.params.regionId,
                bnetId: request.params.mapId,
            })
        ;

        if (request.query.status && request.query.status !== 'any') {
            qb.andWhere('lobby.status = :status', { status: request.query.status });
        }
        else {
            qb.andWhere('lobby.status IN (:status)', {
                status: [ GameLobbyStatus.Started, GameLobbyStatus.Abandoned, GameLobbyStatus.Unknown ],
            });
        }

        const lbIds = await qb.getRawMany();
        const results = await server.conn.getRepository(S2GameLobby).createQueryBuilder('lobby')
            .select([])
            .addSelect([
                'lobby.id',
                'lobby.regionId',
                'lobby.bnetBucketId',
                'lobby.bnetRecordId',
                'lobby.mapBnetId',
                'lobby.mapMajorVersion',
                'lobby.mapMinorVersion',
                'lobby.extModBnetId',
                'lobby.extModMajorVersion',
                'lobby.extModMinorVersion',
                'lobby.multiModBnetId',
                'lobby.multiModMajorVersion',
                'lobby.multiModMinorVersion',
                'lobby.createdAt',
                'lobby.closedAt',
                'lobby.status',
                'lobby.mapVariantIndex',
                'lobby.mapVariantMode',
                'lobby.lobbyTitle',
                'lobby.hostName',
            ])
            .leftJoin('lobby.slots', 'slot')
            .addSelect([
                'slot.slotNumber',
                'slot.team',
                'slot.kind',
                'slot.name',
            ])
            // .leftJoin('slot.profile', 'profile')
            // .addSelect([
            //     'profile.regionId',
            //     'profile.realmId',
            //     'profile.profileId',
            //     'profile.name',
            //     'profile.discriminator',
            // ])
            .andWhereInIds(lbIds.length ? lbIds.map(x => x.lobby_id) : [0])
            .addOrderBy('lobby.id', sorder)
            .addOrderBy('slot.slotNumber', 'ASC')
            .getMany()
        ;

        return reply.type('application/json').code(200).sendWithCursorPagination(results, pQuery);
    });
});
