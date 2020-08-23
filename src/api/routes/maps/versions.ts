import * as fp from 'fastify-plugin';
import { S2MapHeader } from '../../../entity/S2MapHeader';
import { stripIndents } from 'common-tags';

export default fp(async (server, opts, next) => {
    server.get('/maps/:regionId/:mapId/versions', {
        schema: {
            tags: ['Maps'],
            summary: 'List of all versions of specific map.',
            description: stripIndents`
                Currently it only returns list of known versions - those which have been indexed, for most maps it won't include all ever uploaded to Arcade.

                However, in future there might be a way to either request a full index of specific map via API. Or the service itself will try to keep the list fully up to date for maps which have been publicly hosted at least once - if it proves to be feasible.
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
        const mapHeaders = await server.conn.getRepository(S2MapHeader)
            .createQueryBuilder('mapHead')
            .select([
                'mapHead.majorVersion',
                'mapHead.minorVersion',
                'mapHead.headerHash',
                'mapHead.isPrivate',
                'mapHead.isExtensionMod',
                'mapHead.archiveHash',
                'mapHead.archiveSize',
                'mapHead.uploadedAt',
            ])
            .andWhere('mapHead.regionId = :regionId AND mapHead.bnetId = :bnetId', {
                regionId: request.params.regionId,
                bnetId: request.params.mapId,
            })
            .addOrderBy('mapHead.majorVersion', 'DESC')
            .addOrderBy('mapHead.minorVersion', 'DESC')
            .getMany()
        ;

        if (!mapHeaders.length) {
            return reply.type('application/json').code(404);
        }

        const result = {
            regionId: request.params.regionId,
            bnetId: request.params.mapId,
            versions: mapHeaders,
        };

        return reply.type('application/json').code(200).send(result);
    });
});
