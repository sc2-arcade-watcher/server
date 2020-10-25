import fp from 'fastify-plugin';
import { S2MapHeader } from '../../../entity/S2MapHeader';
import { stripIndents } from 'common-tags';
import { S2Map } from '../../../entity/S2Map';
import { MapAccessAttributes } from '../../plugins/accessManager';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/maps/:regionId/:mapId/versions', {
        schema: {
            tags: ['Maps'],
            summary: 'List of all versions of specific map.',
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
        // TODO: pagination
        const qb = server.conn.getRepository(S2MapHeader)
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
        ;

        const mapHeaders = await qb.getMany();

        if (!mapHeaders.length) {
            return reply.code(404).send();
        }

        const currentVersion = Object.assign(<S2MapHeader>{
            regionId: request.params.regionId,
            bnetId: request.params.mapId,
        }, mapHeaders[0]);

        const [canDownload, canDownloadPrivateRevision] = await server.accessManager.isMapAccessGranted(
            [MapAccessAttributes.Download, MapAccessAttributes.DownloadPrivateRevision],
            currentVersion,
            request.userAccount
        );

        if (!canDownload) {
            mapHeaders.forEach(rev => {
                rev.headerHash = null;
                rev.archiveHash = null;
            });
        }
        else if (!canDownloadPrivateRevision) {
            mapHeaders.forEach(rev => {
                if (!rev.isPrivate) return;
                rev.headerHash = null;
                rev.archiveHash = null;
            });
        }

        return reply.code(200).send({
            regionId: request.params.regionId,
            bnetId: request.params.mapId,
            versions: mapHeaders,
        });
    });
});
