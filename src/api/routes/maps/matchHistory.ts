import fp from 'fastify-plugin';
import { S2ProfileMatch } from '../../../entity/S2ProfileMatch';
import { S2Profile } from '../../../entity/S2Profile';
import { S2LobbyMatch } from '../../../entity/S2LobbyMatch';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/maps/:regionId/:mapId/match-history', {
        schema: {
            hide: true,
            tags: ['Maps'],
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
                date: {
                    type: ['number', 'string'],
                },
                orderBy: {
                    type: 'string',
                    enum: [
                        'id',
                        'date',
                    ],
                    default: 'date',
                },
                orderDirection: {
                    type: 'string',
                    enum: [
                        'asc',
                        'desc',
                    ],
                    default: 'desc',
                },
                includeMatchResult: {
                    type: 'boolean',
                    default: false,
                },
                includeMatchLobby: {
                    type: 'boolean',
                    default: false,
                },
            },
        }
    }, async (request, reply) => {
        let orderByKey: string | string[];
        switch (request.query.orderBy) {
            case 'id':
            case 'date': {
                orderByKey = `profMatch.${request.query.orderBy}`;
                break;
            }
            default: {
                return reply.code(400).send();
            }
        }

        const pQuery = request.parseCursorPagination({
            paginationKeys: orderByKey,
        });

        const qb = server.conn.getRepository(S2ProfileMatch)
            .createQueryBuilder('profMatch')
            .leftJoinAndMapOne(
                'profMatch.profile',
                S2Profile,
                'profile',
                'profile.regionId = profMatch.regionId AND profile.localProfileId = profMatch.localProfileId'
            )
            .select([
                'profMatch.date',
                'profMatch.type',
                'profMatch.decision',
                'profile.regionId',
                'profile.realmId',
                'profile.profileId',
                'profile.name',
                'profile.discriminator',
                'profile.avatar',
            ])
            .andWhere('profMatch.regionId = :regionId AND profMatch.mapId = :mapId', {
                regionId: request.params.regionId,
                mapId: request.params.mapId,
            })
        ;

        if (request.query.includeMatchResult) {
            qb
                .leftJoin('profMatch.lobbyMatchProfile', 'lobMatchProf')
                .leftJoinAndMapOne('profMatch.lobbyMatch', S2LobbyMatch, 'lobbyMatch', 'lobbyMatch.lobbyId = lobMatchProf.lobbyId')
            ;
            qb.expressionMap.selects.pop();
            qb.addSelect([
                'lobbyMatch.result',
                // 'lobbyMatch.lobbyId',
            ]);

            if (request.query.includeMatchLobby) {
                qb.leftJoin('lobbyMatch.lobby', 'lobby');
                qb.addSelect([
                    'lobby.regionId',
                    'lobby.bnetBucketId',
                    'lobby.bnetRecordId',
                    'lobby.closedAt',
                ]);
            }
        }

        if (request.query.date) {
            console.log(request.query);
            const mDate = new Date(
                !isNaN(Number(request.query.date)) ? Number(request.query.date) * 1000 : request.query.date
            );
            console.log(mDate.toISOString(), mDate.toUTCString(), mDate.getTime() / 1000);
            if (isNaN(mDate.getTime())) {
                return reply.code(400).send();
            }
            qb.andWhere('profMatch.date = :date', { date: mDate });
        }

        qb.limit(pQuery.fetchLimit);
        pQuery.applyQuery(qb, request.query.orderDirection!.toUpperCase());

        reply.header('Cache-control', 'public, s-maxage=60');
        const results = await qb.getRawAndEntities();
        return reply.code(200).sendWithCursorPagination(results, pQuery);
    });
});
