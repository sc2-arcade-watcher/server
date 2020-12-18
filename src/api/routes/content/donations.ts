import fp from 'fastify-plugin';
import * as fs from 'fs-extra';
import * as csvParse from 'csv-parse';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/content/donations', {
        schema: {
            hide: true,
        },
    }, async (request, reply) => {
        const donations = (await new Promise(async (resolve, reject) => {
            csvParse(await fs.readFile('data/content/donations.csv'), {
                columns: true,
                cast: (value, context) => {
                    if (context.column === 'amount') return Number(value);
                    return value;
                },
            }, (err, records, info) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(records);
            });
        }) as any[]).reverse();

        reply.header('Cache-control', 'public, s-maxage=60');
        return reply.code(200).send({
            donations,
        });
    });
});
