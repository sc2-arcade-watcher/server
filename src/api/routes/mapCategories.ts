import fp from 'fastify-plugin';
import { S2MapCategory } from '../../entity/S2MapCategory';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/map-categories', {
        schema: {
            tags: ['Maps'],
            summary: 'List of available map categories',
        },
    }, async (request, reply) => {
        const result = await server.conn.getRepository(S2MapCategory)
            .createQueryBuilder('mcat')
            .addOrderBy('id', 'ASC')
            .getMany()
        ;

        if (!result) {
            return reply.type('application/json').code(404).send();
        }

        reply.header('Cache-control', 'public, s-maxage=60');
        return reply.type('application/json').code(200).send(result);
    });
});
