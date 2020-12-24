import fp from 'fastify-plugin';
import { stripIndents } from 'common-tags';
import { S2MapLocale } from '../../../entity/S2MapLocale';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/maps/:regionId/:mapId/locales', {
        schema: {
            tags: ['Maps'],
            summary: `Locale data`,
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
        const mapLocales = await server.conn.getRepository(S2MapLocale)
            .createQueryBuilder('mloc')
            .select([
                'mloc.locale',
                'mloc.isMain',
                'mloc.initialMajorVersion',
                'mloc.initialMinorVersion',
                'mloc.latestMajorVersion',
                'mloc.latestMinorVersion',
                'mloc.inLatestVersion',
                'mloc.tableHash',
                'mloc.originalName',
                'mloc.name',
                'mloc.description',
                'mloc.website',
            ])
            .andWhere('mloc.regionId = :regionId AND mloc.bnetId = :bnetId', {
                regionId: request.params.regionId,
                bnetId: request.params.mapId,
            })
            .orderBy('mloc.locale', 'ASC')
            .getMany()
        ;

        if (!mapLocales) {
            return reply.code(404).send();
        }

        reply.header('Cache-control', 'public, s-maxage=30');
        return reply.code(200).send(mapLocales);
    });
});
