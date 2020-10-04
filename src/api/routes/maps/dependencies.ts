import fp from 'fastify-plugin';
import { GameRegion } from '../../../common';
import { S2Map } from '../../../entity/S2Map';
import { stripIndents } from 'common-tags';
import { MapAccessAttributes } from '../../plugins/accessManager';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/maps/:regionId/:mapId/dependencies', {
        config: {
            rateLimit: {
                max: 10,
                timeWindow: 1000 * 60,
            },
        },
        schema: {
            tags: ['Maps'],
            summary: `List of map's dependencies`,
            description: stripIndents`
                NOTICE: This endpoint is not yet stable and might be changed in the future.
            `,
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

        const [canDetails, canDownload] = await server.accessManager.isMapAccessGranted(
            [MapAccessAttributes.Details, MapAccessAttributes.Download],
            map,
            request.userAccount
        );

        if (!canDetails) {
            return reply.type('application/json').code(403).send();
        }

        const depMap = await server.mapResolver.resolveMapDependencies(map.regionId, map.bnetId);
        const depList = Array.from(depMap.values()).map(x => {
            x.mapHeader.headerHash = null;
            // this is flawed - since we're asuming all depndencies belong to the same author
            if (!canDownload) {
                x.mapHeader.archiveHash = null;
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

        reply.header('Cache-control', 'private, max-age=300');
        return reply.type('application/json').code(200).send(result);
    });
});
