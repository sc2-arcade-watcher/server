import * as fp from 'fastify-plugin';
import { stripIndents } from 'common-tags';
import { GameLobbyStatus } from '../../../gametracker';
import { S2GameLobbyRepository } from '../../../repository/S2GameLobbyRepository';

export default fp(async (server, opts, next) => {
    server.get('/lobbies/active', {
        config: {
            rateLimit: {
                max: 15,
                timeWindow: 1000 * 30,
            },
        },
        schema: {
            tags: ['Lobbies'],
            summary: 'Open and recently closed lobbies',
            description: stripIndents`
                List of active lobbies on the battle.net. In addition to \`open\` lobbies it also includes those which have been closed, if \`recentlyClosedThreshold\` is not \`0\`.

                - Slot info associated with the lobby might not be immediately available, in which case an empty array will be returned.
                - Amount of slots can change on very rare occasions. I've noticed this to happen in melee games specifically.
                - Maximum amount of slots is 16. But only 15 can be occupied by either human or an AI. There's at least one map on the Arcade with 16 slots open, which shouldn't be possible, as SC2 is limited to 15 players. But the slot still appears as open, despite being unusable.
                - Property \`slotsUpdatedAt\` indicates when the \`slots\` data has changed the last time - not when it was "checked" by the SC2 bot last time. Thus if no player join or leave it will remain the same.

                Known issues:

                - It's possible to have a human slot without \`profile\` linked (in which case it'll be \`null\`). It happens rather rarely and it's a result of a bug in the code of sc2 bot, that hasn't yet been eliminated.
                - Sometimes the same lobby might be flagged as started/closed and then re-appear as open shortly after, in majority of the cases this happens due to a bug in the code of sc2 bot (again). However, it can also happen naturally - I'm not sure what conditions are leading to this.
                - Endpoint might be slow to respond with every additional parameter set, that contributes to the amount of data which must be fetched.

                *Will update above notice, once any of these problems will get addressed.*
            `,
            querystring: {
                type: 'object',
                properties: {
                    regionId: {
                        type: 'number',
                    },
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
                        maximum: 20,
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

        qb.andWhere('lobby.status = :status', { status: GameLobbyStatus.Open });

        if (request.query.recentlyClosedThreshold) {
            qb.andWhere('(lobby.closedAt IS NULL OR lobby.closedAt >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL :threshold SECOND))', {
                threshold: request.query.recentlyClosedThreshold
            });
        }

        if (request.query.regionId !== void 0) {
            qb.andWhere('lobby.regionId = :regionId', { regionId: request.query.regionId });
        }

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

        const result = await qb.getMany();

        // START for compatibility, to be removed
        result.forEach(x => {
            (<any>x).mapMajorVersion = 0;
            (<any>x).mapMinorVersion = 0;
            (<any>x).extModMajorVersion = 0;
            (<any>x).extModMinorVersion = 0;
            (<any>x).multiModMajorVersion = 0;
            (<any>x).multiModMinorVersion = 0;
        });
        // END

        reply.header('Cache-control', 'public, s-maxage=4');
        return reply.type('application/json').code(200).send(result);
    });
});
