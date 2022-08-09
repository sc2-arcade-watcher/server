import * as path from 'path';
import * as fs from 'fs-extra';
import fp from 'fastify-plugin';
import { BattleDepot, NestedHashDir, convertImage } from '../../depot';
import { logger } from '../../logger';
import { GameRegion } from '../../common';
import { isAxiosError } from '../../helpers';

const bnDepot = new BattleDepot('data/public/depot');
const pubBnetDir = new NestedHashDir('data/public/bnet');

export default fp(async (server, opts) => {
    async function getDepotImage(hash: string, region?: GameRegion) {
        const jpgPath = pubBnetDir.pathTo(`${hash}.jpg`);

        if (!(await fs.pathExists(jpgPath))) {
            if (!region) return 400;

            let s2mvPath: string;
            try {
                s2mvPath = await bnDepot.getPathOrRetrieve(
                    GameRegion[region].toLowerCase(),
                    `${hash}.s2mv`
                );
            }
            catch (err) {
                try {
                    const res = await bnDepot.retrieveHead(
                        GameRegion[region].toLowerCase(),
                        `${hash}.s2mv`
                    );
                }
                catch (secErr) {
                    if (isAxiosError(secErr)) {
                        return secErr.response.status;
                    }
                }

                throw err;
            }

            await convertImage(s2mvPath, jpgPath, ['-format', 'jpg', '-quality', '80', '-strip']);
            await fs.unlink(s2mvPath);
        }
        return jpgPath;
    }

    server.get<{
        Querystring: any,
        Params: any,
    }>('/dimg/:hash(^\\w+).jpg', {
        config: {
            rateLimit: false,
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
            querystring: {
                type: 'object',
                properties: {
                    region: {
                        type: 'string',
                        enum: ['us', 'eu', 'kr', 'cn'],
                    },
                },
            },
        },
    }, async (request, reply) => {
        let regionCode: GameRegion;
        if (request.query.region) {
            regionCode = (GameRegion as any)[request.query.region.toUpperCase()];
        }

        try {
            const dpResult = await getDepotImage(request.params.hash, regionCode);
            if (typeof dpResult === 'number') {
                return reply.code(dpResult).send();
            }

            reply.header('Cache-control', 'public, max-age=2592000, s-maxage=2592000');
            return reply.sendFile(dpResult, path.resolve('.'));
        }
        catch (err) {
            logger.error(err);
            return reply.code(500).send();
        }
    });
});
