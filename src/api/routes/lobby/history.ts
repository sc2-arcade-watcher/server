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

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/lobbies/history', {
        schema: {
            tags: ['Lobbies'],
            summary: 'History of public lobbies.',
            description: stripIndents`
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
                },
            },
        },
    }, async (request, reply) => {
        const pQuery = request.parseCursorPagination({
            paginationKeys: ['id'],
        });

        let qb: orm.SelectQueryBuilder<any>;

        if (typeof request.query.regionId === 'number' && typeof request.query.mapId === 'number') {
            qb = server.conn.getRepository(S2GameLobbyMap)
                .createQueryBuilder('lobMap')
                .andWhere('lobMap.regionId = :regionId AND lobMap.bnetId = :bnetId', {
                    regionId: request.query.regionId,
                    bnetId: request.query.mapId,
                })
                .select('lobMap.lobby', 'id')
            ;
        }
        else if (typeof request.query.profileHandle === 'string') {
            const requestedProfile = parseProfileHandle(request.query.profileHandle);
            if (!requestedProfile) {
                return reply.code(400).send();
            }

            const profileQuery = server.conn.getRepository(S2Profile).createQueryBuilder().subQuery()
                .from(S2Profile, 'profile')
                .select('profile.id')
                .andWhere('profile.regionId = :regionId AND profile.realmId = :realmId AND profile.profileId = :profileId')
                .limit(1)
                .getQuery()
            ;

            qb = server.conn.getRepository(S2GameLobbySlot)
                .createQueryBuilder('lobSlot')
                .andWhere('lobSlot.profile = ' + profileQuery, {
                    regionId: requestedProfile.regionId,
                    realmId: requestedProfile.realmId,
                    profileId: requestedProfile.profileId,
                })
                .select('lobSlot.lobby', 'id')
            ;
        }
        else {
            return reply.code(400).send();
        }

        qb.limit(pQuery.fetchLimit);

        pQuery.applyQuery(qb, request.query.orderDirection!.toUpperCase());

        const lbIds = await qb.getRawMany();

        const qbFinal = server.conn.getCustomRepository(S2GameLobbyRepository).createQueryForEntriesInIds(
            lbIds.length ? lbIds.map(x => x.id) : [0],
            pQuery.getOrderDirection(request.query.orderDirection!.toUpperCase())
        );

        return reply.code(200).sendWithCursorPagination({
            raw: lbIds,
            entities: (await qbFinal.getRawAndEntities()).entities,
        }, pQuery);
    });
});
