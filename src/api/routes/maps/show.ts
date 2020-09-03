import * as fp from 'fastify-plugin';
import { S2Map } from '../../../entity/S2Map';

export default fp(async (server, opts, next) => {
    server.get('/maps/:regionId/:mapId', {
        schema: {
            tags: ['Maps'],
            summary: 'Basic info about specific map',
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
            map.mainLocaleHash = null;
            map.currentVersion.headerHash = null;
            map.currentVersion.archiveHash = null;
        }

        const result = map;

        // for compatibility with older version of this endpoint, to be removed in the future
        (<any>result).isArcade = !result.mainCategory.isMelee;
        (<any>result).currentMajorVersion = result.currentVersion.majorVersion;
        (<any>result).currentMinorVersion = result.currentVersion.minorVersion;
        (<any>result).categoryId = (<any>{
            'Melee': 1,
            'Survival': 2,
            'Tug Of War': 3,
            'Tower Defense': 4,
            'Other': 5,
            'Hero Battle': 6,
            'Arena': 7,
            'Strategy': 8,
            'Action': 9,
            'Single Player': 10,
            'RPG': 11,
            'Miscellaneous': 12,
            'Co-op VS A.I.': 13,
            'Puzzle': 14,
            'Archon Co-op VS A.I.': 15,
            'Archon': 16,
            'Trainer': 17,
            'Melee Spectator': 18,
            'Monobattle': 19,
            'Campaign': 20,
        })[result.mainCategory.name];
        (<any>result).category = {
            id: (<any>result).categoryId,
            name: result.mainCategory.name,
            description: null,
        };
        delete result.mainCategory;
        // end

        reply.header('Cache-control', 'public, s-maxage=60');
        return reply.type('application/json').code(200).send(result);
    });
});
