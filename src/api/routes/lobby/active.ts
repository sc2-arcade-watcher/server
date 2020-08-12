import * as fp from 'fastify-plugin';
import { stripIndents } from 'common-tags';
import { GameLobbyStatus } from '../../../gametracker';
import { S2GameLobbyRepository } from '../../../repository/S2GameLobbyRepository';

export default fp(async (server, opts, next) => {
    server.get('/lobbies/active', {
        schema: {
            tags: ['Lobbies'],
            summary: 'Open and recently closed lobbies',
            description: stripIndents`
                List of active lobbies on the battle.net. In addition to \`open\` lobbies it also includes those which have been closed, if \`recentlyClosedThreshold\` is not \`0\`.

                Important notices:

                - Timestamps are in UTC, given in ISO format with precision to 3 decimal places.

                - Slot info associated with the lobby might not be immediately available, in which case an empty array will be returned.

                - Amount of slots can change on very rare occasions. I've noticed this to happen in melee games specifically.

                - It's possible to have a human slot without \`profile\` linked (in which case it'll be \`null\`). It happens rather rarely and it's a result of a bug within the SC2 bot that hasn't yet been eliminated.

                - Maximum amount of slots is 16. But only 15 can be occupied by either human or an AI. There's at least one map on the Arcade with 16 slots open, which shouldn't be possible, as SC2 is limited to 15 players. But the slot still appears as open.

                - Property \`slotsUpdatedAt\` indicates when the \`slots\` data has changed the last time - not when it was "checked" by the SC2 bot last time. Thus if no player join or leave it will remain the same.

                - Sometimes lobby might be flagged as started/closed and then re-appear as open shortly after.
            `,
            querystring: {
                type: 'object',
                properties: {
                    includeMapInfo: {
                        type: 'boolean',
                        default: false,
                    },
                    includeSlots: {
                        type: 'boolean',
                        default: true,
                    },
                    includeSlotsJoinInfo: {
                        type: 'boolean',
                        default: true,
                    },
                    includeJoinHistory: {
                        type: 'boolean',
                        default: true,
                    },
                    recentlyClosedThreshold: {
                        type: 'number',
                        minimum: 0,
                        maximum: 30,
                        default: 20,
                    },
                }
            },
        },
    }, async (request, reply) => {
        const lobbyRepo = server.conn.getCustomRepository(S2GameLobbyRepository);
        const qb = lobbyRepo
            .createQueryBuilder('lobby')
            .select([])
            .addOrderBy('lobby.createdAt', 'ASC')
        ;

        if (request.query.includeMapInfo) {
            lobbyRepo.addMapInfo(qb, true);
        }

        if (request.query.includeSlots) {
            lobbyRepo.addSlots(qb);
            if (request.query.includeSlotsJoinInfo) {
                lobbyRepo.addSlotsJoinInfo(qb);
            }
        }

        if (request.query.includeJoinHistory) {
            lobbyRepo.addJoinHistory(qb);
        }

        if (request.query.recentlyClosedThreshold) {
            qb.andWhere('lobby.status = :status OR lobby.closedAt >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL :threshold SECOND)', {
                status: GameLobbyStatus.Open,
                threshold: request.query.recentlyClosedThreshold
            });
        }
        else {
            qb.andWhere('lobby.status = :status', { status: GameLobbyStatus.Open });
        }

        qb.addSelect([
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
        ]);

        const result = await qb.getMany();

        reply.header('Cache-control', 'public, s-maxage=4');
        return reply.type('application/json').code(200).send(result);
    });
});
