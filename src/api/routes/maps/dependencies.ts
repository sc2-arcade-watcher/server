import * as fp from 'fastify-plugin';
import { GameRegion } from '../../../common';

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

        const depMap = await server.mapResolver.resolveMapDependencies(request.params.regionId, request.params.mapId);
        const depList = Array.from(depMap.values()).map(x => {
            return {
                map: x.map,
                mapHeader: x.mapHeader,
                requestedVersion: x.requestedVersion,
                tags: x.rawData.specialTags,
            }
        });

        const result = {
            regionId: request.params.regionId,
            bnetId: request.params.mapId,
            list: depList,
        };

        reply.header('Cache-control', 'public, max-age=300, s-maxage=300');
        return reply.type('application/json').code(200).send(result);
    });
});
