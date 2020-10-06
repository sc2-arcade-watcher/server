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

        const depMap = await server.mapResolver.resolveMapDependencies(map.regionId, map.bnetId);
        const depList = await Promise.all(Array.from(depMap.values()).map(async depItem => {
            depItem.mapHeader.headerHash = null;

            const canDownload = await server.accessManager.isMapAccessGranted(
                MapAccessAttributes.Download,
                depItem.mapHeader,
                request.userAccount
            );
            if (!canDownload) {
                depItem.mapHeader.archiveHash = null;
            }

            return {
                map: depItem.map,
                mapHeader: depItem.mapHeader,
                requestedVersion: depItem.requestedVersion,
                tags: depItem.rawData.specialTags,
            };
        }));

        const result = {
            regionId: map.regionId,
            bnetId: map.bnetId,
            list: depList,
        };

        reply.header('Cache-control', 'private, max-age=300');
        return reply.code(200).send(result);
    });
});
