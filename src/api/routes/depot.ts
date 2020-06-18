import * as path from 'path';
import * as fs from 'fs-extra';
import * as fp from 'fastify-plugin';
import { BattleDepot, NestedHashDir, convertImage } from '../../depot';
import { logger } from '../../logger';
import { S2DocumentVersion } from '../../entity/S2DocumentVersion';

const bnDepot = new BattleDepot('data/depot');
const pubBnetDir = new NestedHashDir('data/bnet');

export default fp(async (server, opts, next) => {
    server.get('/bnet/:hash(^\\w+).jpg', {
        // schema: {
        //     tags: ['Battle.net depot'],
        // },
    }, async (request, reply) => {
        const jpgPath = pubBnetDir.pathTo(`${request.params.hash}.jpg`);
        if (!(await fs.pathExists(jpgPath))) {
            try {
                const docResult = await server.conn.getRepository(S2DocumentVersion)
                    .createQueryBuilder('docVer')
                    .innerJoinAndSelect('docVer.document', 'doc')
                    .innerJoinAndSelect('doc.region', 'region')
                    .andWhere('docVer.iconHash = :hash', { hash: request.params.hash })
                    .getOne()
                ;
                if (!docResult) {
                    return reply.callNotFound();
                }

                const s2mvPath = await bnDepot.getPathOrRetrieve(docResult.document.region.code, `${request.params.hash}.s2mv`);
                await convertImage(s2mvPath, jpgPath, ['-format', 'jpg', '-quality', '85', '-strip']);
            }
            catch (err) {
                logger.error(err);
                return reply.code(503);
            }
        }
        return reply.sendFile(jpgPath, path.resolve('.'));
    });
});
