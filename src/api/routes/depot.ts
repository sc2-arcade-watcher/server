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
    async function getDepotImage(region: GameRegion, hash: string) {
        const jpgPath = pubBnetDir.pathTo(`${hash}.jpg`);
        if (!(await fs.pathExists(jpgPath))) {
            const s2mvPath = await bnDepot.getPathOrRetrieve(
                GameRegion[region].toLowerCase(),
                `${hash}.s2mv`
            );
            await convertImage(s2mvPath, jpgPath, ['-format', 'jpg', '-quality', '80', '-strip']);
            await fs.unlink(s2mvPath);
        }
        return jpgPath;
    }

    server.get('/bnet/:hash(^\\w+).jpg', {
        config: {
            rateLimit: {
                max: 2000,
                timeWindow: 1000 * 60 * 10,
            },
        },
        schema: {
            params: {
                type: 'object',
                properties: {
                    hash: {
                        type: 'string',
                    },
                },
            },
        },
    }, async (request, reply) => {
        const jpgPath = pubBnetDir.pathTo(`${request.params.hash}.jpg`);
        if (!(await fs.pathExists(jpgPath))) {
            try {
                const result = await server.conn.getRepository(S2Map)
                    .createQueryBuilder('map')
                    .select(['map.regionId'])
                    .andWhere('map.iconHash = :hash', { hash: request.params.hash })
                    .getOne()
                ;
                if (!result) {
                    return reply.callNotFound();
                }

                await getDepotImage(result.regionId, request.params.hash);
            }
            catch (err) {
                logger.error(err);
                return reply.code(500);
            }
        }
        reply.header('Cache-control', 'public, max-age=604800, s-maxage=604800');
        return reply.sendFile(jpgPath, path.resolve('.'));
    });

    server.get('/depot/:region/:hash(^\\w+).jpg', {
        config: {
            rateLimit: {
                max: 2000,
                timeWindow: 1000 * 60 * 10,
            },
        },
        schema: {
            params: {
                type: 'object',
                properties: {
                    region: {
                        type: 'string',
                        enum: ['us', 'eu', 'kr', 'cn'],
                    },
                    hash: {
                        type: 'string',
                    },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const jpgPath = await getDepotImage((GameRegion as any)[request.params.region.toUpperCase()], request.params.hash);
            reply.header('Cache-control', 'public, max-age=604800, s-maxage=604800');
            return reply.sendFile(jpgPath, path.resolve('.'));
        }
        catch (err) {
            logger.error(err);
            return reply.code(500);
        }
    });
});
