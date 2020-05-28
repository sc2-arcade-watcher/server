import * as path from 'path';
import * as dotenv from 'dotenv';
import * as fs from 'fs-extra';
import * as orm from 'typeorm';
import * as fastify from 'fastify';
import * as fp from 'fastify-plugin';
import * as fastifyStatic from 'fastify-static';
import * as fastifyRateLimit from 'fastify-rate-limit';
import * as fastifyPagination from 'fastify-pagination';
import * as limitOffsetPaginationStrategy from 'fastify-pagination/dist/strategies/limit-offset';
import * as fastifyOAS from 'fastify-oas';
import { setupFileLogger, logger } from '../logger';
import { S2DocumentVersion } from '../entity/S2DocumentVersion';
import { BattleDepot, NestedHashDir, convertImage } from '../depot';
import { S2Document } from '../entity/S2Document';
import * as http from 'http';
import * as https from 'https';
import * as http2 from 'http2';
import { execAsync } from '../helpers';
import { stripIndents } from 'common-tags';
import { lobbyRouter } from '../api/routes/lobby';

dotenv.config();
setupFileLogger('webapi');

const server = fastify({
    logger: false,
    trustProxy: ['127.0.0.1'],
});
const webapiPort = Number(process.env.WEBAPI_PORT ?? 8090);

const bnDepot = new BattleDepot('data/depot');
const pubBnetDir = new NestedHashDir('data/bnet');

function stripEntityIds(data: any) {
    // TODO: remove
    return data;
    if (typeof data === 'object' && data !== null) {
        if (typeof data.id === 'number') {
            delete data.id;
        }
        for (const k in data) {
            if (typeof data[k] === 'object') {
                data[k] = stripEntityIds(data[k]);
            }
        }
    }
    return data;
}

server.register(fp(async (server, opts, next) => {
    server.decorate('conn', await orm.createConnection());

    next();
}));

server.addHook('onClose', async (instance, done) => {
    await instance.conn.close();
    done();
});

declare module 'fastify' {
    export interface FastifyInstance<
    HttpServer = http.Server,
    HttpRequest = http.IncomingMessage,
    HttpResponse = http.ServerResponse
    > {
        conn: orm.Connection;
    }
}



server.register(fastifyStatic, {
    root: path.resolve('data/public'),
    serve: false,
});

server.register(fastifyRateLimit, {
    global: true,
    max: 500,
    timeWindow: 1000 * 60 * 5,
});

server.register(<any>fastifyPagination, {
    strategy: limitOffsetPaginationStrategy({
        defaultLimit: 50,
        maximumLimit: 500,
    }),
});

declare module 'fastify' {
    interface FastifyReply<HttpResponse> {
        sendWithPagination<T>(this: fastify.FastifyReply<http.ServerResponse>, page: fastifyPagination.IPage<T>): void;
    }

    interface FastifyRequest<
        HttpRequest = http.IncomingMessage,
        Query = DefaultQuery,
        Params = DefaultParams,
        Headers = DefaultHeaders,
        Body = DefaultBody
    >{
        parsePagination: fastifyPagination.PaginationParser;
    }
}

type HttpServer = http.Server | http2.Http2Server | http2.Http2SecureServer | https.Server;
type HttpRequest = http.IncomingMessage | http2.Http2ServerRequest;
type HttpResponse = http.ServerResponse | http2.Http2ServerResponse;

server.decorateReply('expires', function (this: fastify.FastifyReply<HttpResponse>, date: Date) {
    if (!date) return this;
    this.header('Expires', (Date.prototype.isPrototypeOf(date)) ? date.toUTCString() : date);
    return this;
});

server.addHook('onRequest', (req, reply, done) => {
    logger.verbose(`REQ #${req.id} url=${req.req.url} ip=${req.ip}`);
    done();
});

server.addHook('onResponse', (req, reply, done) => {
    logger.verbose(`RES #${req.id} code=${reply.res.statusCode}`);
    done();
});

server.register(fastifyOAS, <fastifyOAS.FastifyOASOptions>{
    routePrefix: '/docs/api',
    exposeRoute: true,
    hideUntagged: true,
    swagger: {
        info: {
            title: 'StarCraft II Arcade API (Unofficial)',
            description: fs.readFileSync('WEBAPI.md', 'utf8'),
        },
        servers: [
            {
                url: process.env.ENV === 'dev' ? `http://localhost:${webapiPort}` : `http://sc2arcade.talv.space:${webapiPort}/api`,
                description: process.env.ENV ?? ''
            },
        ],
        schemes: ['http'],
        consumes: ['application/json'],
        produces: ['application/json'],
        tags: [
            {
                name: 'Lobbies',
                description: stripIndents`
                    Publicly hosted games on Arcade.\n
                    **Privately hosted games aren't supported** and most likely never will.
                `,
            },
            {
                name: 'Maps',
                description: stripIndents`
                    Maps & mods published on the Battle.net. Currently database is limited to maps that have been hosted at least once since this project has started. At this time it's the only method of populating the database. I've began working on improvements in that area, with the goal to include every single map published to Battle.net. With ability to auto-discover newly published documents, even before they're hosted for the first time.
                `,
            },
        ],
    }
});

server.register(lobbyRouter);

server.get('/maps/:regionId', {
    schema: {
        tags: ['Maps'],
        summary: 'List of maps',
        params: {
            type: 'object',
            required: ['regionId'],
            properties: {
                regionId: {
                    type: 'number',
                },
            }
        },
    },
}, async (request, reply) => {
    const { limit, offset } = request.parsePagination();

    const [ result, count ] = await server.conn.getRepository(S2Document)
        .createQueryBuilder('mapDoc')
        .leftJoinAndMapOne(
            'mapDoc.currentVersion',
            S2DocumentVersion,
            'currentVersion',
            'currentVersion.document = mapDoc.id AND currentVersion.majorVersion = mapDoc.currentMajorVersion AND currentVersion.minorVersion = mapDoc.currentMinorVersion'
        )
        .andWhere('mapDoc.regionId = :regionId', { regionId: request.params.regionId })
        .take(limit)
        .skip(offset)
        .getManyAndCount()
    ;

    reply.header('Cache-control', 'public, s-maxage=60');
    return reply.type('application/json').code(200).sendWithPagination({ count: count, page: stripEntityIds(result) });
});

server.get('/maps/:region/:mapId', {
    schema: {
        tags: ['Maps'],
        summary: 'Details about specific map',
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
    const result = await server.conn.getRepository(S2Document)
        .createQueryBuilder('mapDoc')
        .innerJoinAndMapOne('mapDoc.currentVersion', 'mapDoc.docVersions', 'currentVersion', 'currentVersion.document = mapDoc.id')
        .andWhere('(currentVersion.majorVersion = mapDoc.currentMajorVersion AND currentVersion.minorVersion = mapDoc.currentMinorVersion)')
        .innerJoinAndSelect('mapDoc.docVersions', 'mapDocVer')
        .andWhere('mapDoc.region = :region', { region: request.params.region })
        .andWhere('mapDoc.bnetId = :bnetId', { bnetId: request.params.mapId })
        .addOrderBy('mapDocVer.majorVersion', 'DESC')
        .addOrderBy('mapDocVer.minorVersion', 'DESC')
        .getOne()
    ;

    if (!result) {
        return reply.type('application/json').code(404).send();
    }

    reply.header('Cache-control', 'public, s-maxage=60');
    return reply.type('application/json').code(200).send(stripEntityIds(result));
});

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

process.on('unhandledRejection', e => { throw e; });
(async function() {
    if (process.env.NOTIFY_SOCKET) {
        const r = await execAsync('systemd-notify --ready');
        logger.verbose(`systemd-notify`, r);
    }

    server.listen(webapiPort, process.env.ENV === 'dev' ? '127.0.0.1' : '0.0.0.0', (err, address) => {
        if (err) throw err;
        logger.info(`server.listen port=${webapiPort}`);
        logger.verbose('routes\n' + server.printRoutes());
    });

    async function terminate(sig: NodeJS.Signals) {
        logger.info(`Received ${sig}`);
        await server.close();
    }

    process.on('SIGTERM', terminate);
    process.on('SIGINT', terminate);
})();
