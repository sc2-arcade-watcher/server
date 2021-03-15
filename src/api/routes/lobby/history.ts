import * as orm from 'typeorm';
import fp from 'fastify-plugin';
import { stripIndents } from 'common-tags';
import { GameLobbyStatus } from '../../../gametracker';
import { S2GameLobby } from '../../../entity/S2GameLobby';
import { S2GameLobbyRepository } from '../../../repository/S2GameLobbyRepository';
import { S2GameLobbyMap } from '../../../entity/S2GameLobbyMap';
import { S2GameLobbySlot } from '../../../entity/S2GameLobbySlot';
import { parseProfileHandle } from '../../../bnet/common';
import { S2Profile } from '../../../entity/S2Profile';
import { ProfileAccessAttributes } from '../../plugins/accessManager';
import { CursorPaginationQuery } from '../../plugins/cursorPagination';
import { S2GameLobbyPlayerJoin } from '../../../entity/S2GameLobbyPlayerJoin';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/lobbies/history', {
        config: {
            rateLimit: {
                max: 20,
                timeWindow: 1000 * 40,
            },
        },
        schema: {
            tags: ['Lobbies'],
            summary: 'History of public lobbies.',
            description: stripIndents`
                It allows to fetch history of lobbies of:
                - specific region: provide \`regionId\`
                - specific map: provide \`regionId\` and \`mapId\`
                - specific player: provide \`profileHandle\`

                The order in which lobbies are returned is based on internal ID (it's incremented whenever new lobby is being made). What means:
                - Sorting is based on the time it has been hosted, not when it has been closed. However direction (newest/oldest) can be changed by using \`orderDirection\` parameter.
                - Internal ID while exposed, should not be relied on. It's possible the database will be restructured at some point, and these internal IDs will change. To determine an unique lobby, a combination of \`{regionId},{bnetBucketId},{bnetRecordId}\` should be used - those IDs are Battle.net specific and can be trusted.

                Known issues:
                - It returns not only closed lobbies, but also those that are currently open - this isn't intended, and will be fixed in the future.

                NOTICE: This endpoint is not yet stable and might be changed in the future.
            `,
            querystring: {
                type: 'object',
                properties: {
                    regionId: {
                        type: 'number',
                    },
                    mapId: {
                        type: 'number',
                    },
                    profileHandle: {
                        type: 'string',
                    },
                    orderDirection: {
                        type: 'string',
                        enum: [
                            'asc',
                            'desc',
                        ],
                        default: 'desc',
                    },
                    includeMapInfo: {
                        type: 'boolean',
                        default: false,
                    },
                    includeSlots: {
                        type: 'boolean',
                        default: false,
                    },
                    includeSlotsProfile: {
                        type: 'boolean',
                        default: false,
                    },
                    includeSlotsJoinInfo: {
                        type: 'boolean',
                        default: false,
                    },
                    includeJoinHistory: {
                        type: 'boolean',
                        default: false,
                    },
                    includeMatchResult: {
                        type: 'boolean',
                        default: false,
                    },
                    includeMatchPlayers: {
                        type: 'boolean',
                        default: false,
                    },
                },
            },
        },
    }, async (request, reply) => {
        const lobbyRepo = server.conn.getCustomRepository(S2GameLobbyRepository);
        let pQuery: CursorPaginationQuery;
        let qb: orm.SelectQueryBuilder<any>;

        if (typeof request.query.regionId === 'number' && typeof request.query.mapId === 'number') {
            pQuery = request.parseCursorPagination({
                paginationKeys: ['lobMap.lobby'],
                toRawKey: (x) => 'id',
                toQueryKey: (x) => x,
                toFieldKey: (x) => x,
            });

            qb = server.conn.getRepository(S2GameLobbyMap)
                .createQueryBuilder('lobMap')
                .andWhere('lobMap.regionId = :regionId AND lobMap.bnetId = :bnetId', {
                    regionId: request.query.regionId,
                    bnetId: request.query.mapId,
                })
                .select('lobMap.lobby', 'id')
            ;
        }
        else if (typeof request.query.regionId === 'number') {
            pQuery = request.parseCursorPagination({
                paginationKeys: ['lobby.id'],
                toRawKey: (x) => 'id',
                toQueryKey: (x) => x,
                toFieldKey: (x) => x,
            });

            qb = lobbyRepo
                .createQueryBuilder('lobby')
                .andWhere('lobby.regionId = :regionId', {
                    regionId: request.query.regionId,
                })
                .select('lobby.id', 'id')
            ;
        }
        else if (typeof request.query.profileHandle === 'string') {
            pQuery = request.parseCursorPagination({
                paginationKeys: ['lobJoinInfo.lobby'],
                toRawKey: (x) => 'id',
                toQueryKey: (x) => x,
                toFieldKey: (x) => x,
            });

            const requestedProfile = parseProfileHandle(request.query.profileHandle) ?? { regionId: 0, realmId: 0, profileId: 0 };

            const canAccessDetails = await server.accessManager.isProfileAccessGranted(
                ProfileAccessAttributes.Details,
                requestedProfile,
                request.userAccount
            );
            if (!canAccessDetails) {
                return reply.code(403).send();
            }

            const profileQuery = server.conn.getRepository(S2Profile).createQueryBuilder().subQuery()
                .from(S2Profile, 'profile')
                .select('profile.id')
                .andWhere('profile.regionId = :regionId AND profile.realmId = :realmId AND profile.profileId = :profileId')
                .limit(1)
                .getQuery()
            ;

            // qb = server.conn.getRepository(S2GameLobbySlot)
            //     .createQueryBuilder('lobSlot')
            //     .andWhere('lobSlot.profile = ' + profileQuery, {
            //         regionId: requestedProfile.regionId,
            //         realmId: requestedProfile.realmId,
            //         profileId: requestedProfile.profileId,
            //     })
            //     .select('lobSlot.lobby', 'id')
            // ;

            qb = server.conn.getRepository(S2GameLobbyPlayerJoin)
                .createQueryBuilder('lobJoinInfo')
                .andWhere('lobJoinInfo.profile = ' + profileQuery, {
                    regionId: requestedProfile.regionId,
                    realmId: requestedProfile.realmId,
                    profileId: requestedProfile.profileId,
                })
                .select('lobJoinInfo.lobby', 'id')
                .distinct()
            ;
        }
        else {
            return reply.code(400).send();
        }

        qb.limit(pQuery.fetchLimit);
        pQuery.applyQuery(qb, request.query.orderDirection?.toUpperCase() ?? 'DESC');
        const lbIds = await qb.getRawMany();

        const qbFinal = server.conn.getCustomRepository(S2GameLobbyRepository).createQueryBuilder('lobby').select([]);
        qbFinal.andWhereInIds(lbIds.length ? lbIds.map(x => x.id) : [0]);
        qbFinal.addOrderBy('lobby.id', pQuery.getOrderDirection(request.query.orderDirection?.toUpperCase() ?? 'DESC'));

        if (request.query.includeMatchResult) {
            lobbyRepo.addMatchResult(qbFinal, {
                playerProfiles: request.query.includeMatchPlayers,
            });
        }

        if (request.query.includeMapInfo) {
            lobbyRepo.addMapInfo(qbFinal, true);
        }

        qbFinal.addSelect([
            'lobby.id',
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
            'lobby.slotsHumansTaken',
            'lobby.slotsHumansTotal',
        ]);

        if (request.query.includeSlots) {
            lobbyRepo.addSlots(qbFinal);
            if (request.query.includeSlotsProfile) {
                lobbyRepo.addSlotsProfile(qbFinal);
            }
            if (request.query.includeSlotsJoinInfo) {
                lobbyRepo.addSlotsJoinInfo(qbFinal);
            }
        }

        if (request.query.includeJoinHistory) {
            lobbyRepo.addJoinHistory(qbFinal);
        }

        return reply.code(200).sendWithCursorPagination({
            raw: lbIds,
            entities: (await qbFinal.getRawAndEntities()).entities,
        }, pQuery);
    });
});
