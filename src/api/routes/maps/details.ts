import * as fp from 'fastify-plugin';
import { S2Map } from '../../../entity/S2Map';
import { S2MapHeader } from '../../../entity/S2MapHeader';
import { GameLocale, GameRegion } from '../../../common';
import { MapLocalizationTable, reprocessMapHeader } from '../../../map/mapResolver';
import { MapAccessAttributes } from '../../plugins/accessManager';

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
                        maximum: 0xFFFF,
                        default: 0,
                    },
                    majorVersion: {
                        type: 'number',
                        minimum: 0,
                        maximum: 0xFFFF,
                        default: 0,
                    },
                    locale: {
                        type: 'string',
                        enum: Object.values(GameLocale),
                    },
                },
            },
        },
    }, async (request, reply) => {
        const map = await server.conn.getRepository(S2Map)
            .createQueryBuilder('map')
            .innerJoinAndSelect('map.currentVersion', 'mapHead')
            .andWhere('map.regionId = :regionId AND map.bnetId = :bnetId', {
                regionId: request.params.regionId,
                bnetId: request.params.mapId,
            })
            .getOne()
        ;

        if (!map) {
            return reply.type('application/json').code(404).send();
        }

        const canDetails = await server.accessManager.isMapAccessGranted(MapAccessAttributes.Details, map, request.userAccount);
        if (!canDetails) {
            return reply.type('application/json').code(403).send();
        }

        let mhead: S2MapHeader;
        let localeTableHash: string;
        if (request.query.minorVersion === 0 && request.query.majorVersion === 0) {
            mhead = map.currentVersion;
            localeTableHash = map.mainLocaleHash;
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

            if (!mhead) {
                return reply.type('application/json').code(404).send();
            }
        }

        const rcode = GameRegion[mhead.regionId];
        const mapHeaderData = await server.mapResolver.getMapHeader(rcode, mhead.headerHash);
        let mapLocalizationTable: MapLocalizationTable;

        if (!localeTableHash || request.query.locale) {
            let localeTable = mapHeaderData.localeTable[0];
            if (request.query.locale) {
                localeTable = mapHeaderData.localeTable.find(x => x.locale === request.query.locale);
            }
            if (!localeTable) {
                return reply.code(404).send();
            }
            localeTableHash = localeTable.stringTable[0].hash;
        }

        mapLocalizationTable = await server.mapResolver.getMapLocalization(rcode, localeTableHash);
        const mapDetails = reprocessMapHeader(mapHeaderData, mapLocalizationTable);

        const canDownload = await server.accessManager.isMapAccessGranted(MapAccessAttributes.Download, map, request.userAccount);
        if (!canDownload) {
            mhead.headerHash = null;
            mhead.archiveHash = null;
            mapDetails.archiveHandle = null;
        }

        return reply.type('application/json').code(200).send(Object.assign({},
            mhead,
            {
                info: mapDetails,
            },
        ));
    });
});
