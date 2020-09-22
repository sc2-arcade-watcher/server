import * as fp from 'fastify-plugin';
import { S2MapHeader } from '../../../entity/S2MapHeader';
import { stripIndents } from 'common-tags';
import { S2Map } from '../../../entity/S2Map';

export default fp(async (server, opts, next) => {
    server.get('/maps/:regionId/:mapId/versions', {
        schema: {
            tags: ['Maps'],
            summary: 'List of all versions of specific map.',
            description: stripIndents`
                Currently it only returns list of known versions - those which have been indexed, for most maps it won't include all ever uploaded to Arcade.

                However, in future there might be a way to either request a full index of specific map via API. Or the service itself will try to keep the list fully up to date for maps which have been publicly hosted at least once - if it proves to be feasible.

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
        const map = await server.conn.getRepository(S2Map)
            .createQueryBuilder('map')
            .innerJoinAndSelect('map.currentVersion', 'mapHead')
            .innerJoinAndMapMany(
                'map.revisions',
                S2MapHeader,
                'revision',
                'revision.regionId = :regionId AND revision.bnetId = :bnetId'
            )
            .andWhere('map.regionId = :regionId AND map.bnetId = :bnetId')
            .select([
                'map.regionId',
                'map.bnetId',
                'mapHead.isPrivate',
                'revision.majorVersion',
                'revision.minorVersion',
                'revision.headerHash',
                'revision.isPrivate',
                'revision.isExtensionMod',
                'revision.archiveHash',
                'revision.archiveSize',
                'revision.uploadedAt',
            ])
            .setParameters({
                regionId: request.params.regionId,
                bnetId: request.params.mapId,
            })
            .addOrderBy('revision.majorVersion', 'DESC')
            .addOrderBy('revision.minorVersion', 'DESC')
            .getOne()
        ;

        if (!map) {
            return reply.type('application/json').code(404).send();
        }
        if (map.currentVersion.isPrivate) {
            return reply.type('application/json').code(403).send();
        }

        return reply.type('application/json').code(200).send({
            regionId: request.params.regionId,
            bnetId: request.params.mapId,
            versions: map.revisions,
        });
    });
});
