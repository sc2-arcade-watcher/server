import * as fp from 'fastify-plugin';
import { S2Document } from '../../../entity/S2Document';

export default fp(async (server, opts, next) => {
    server.get('/maps/:regionId/:mapId', {
        schema: {
            tags: ['Maps'],
            summary: 'Details about specific map',
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
        },
    }, async (request, reply) => {
        const result = await server.conn.getRepository(S2Document)
            .createQueryBuilder('mapDoc')
            .leftJoinAndSelect('mapDoc.category', 'category')
            .innerJoinAndMapOne('mapDoc.currentVersion', 'mapDoc.docVersions', 'currentVersion', 'currentVersion.document = mapDoc.id')
            .andWhere('(currentVersion.majorVersion = mapDoc.currentMajorVersion AND currentVersion.minorVersion = mapDoc.currentMinorVersion)')
            .andWhere('mapDoc.regionId = :regionId', { regionId: request.params.regionId })
            .andWhere('mapDoc.bnetId = :bnetId', { bnetId: request.params.mapId })

            // TODO: remove
            .innerJoinAndSelect('mapDoc.docVersions', 'mapDocVer')
            .addOrderBy('mapDocVer.majorVersion', 'DESC')
            .addOrderBy('mapDocVer.minorVersion', 'DESC')
            //

            .getOne()
        ;

        if (!result) {
            return reply.type('application/json').code(404).send();
        }

        reply.header('Cache-control', 'public, s-maxage=60');
        return reply.type('application/json').code(200).send(result);
    });
});
