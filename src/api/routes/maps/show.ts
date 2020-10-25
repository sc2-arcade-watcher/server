import fp from 'fastify-plugin';
import { S2Map } from '../../../entity/S2Map';
import { MapAccessAttributes } from '../../plugins/accessManager';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/maps/:regionId/:mapId', {
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
            .leftJoin('map.author', 'author')
            .addSelect([
                'author.regionId',
                'author.realmId',
                'author.profileId',
                'author.name',
                'author.discriminator',
                'author.avatarUrl',
            ])
            .andWhere('map.regionId = :regionId AND map.bnetId = :bnetId', {
                regionId: request.params.regionId,
                bnetId: request.params.mapId,
            })
            .getOne()
        ;

        if (!map) {
            return reply.code(404).send();
        }

        // TODO: don't provide these attributes in this endpoint to avoid this check?
        const canDownload = await server.accessManager.isMapAccessGranted(MapAccessAttributes.Download, map, request.userAccount);
        if (!canDownload) {
            map.currentVersion.headerHash = null;
            map.currentVersion.archiveHash = null;
        }

        return reply.code(200).send(map);
    });
});
