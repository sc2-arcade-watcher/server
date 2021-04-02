import fp from 'fastify-plugin';
import { S2Map } from '../../../entity/S2Map';
import { S2Profile } from '../../../entity/S2Profile';

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
            .innerJoin('map.currentVersion', 'currRev')
            .leftJoinAndMapOne('map.author', S2Profile, 'author', 'map.regionId = author.regionId AND map.authorLocalProfileId = author.localProfileId')
            .select([
                'map.id',
                'map.regionId',
                'map.bnetId',
                'map.type',
                'map.availableLocales',
                'map.mainLocale',
                'map.mainLocaleHash',
                'map.iconHash',
                'map.thumbnailHash',
                'map.name',
                'map.description',
                'map.website',
                'map.mainCategoryId',
                'map.maxPlayers',
                'map.maxHumanPlayers',
                'map.updatedAt',
                'map.publishedAt',
                'map.userReviewsCount',
                'map.userReviewsRating',
                'map.removed',
                'currRev.id',
                'currRev.majorVersion',
                'currRev.minorVersion',
                'currRev.isPrivate',
                'currRev.archiveSize',
                'currRev.uploadedAt',
                'author.regionId',
                'author.realmId',
                'author.profileId',
                'author.name',
                'author.discriminator',
                'author.avatar',
            ])
            .andWhere('map.regionId = :regionId AND map.bnetId = :bnetId', {
                regionId: request.params.regionId,
                bnetId: request.params.mapId,
            })
            .limit(1)
            .getOne()
        ;

        if (!map) {
            return reply.code(404).send();
        }

        reply.header('Cache-control', 'public, s-maxage=30');
        return reply.code(200).send(map);
    });
});
