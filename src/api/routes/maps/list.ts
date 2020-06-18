import * as fp from 'fastify-plugin';
import { S2Document, S2DocumentType } from '../../../entity/S2Document';
import { S2DocumentVersion } from '../../../entity/S2DocumentVersion';

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
                    name: {
                        type: 'string',
                    },
                    type: {
                        type: 'string',
                        enum: [
                            S2DocumentType.Map,
                            S2DocumentType.ExtensionMod,
                            S2DocumentType.DependencyMod,
                        ],
                    },
                }
            },
        },
    }, async (request, reply) => {
        const { limit, offset } = request.parsePagination();

        const qb = server.conn.getRepository(S2Document)
            .createQueryBuilder('mapDoc')
            .innerJoinAndMapOne(
                'mapDoc.currentVersion',
                S2DocumentVersion,
                'currentVersion',
                'currentVersion.document = mapDoc.id AND currentVersion.majorVersion = mapDoc.currentMajorVersion AND currentVersion.minorVersion = mapDoc.currentMinorVersion'
            )
            .take(limit)
            .skip(offset)
        ;

        if (request.query.name !== void 0) {
            qb.andWhere('mapDoc.name LIKE :name', { name: '%' + request.query.name + '%' });
        }
        if (request.query.type !== void 0) {
            qb.andWhere('mapDoc.type = :type', { type: request.query.type });
        }
        if (request.query.regionId !== void 0) {
            qb.andWhere('mapDoc.regionId = :regionId', { regionId: request.query.regionId });
        }

        const [ result, count ] = await qb.getManyAndCount();

        reply.header('Cache-control', 'public, s-maxage=60');
        return reply.type('application/json').code(200).sendWithPagination({ count: count, page: result });
    });
});
