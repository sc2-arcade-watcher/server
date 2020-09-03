import * as fp from 'fastify-plugin';
import { GameRegion } from '../../../common';
import { S2Map } from '../../../entity/S2Map';

export default fp(async (server, opts, next) => {
    server.get('/maps/:regionId/:mapId/dependencies', {
        config: {
            rateLimit: {
                max: 25,
                timeWindow: 300,
            },
        },
        schema: {
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
        const rcode = GameRegion[request.params.regionId];
        if (!rcode) {
            return reply.code(400).send();
        }

        const map = await server.conn.getRepository(S2Map)
            .createQueryBuilder('map')
            .innerJoinAndSelect('map.currentVersion', 'mapHead')
            .innerJoinAndSelect('map.mainCategory', 'mainCat')
            .andWhere('map.regionId = :regionId AND map.bnetId = :bnetId', {
                regionId: request.params.regionId,
                bnetId: request.params.mapId,
            })
            .getOne()
        ;

        if (!map) {
            return reply.type('application/json').code(404).send();
        }
        if (map.currentVersion.isPrivate) {
            return reply.type('application/json').code(403).send();
        }

        const depMap = await server.mapResolver.resolveMapDependencies(map.regionId, map.bnetId);
        const depList = Array.from(depMap.values()).map(x => {
            if (x.mapHeader.isPrivate) {
                x.map.mainLocaleHash = null;
                x.mapHeader.headerHash = null;
                // if the map itself is public, there's no reason to hide archive hash of a dependency
                // x.mapHeader.archiveHash = null;
            }

            return {
                map: x.map,
                mapHeader: x.mapHeader,
                requestedVersion: x.requestedVersion,
                tags: x.rawData.specialTags,
            }
        });

        const result = {
            regionId: map.regionId,
            bnetId: map.bnetId,
            list: depList,
        };

        reply.header('Cache-control', 'public, max-age=300, s-maxage=300');
        return reply.type('application/json').code(200).send(result);
    });
});
