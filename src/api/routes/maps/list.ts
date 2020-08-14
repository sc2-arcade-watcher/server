import * as fp from 'fastify-plugin';
import { S2Map, S2MapType } from '../../../entity/S2Map';
import { S2StatsPeriodMap } from '../../../entity/S2StatsPeriodMap';
import { S2StatsPeriod } from '../../../entity/S2StatsPeriod';

export default fp(async (server, opts, next) => {
    server.get('/maps', {
        schema: {
            tags: ['Maps'],
            summary: 'List of maps',
            querystring: {
                type: 'object',
                properties: {
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
                            'name',
                            'updated',
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
            case 'name': {
                orderByKey = 'map.name';
                break;
            }
            case 'updated': {
                orderByKey = 'map.updatedAt';
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
                'map.iconHash',
                'map.mainCategoryId',
                'map.updatedAt',
            ])
            .innerJoin('map.currentVersion', 'cver')
            .addSelect([
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
            qb.leftJoin(S2StatsPeriodMap, 'stMap', 'stMap.regionId = map.regionId AND stMap.bnetId = map.bnetId AND stMap.period = ' + stMapQuery);
            qb.addSelect('stMap.participantsUniqueTotal');
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
            nameQuery = nameQuery.replace(/[<>()~]/g, '').trim();

            if (nameQuery.length) {
                // if (nameQuery.search(' ') === -1 && nameQuery.length >= 3) {
                //     nameQuery += '*';
                // }
                if (nameQuery.search(/[\+\-\*\"]/g) === -1) {
                    nameQuery = nameQuery.replace(/[\"\+\-\*]/g, '').split(/\s+/).map(x => `+${x}`).join(' ');
                }

                qb
                    .andWhere('MATCH (map.name) AGAINST(:name IN BOOLEAN MODE)', { name: nameQuery })
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

        return reply.type('application/json').code(200).sendWithCursorPagination(await qb.getRawAndEntities(), pQuery);
    });
});
