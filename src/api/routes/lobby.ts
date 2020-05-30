import * as fp from 'fastify-plugin';
import { S2GameLobby } from '../../entity/S2GameLobby';
import { GameLobbyStatus } from '../../gametracker';
import { S2GameLobbySlotKind, S2GameLobbySlot } from '../../entity/S2GameLobbySlot';
import { S2GameLobbyRepository } from '../../repository/S2GameLobbyRepository';
import { logger } from '../../logger';
import { stripIndents } from 'common-tags';

export const lobbyRouter = fp(async (server, opts, next) => {
    // ===
    // ===
    server.get('/lobbies/active', {
        schema: {
            tags: ['Lobbies'],
            summary: 'Open and recently closed lobbies',
            description: stripIndents`
                List of active lobbies on the battle.net. In addition to \`open\` lobbies it also includes those which have been closed in the last 20 seconds.

                Important notices:

                - Timestamps are in UTC, given in ISO format with \`.3\` precision.

                - Slot info associated with the lobby might not be immediately available, in which case an empty array will be returned.

                - Amount of slots can change on very rare occasions. I've noticed this to happen in melee games specifically.

                - It's possible to have a human slot without \`profile\` linked (in which case it'll be \`null\`). It very rarely happens but you need to take it into account.

                - Maximum amount of slots is 16. But only 15 can be occupied by either human or an AI. There's at least one map on the Battle.net with 16 slots open, which shouldn't be possible, as SC2 is limited to 15 players. But the slot still appears as open.

                - Property \`slotsUpdatedAt\` indicates when the \`slots\` data has changed the last time - not when it was "checked" by the sc2 bot last time. Thus if no player join or leave it will remain the same.

                - Sometimes lobby might be flagged as started and then re-appear as open again, and it's not a bug. I believe it happens when status of the lobby becomes locked on the Battle.net - when its starting counter goes down to 3 (?). Then if player forcefully leaves, the game won't start and lobby will again appear on the list as \`open\`

                - To obtain the history of players who joined/left the lobby you need to use the other endpoint.
            `,
        },
    }, async (request, reply) => {
        const qb = server.conn.getRepository(S2GameLobby)
            .createQueryBuilder('lobby')
            .select([
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
                'lobby.slotsUpdatedAt',
            ])
            .leftJoin('lobby.slots', 'slot')
            .addSelect([
                'slot.slotNumber',
                'slot.team',
                'slot.kind',
                'slot.name',
            ])
            .leftJoin('slot.joinInfo', 'joinInfo')
            .addSelect([
                'joinInfo'
            ])
            .leftJoin('slot.profile', 'profile')
            .addSelect([
                'profile.regionId',
                'profile.realmId',
                'profile.profileId',
                'profile.name',
                'profile.discriminator',
            ])
        ;
        qb.leftJoin('lobby.joinHistory', 'joinHistory');
        qb.leftJoin('joinHistory.profile', 'joinHistoryProfile');
        qb.addSelect([
            'joinHistory.joinedAt',
            'joinHistory.leftAt',
            'joinHistoryProfile.regionId',
            'joinHistoryProfile.realmId',
            'joinHistoryProfile.profileId',
            'joinHistoryProfile.name',
            'joinHistoryProfile.discriminator',
        ]);
        const result = await qb
            .andWhere('lobby.status = :status OR lobby.closedAt >= FROM_UNIXTIME(UNIX_TIMESTAMP()-20)', { status: GameLobbyStatus.Open })
            .addOrderBy('lobby.createdAt', 'ASC')
            .addOrderBy('slot.slotNumber', 'ASC')
            .addOrderBy('joinInfo.id', 'ASC')
            .getMany()
        ;

        reply.header('Cache-control', 'public, s-maxage=1');
        return reply.type('application/json').code(200).send(result);
    });


    // ===
    // ===
    server.get('/open-games', async (request, reply) => {
        const result = await server.conn.getRepository(S2GameLobby)
            .createQueryBuilder('lobby')
            .select([
                'lobby.bnetBucketId',
                'lobby.bnetRecordId',
                'lobby.createdAt',
                'lobby.closedAt',
                'lobby.status',
                'lobby.mapVariantIndex',
                'lobby.mapVariantMode',
                'lobby.lobbyTitle',
                'lobby.hostName',
                'lobby.slotsHumansTotal',
                'lobby.slotsHumansTaken',
            ])
            .innerJoinAndSelect('lobby.region', 'region')
            .innerJoinAndSelect('lobby.mapDocumentVersion', 'mapDocVer')
            .innerJoinAndSelect('mapDocVer.document', 'mapDoc')
            .innerJoinAndSelect('mapDoc.category', 'mapCategory')
            .leftJoinAndSelect('lobby.slots', 'slot')
            .leftJoinAndSelect('slot.joinInfo', 'joinInfo')
            .andWhere('slot.kind = :kind', { kind: S2GameLobbySlotKind.Human })
            .andWhere('lobby.status = :status OR lobby.closedAt >= FROM_UNIXTIME(UNIX_TIMESTAMP()-20)', { status: GameLobbyStatus.Open })
            .addOrderBy('lobby.createdAt', 'ASC')
            .addOrderBy('slot.slotNumber', 'ASC')
            .getMany()
        ;

        result.map(s2lobby => {
            if (s2lobby.status === GameLobbyStatus.Abandoned) {
                (<any>s2lobby).status = 'disbanded';
            }
            (<any>s2lobby).mapVariantCategory = s2lobby.mapDocumentVersion.document.category.name;
            (<any>s2lobby).players = s2lobby.slots.map(s2slot => {
                if (s2slot.kind !== S2GameLobbySlotKind.Human) return;
                return {
                    joinedAt: s2slot.joinInfo?.joinedAt ?? s2lobby.createdAt,
                    leftAt: null,
                    name: s2slot.name,
                };
            }).filter(x => x !== void 0);
            delete s2lobby.slots;
        });

        reply.header('Cache-control', 'public, s-maxage=1');
        return reply.type('application/json').code(200).send(result);
    });


    // ===
    // ===
    server.get('/lobbies/:regionId/:bnetBucketId/:bnetRecordId', {
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
        const result = await server.conn.getCustomRepository(S2GameLobbyRepository)
            .prepareDetailedSelect()
            .andWhere('lobby.regionId = :regionId AND lobby.bnetBucketId = :bnetBucketId AND lobby.bnetRecordId = :bnetRecordId', {
                regionId: request.params.regionId,
                bnetBucketId: request.params.bnetBucketId,
                bnetRecordId: request.params.bnetRecordId,
            })
            .getOne()
        ;

        if (!result) {
            return reply.type('application/json').code(404).send();
        }

        return reply.type('application/json').send(result);
    });


    // ===
    // ===
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

        // requesting total count of matching rows gets progressively more expensive, especially for very popular maps (Direct Strike..)
        // however, fetching just a slice of rows at any offset is fast, regardless of the sorting direction
        // TODO: consider caching `count` result independetly from rows, with much higher cache duration
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


    // ===
    // ===
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
