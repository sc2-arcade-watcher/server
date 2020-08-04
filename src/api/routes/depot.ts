import * as path from 'path';
import * as fs from 'fs-extra';
import * as fp from 'fastify-plugin';
import { BattleDepot, NestedHashDir, convertImage } from '../../depot';
import { logger } from '../../logger';
import { S2Document } from '../../entity/S2Document';

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
                const docResult = await server.conn.getRepository(S2Document)
                    .createQueryBuilder('doc')
                    .innerJoinAndSelect('doc.region', 'region')
                    .andWhere('doc.iconHash = :hash', { hash: request.params.hash })
                    .getOne()
                ;
                if (!docResult) {
                    return reply.callNotFound();
                }

                const s2mvPath = await bnDepot.getPathOrRetrieve(docResult.region.code, `${request.params.hash}.s2mv`);
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
