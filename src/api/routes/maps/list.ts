import fp from 'fastify-plugin';
import { S2Map, S2MapType } from '../../../entity/S2Map';
import { S2StatsPeriodMap } from '../../../entity/S2StatsPeriodMap';
import { S2StatsPeriod } from '../../../entity/S2StatsPeriod';
import { parseProfileHandle } from '../../../bnet/common';
import { S2Profile } from '../../../entity/S2Profile';
import { ProfileAccessAttributes } from '../../plugins/accessManager';

export default fp(async (server, opts) => {
    const fulltextStopWords = ['a', 'about', 'an', 'are', 'as', 'at', 'be', 'by', 'com', 'de', 'en', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'la', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'who', 'will', 'with', 'und', 'the', 'www'];
    const fulltextMinLength = 3;

    server.get<{
        Querystring: any,
        Params: any,
    }>('/maps', {
        schema: {
            tags: ['Maps'],
            summary: 'List of maps',
            querystring: {
                type: 'object',
                properties: {
                    authorHandle: {
                        type: 'string',
                    },
                    regionId: {
                        type: 'number',
                    },
                    type: {
                        type: 'string',
                        enum: Object.values(S2MapType),
                    },
                    name: {
                        type: 'string',
                    },
                    mainCategoryId: {
                        type: ['number', 'null'],
                    },
                    showPrivate: {
                        type: 'boolean',
                        default: false,
                    },
                    orderDirection: {
                        type: 'string',
                        enum: [
                            'asc',
                            'desc',
                        ],
                        default: 'desc',
                    },
                    orderBy: {
                        type: 'string',
                        enum: [
                            'id',
                            'versionId',
                            'name',
                            'updated',
                            'published',
                            'popularity',
                        ],
                        default: 'id',
                    },
                }
            },
        },
    }, async (request, reply) => {
        let orderByKey: string;
        switch (request.query.orderBy) {
            case 'id': {
                orderByKey = 'map.id';
                break;
            }
            case 'versionId': {
                orderByKey = 'cver.id';
                break;
            }
            case 'name': {
                orderByKey = 'map.name';
                break;
            }
            case 'updated': {
                orderByKey = 'map.updatedAt';
                break;
            }
            case 'published': {
                orderByKey = 'map.publishedAt';
                break;
            }
            case 'popularity': {
                orderByKey = 'stMap.participantsUniqueTotal';
                break;
            }
            default: {
                orderByKey = 'map.id';
                break;
            }
        }
        const pQuery = request.parseCursorPagination({
            paginationKeys: orderByKey,
        });

        const qb = server.conn.getRepository(S2Map)
            .createQueryBuilder('map')
            .select([
                'map.id',
                'map.regionId',
                'map.bnetId',
                'map.type',
                'map.name',
                'map.description',
                'map.website',
                'map.iconHash',
                'map.mainCategoryId',
                'map.maxPlayers',
                'map.updatedAt',
                'map.publishedAt',
            ])
            .innerJoin('map.currentVersion', 'cver')
            .addSelect([
                'cver.id',
                'cver.minorVersion',
                'cver.majorVersion',
                'cver.isPrivate',
            ])
            .limit(pQuery.fetchLimit)
        ;

        if (request.query.orderBy === 'popularity') {
            const stMapQuery = qb.subQuery()
                .from(S2StatsPeriod, 'stPeriod')
                .select('stPeriod.id')
                .andWhere('stPeriod.kind = \'weekly\' AND stPeriod.completed = 1')
                .orderBy('stPeriod.id', 'DESC')
                .limit(1)
                .getQuery()
            ;
            qb.innerJoin(S2StatsPeriodMap, 'stMap', 'stMap.regionId = map.regionId AND stMap.bnetId = map.bnetId AND stMap.period = ' + stMapQuery);
            qb.addSelect('stMap.participantsUniqueTotal');
        }

        if (request.query.authorHandle !== void 0) {
            const requestedAuthor = parseProfileHandle(request.query.authorHandle) ?? { regionId: 0, realmId: 0, profileId: 0 };

            // const authorQuery = qb.subQuery()
            //     .from(S2Profile, 'profile')
            //     .select('profile.id')
            //     .andWhere('profile.regionId = :authorRegionId AND profile.realmId = :authorRealmId AND profile.profileId = :authorProfileId')
            //     .limit(1)
            //     .getQuery()
            // ;

            // qb.andWhere('map.author = ' + authorQuery, {
            //     authorRegionId: requestedAuthor.regionId,
            //     authorRealmId: requestedAuthor.realmId,
            //     authorProfileId: requestedAuthor.profileId,
            // });

            const mapAuthorProfile = await server.conn.getRepository(S2Profile).findOne({
                where: {
                    regionId: requestedAuthor.regionId,
                    realmId: requestedAuthor.realmId,
                    profileId: requestedAuthor.profileId,
                },
            });

            if (!mapAuthorProfile) {
                return reply.code(404).send({
                    message: `Couldn't find a profile matching given handle.`,
                });
            }

            if (request.query.showPrivate) {
                const canListPrivate = await server.accessManager.isProfileAccessGranted(
                    ProfileAccessAttributes.PrivateMapList,
                    mapAuthorProfile,
                    request.userAccount
                );
                if (!canListPrivate) {
                    return reply.code(403).send({
                        message: `Privately published maps cannot be shown for this profile.`
                    });
                }
            }

            qb.andWhere('map.author = :authorProfileId', { authorProfileId: mapAuthorProfile.id });
        }

        if (request.query.type !== void 0) {
            qb.andWhere('map.type = :type', { type: request.query.type });
        }

        if (request.query.regionId !== void 0) {
            qb.andWhere('map.regionId = :regionId', { regionId: request.query.regionId });
        }

        if (request.query.name !== void 0 && request.query.name.trim().length) {
            let nameQuery = String(request.query.name);
            // https://mariadb.com/kb/en/full-text-index-overview/#in-boolean-mode
            // strip all operators except: " + - *
            // nameQuery = nameQuery.replace(/[<>()~]/g, '').trim();
            // .. actually, strip all of them, since it currently is used unitentionally
            // and can lead to parse errors which aren't even shown on the frontend
            nameQuery = nameQuery.replace(/[<>()~"*+-]/g, ' ').trim();

            if (nameQuery.search(/[\p{L}\p{Nd}]{3}/iu) !== -1 || nameQuery.endsWith('*')) {
                // nameQuery = nameQuery.replace(/[\+\-]+$/, '');

                if (nameQuery.search(/[\+\-\*\"]/g) === -1) {
                    nameQuery = nameQuery.replace(/[\"\+\-\*]/g, '').split(/\s+/).map(x => {
                        if (x.length < 3) return `${x}*`;
                        return fulltextStopWords.indexOf(x.toLowerCase()) === -1 ? `+${x}` : `${x}*`;
                    }).join(' ');
                }
                qb
                    .andWhere('MATCH (map.name) AGAINST(:name IN BOOLEAN MODE)', { name: nameQuery })
                ;
            }
            else {
                nameQuery = nameQuery.replace(/([\%\?])/g, '\\$1');
                qb
                    .andWhere('map.name LIKE :name', { name: nameQuery + '%' })
                ;
            }
        }

        if (typeof request.query.mainCategoryId === 'number') {
            qb.andWhere('map.mainCategoryId = :mainCategoryId', { mainCategoryId: request.query.mainCategoryId });
        }

        if (!request.query.showPrivate) {
            qb.andWhere('cver.isPrivate = false');
        }

        pQuery.applyQuery(qb, request.query.orderDirection?.toUpperCase());

        reply.header('Cache-control', 'private, max-age=60');
        return reply.code(200).sendWithCursorPagination(await qb.getRawAndEntities(), pQuery);
    });
});
