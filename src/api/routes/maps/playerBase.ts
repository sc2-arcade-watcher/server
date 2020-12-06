import fp from 'fastify-plugin';
import { GameRegion } from '../../../common';
import { S2Map } from '../../../entity/S2Map';
import { MapAccessAttributes } from '../../plugins/accessManager';
import { S2StatsPlayerMap } from '../../../entity/S2StatsPlayerMap';
import { S2Profile } from '../../../entity/S2Profile';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/maps/:regionId/:mapId/player-base', {
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
                name: {
                    type: 'string',
                },
                lastPlayedMin: {
                    type: 'string',
                    format: 'date',
                },
                orderBy: {
                    type: 'string',
                    enum: [
                        'id',
                        'profileId',
                        'name',
                        'lobbiesStarted',
                        'lobbiesHostedStarted',
                    ],
                    default: 'lobbiesStarted',
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
    }, async (request, reply) => {
        const rcode = GameRegion[request.params.regionId];
        if (!rcode) {
            return reply.code(400).send();
        }

        const map = await server.conn.getRepository(S2Map)
            .createQueryBuilder('map')
            .innerJoinAndSelect('map.currentVersion', 'mapHead')
            .andWhere('map.regionId = :regionId AND map.bnetId = :bnetId', {
                regionId: request.params.regionId,
                bnetId: request.params.mapId,
            })
            .limit(1)
            .getOne()
        ;
        if (!map) {
            return reply.code(404).send();
        }

        const canDetails = await server.accessManager.isMapAccessGranted(
            MapAccessAttributes.Details,
            map,
            request.userAccount
        );
        if (!canDetails) {
            return reply.code(403).send();
        }

        let orderByKey: string | string[];
        switch (request.query.orderBy) {
            case 'id':
            case 'name': {
                orderByKey = `profile.${request.query.orderBy}`;
                break;
            }
            case 'lobbiesStarted':
            case 'lobbiesHostedStarted': {
                orderByKey = `statPlayer.${request.query.orderBy}`;
                break;
            }
            case 'profileId': {
                orderByKey = [
                    'profile.regionId',
                    'profile.realmId',
                    'profile.profileId',
                ];
                break;
            }
            default: {
                return reply.code(400).send();
            }
        }

        const pQuery = request.parseCursorPagination({
            paginationKeys: orderByKey,
        });

        const qb = server.conn.getRepository(S2StatsPlayerMap).createQueryBuilder('statPlayer')
            .innerJoinAndMapOne(
                'statPlayer.profile',
                S2Profile,
                'profile',
                'profile.regionId = statPlayer.regionId AND profile.realmId = statPlayer.realmId AND profile.profileId = statPlayer.profileId'
            )
            .select([
                'statPlayer.lobbiesStarted',
                'statPlayer.lobbiesStartedDiffDays',
                'statPlayer.lobbiesJoined',
                'statPlayer.lobbiesHosted',
                'statPlayer.lobbiesHostedStarted',
                'statPlayer.timeSpentWaiting',
                'statPlayer.timeSpentWaitingAsHost',
                'statPlayer.lastPlayedAt',
            ])
            .addSelect([
                'profile.regionId',
                'profile.realmId',
                'profile.profileId',
                'profile.name',
                'profile.discriminator',
                'profile.avatar',
            ])
            .andWhere('statPlayer.regionId = :regionId AND statPlayer.mapId = :mapId', {
                regionId: request.params.regionId,
                mapId: request.params.mapId,
            })
        ;

        if (request.query.name !== void 0 && request.query.name.trim().length) {
            const nameQuery = (request.query.name as string).replace(/([\%\?])/g, '\\$1');
            if (nameQuery.indexOf('#') > 0) {
                // qb.andWhere('profile.name LIKE :name', { name: nameQuery.substr(0, nameQuery.indexOf('#')) });
                qb.andWhere('profile.name = :name', { name: nameQuery.substr(0, nameQuery.indexOf('#')) });
                const discriminator = Number(nameQuery.substr(nameQuery.indexOf('#') + 1));
                if (discriminator && !isNaN(discriminator)) {
                    qb.andWhere('profile.discriminator = :discriminator', { discriminator });
                }
            }
            else {
                // qb.andWhere('profile.name LIKE :name', { name: nameQuery + '%' });
                qb.andWhere('profile.name = :name', { name: nameQuery });
            }
        }

        if (request.query.lastPlayedMin) {
            qb.andWhere('statPlayer.lastPlayedAt >= :lastPlayedMin', {
                lastPlayedMin: request.query.lastPlayedMin,
            });
        }

        qb.limit(pQuery.fetchLimit);
        pQuery.applyQuery(qb, request.query.orderDirection!.toUpperCase());

        reply.header('Cache-control', 'private, max-age=60');
        const results = await qb.getRawAndEntities();
        return reply.code(200).sendWithCursorPagination(results, pQuery);
    });
});
