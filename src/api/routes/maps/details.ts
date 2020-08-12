import * as fp from 'fastify-plugin';
import { S2Map } from '../../../entity/S2Map';
import { S2MapHeader } from '../../../entity/S2MapHeader';
import { GameLocale, GameRegion } from '../../../common';
import { MapHeaderData, MapLocalizationTable, applyMapLocalization } from '../../../task/mapResolver';

export default fp(async (server, opts, next) => {
    server.get('/maps/:regionId/:mapId/details', {
        schema: {
            tags: ['Maps'],
            summary: 'Rich details about specific map in its current version or past version',
            params: {
                type: 'object',
                required: ['regionId', 'mapId'],
                properties: {
                    regionId: {
                        type: 'number',
                        minimum: 1,
                        maximum: 3,
                    },
                    mapId: {
                        type: 'number',
                    },
                },
            },
            querystring: {
                type: 'object',
                properties: {
                    minorVersion: {
                        type: 'number',
                        minimum: 0,
                        default: 0,
                    },
                    majorVersion: {
                        type: 'number',
                        minimum: 0,
                        default: 0,
                    },
                },
            },
        },
    }, async (request, reply) => {
        let mhead: S2MapHeader;
        let mainLocale: GameLocale;
        let mainLocaleTableHash: string;
        if (request.query.minorVersion === 0 && request.query.majorVersion === 0) {
            const result = await server.conn.getRepository(S2Map)
                .createQueryBuilder('map')
                .innerJoinAndSelect('map.currentVersion', 'mapHead')
                .andWhere('map.regionId = :regionId AND map.bnetId = :bnetId', {
                    regionId: request.params.regionId,
                    bnetId: request.params.mapId,
                })
                .getOne()
            ;
            if (result) {
                mhead = result.currentVersion;
                mainLocale = result.mainLocale;
                mainLocaleTableHash = result.mainLocaleHash;
            }
        }
        else {
            const result = await server.conn.getRepository(S2MapHeader)
                .createQueryBuilder('mapHead')
                .andWhere('mapHead.regionId = :regionId AND mapHead.bnetId = :bnetId AND mapHead.majorVersion = :majorVersion AND mapHead.minorVersion = :minorVersion', {
                    regionId: request.params.regionId,
                    bnetId: request.params.mapId,
                    majorVersion: request.query.majorVersion,
                    minorVersion: request.query.minorVersion,
                })
                .getOne()
            ;
            mhead = result;
        }

        if (!mhead) {
            return reply.type('application/json').code(404).send();
        }

        const rcode = GameRegion[request.params.regionId];
        if (!rcode) {
            return reply.code(503).send();
        }

        let mapHeaderData: MapHeaderData;
        let mapLocalizationTable: MapLocalizationTable;

        if (!mainLocale) {
            mapHeaderData = await server.mapResolver.getMapHeader(rcode, mhead.headerHash, true);
            mapLocalizationTable = await server.mapResolver.getMapLocalization(rcode, mapHeaderData.localeTable[0].stringTable[0].hash, true);
        }
        else {
            [ mapHeaderData, mapLocalizationTable ] = [
                await server.mapResolver.getMapHeader(rcode, mhead.headerHash, false),
                await server.mapResolver.getMapLocalization(rcode, mainLocaleTableHash, false),
            ];
        }
        reply.header('Cache-control', 'public, s-maxage=60');
        return reply.type('application/json').code(200).send(applyMapLocalization(mapHeaderData, mapLocalizationTable));
    });
});
