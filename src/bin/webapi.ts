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
import * as fastifyCors from 'fastify-cors';
import { setupFileLogger, logger } from '../logger';
import { S2DocumentVersion } from '../entity/S2DocumentVersion';
import { S2Document } from '../entity/S2Document';
import * as http from 'http';
import * as https from 'https';
import * as http2 from 'http2';
import { execAsync } from '../helpers';
import { stripIndents } from 'common-tags';

dotenv.config();
setupFileLogger('webapi');

const server = fastify({
    logger: false,
    trustProxy: ['127.0.0.1'],
});
const webapiPort = Number(process.env.WEBAPI_PORT ?? 8090);

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

server.register(fp(async (server, opts) => {
    server.decorate('conn', await orm.createConnection());
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

server.register(fastifyCors, {
    origin: process.env.ENV === 'dev' ? '*' : `https://sc2arcade.talv.space`,
});

// @ts-ignore
server.register(fastifyPagination, {
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
                url: process.env.ENV === 'dev' ? `http://localhost:${webapiPort}` : `http://sc2arcade.talv.space/api`,
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

server.register(require('../api/routes/lobby/openGames').default);
server.register(require('../api/routes/lobby/active').default);
server.register(require('../api/routes/lobby/details').default);
server.register(require('../api/routes/lobby/mapHistory').default);
server.register(require('../api/routes/lobby/playerHistory').default);

server.register(require('../api/routes/maps/list').default);
server.register(require('../api/routes/maps/details').default);
server.register(require('../api/routes/maps/stats').default);

server.register(require('../api/routes/stats/regionStats').default);

server.register(require('../api/routes/depot').default);

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
