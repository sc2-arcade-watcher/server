import * as fp from 'fastify-plugin';
import { S2StatsPeriod, S2StatsPeriodKind } from '../../../entity/S2StatsPeriod';
import { S2StatsPeriodRegion } from '../../../entity/S2StatsPeriodRegion';
import { S2Region } from '../../../entity/S2Region';

export default fp(async (server, opts, next) => {
    server.get('/stats/regions', {
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    kind: {
                        type: 'string',
                        enum: Object.values(S2StatsPeriodKind),
                        default: S2StatsPeriodKind.Weekly,
                    },
                },
            },
        },
    }, async (request, reply) => {
        let tmpResult = await server.conn.getRepository(S2StatsPeriodRegion)
            .createQueryBuilder('stRegion')
            .select([])
            .innerJoin('stRegion.period', 'stPer')
            .addSelect('CAST(stPer.dateFrom AS CHAR)', 'date')
            .addSelect('GROUP_CONCAT(stRegion.regionId SEPARATOR \',\')', 'regions')
            .addSelect('GROUP_CONCAT(stRegion.lobbiesHosted SEPARATOR \',\')', 'lobbiesHosted')
            .addSelect('GROUP_CONCAT(stRegion.lobbiesStarted SEPARATOR \',\')', 'lobbiesStarted')
            .addSelect('GROUP_CONCAT(stRegion.participantsTotal SEPARATOR \',\')', 'participantsTotal')
            .addSelect('GROUP_CONCAT(IFNULL(stRegion.participantsUniqueTotal, \'null\') SEPARATOR \',\')', 'participantsUniqueTotal')
            .andWhere('stPer.kind = :kind', { kind: request.query.kind })
            .andWhere('stPer.completed = 1')
            .addOrderBy('stPer.dateFrom', 'ASC')
            .addOrderBy('stRegion.regionId', 'ASC')
            .groupBy('stPer.id')
            .getRawMany()
        ;

        const regions = await server.conn.getRepository(S2Region)
            .createQueryBuilder('region')
            .addOrderBy('region.id')
            .getMany()
        ;

        const regionGroupedKeys = [
            'lobbiesHosted',
            'lobbiesStarted',
            'participantsTotal',
            'participantsUniqueTotal',
        ];
        tmpResult = tmpResult.map(record => {
            for (const key of regionGroupedKeys) {
                const values = (<string>record[key]).split(',').map(x => {
                    if (x === 'null') return null;
                    return Number(x);
                });
                for (const idx in regions) {
                    record[key + regions[idx].code] = values[idx];
                }
                delete record[key];
            }
            return record;
        });

        const organizedResult = Array.from(tmpResult.entries()).sort((a, b) => a[0] - b[0]).map(x => x[1]);
        const finalResult: {[key: string]: number[]} = {};
        for (const k in organizedResult[0]) {
            finalResult[k] = organizedResult.flatMap(x => x[k]);
        }

        return reply.type('application/json').code(200).send(finalResult);
    });
});
