import * as path from 'path';
import * as fs from 'fs-extra';
import * as fp from 'fastify-plugin';
import { BattleDepot, NestedHashDir, convertImage } from '../../depot';
import { logger } from '../../logger';
import { S2Map } from '../../entity/S2Map';
import { GameRegion } from '../../common';

const bnDepot = new BattleDepot('data/depot');
const pubBnetDir = new NestedHashDir('data/bnet');

export default fp(async (server, opts, next) => {
    server.get('/bnet/:hash(^\\w+).jpg', {
        config: {
            rateLimit: {
                max: 2000,
                timeWindow: 1000 * 60 * 10,
            },
        },
    }, async (request, reply) => {
        const jpgPath = pubBnetDir.pathTo(`${request.params.hash}.jpg`);
        if (!(await fs.pathExists(jpgPath))) {
            try {
                const result = await server.conn.getRepository(S2Map)
                    .createQueryBuilder('map')
                    .select(['regionId'])
                    .andWhere('map.iconHash = :hash', { hash: request.params.hash })
                    .getRawOne()
                ;
                if (!result) {
                    return reply.callNotFound();
                }

                const s2mvPath = await bnDepot.getPathOrRetrieve(
                    GameRegion[result.regionId].toLowerCase(),
                    `${request.params.hash}.s2mv`
                );
                await convertImage(s2mvPath, jpgPath, ['-format', 'jpg', '-quality', '85', '-strip']);
            }
            catch (err) {
                logger.error(err);
                return reply.code(503);
            }
        }
        reply.header('Cache-control', 'public, maxage=604800');
        return reply.sendFile(jpgPath, path.resolve('.'));
    });
});
