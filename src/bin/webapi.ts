import * as path from 'path';
import * as dotenv from 'dotenv';
import * as fs from 'fs-extra';
import * as orm from 'typeorm';
import { fastify } from 'fastify';
import fp from 'fastify-plugin';
import fastifyStatic from 'fastify-static';
import fastifyRateLimit from 'fastify-rate-limit';
import * as fastifyOAS from 'fastify-oas';
import fastifyCors from 'fastify-cors';
import { setupFileLogger, logger } from '../logger';
import { execAsync } from '../helpers';
import { stripIndents } from 'common-tags';
import { MapResolver } from '../map/mapResolver';

dotenv.config();
setupFileLogger('webapi');

const server = fastify({
    logger: false,
    trustProxy: ['127.0.0.1'],
});
const webapiPort = Number(process.env.STARC_WEBAPI_PORT ?? 8090);

server.register(fp(async (server, opts) => {
    const conn = await orm.createConnection();
    server.decorate('conn', conn);
    server.decorate('mapResolver', new MapResolver(conn));
}));

server.addHook('onClose', async (instance, done) => {
    await instance.conn.close();
});

declare module 'fastify' {
    interface FastifyInstance {
        conn: orm.Connection;
        mapResolver: MapResolver;
    }
}

server.register(fastifyStatic, {
    root: path.resolve('data/public'),
    serve: false,
});

server.register(fastifyRateLimit, {
    global: true,
    max: 100,
    timeWindow: 1000 * 40 * 1,
});

server.register(fastifyCors, {
    origin: process.env.ENV === 'dev' ? '*' : process.env.STARC_WEBAPI_HOSTNAME_WHITELIST.split(' ').map(x => `https://${x}`),
    maxAge: 3600 * 24,
});

server.register(require('../api/plugins/cursorPagination').default);
server.register(require('../api/plugins/authManager').default);
server.register(require('../api/plugins/accessManager').default);

server.addHook('onRequest', (req, reply, done) => {
    logger.verbose(`REQ #${req.id} url=${req.url} ip=${req.ip}`);
    done();
});

server.addHook('onResponse', (req, reply, done) => {
    logger.verbose(`RES #${req.id} code=${reply.statusCode}`);
    done();
});

server.addHook('onError', (req, reply, err, done) => {
    logger.warn(`REQ #${req.id} ERR:`, err);
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
                url: process.env.ENV === 'dev' ? `http://localhost:${webapiPort}` : `https://api.sc2arcade.com`,
                description: process.env.ENV ?? ''
            },
        ],
        schemes: [
            process.env.ENV === 'dev' ? 'http' : 'https'
        ],
        consumes: ['application/json'],
        produces: ['application/json'],
        tags: [
            {
                name: 'Lobbies',
                description: stripIndents`
                    **Publicly** hosted games on Arcade.
                `,
            },
            {
                name: 'Maps',
                description: stripIndents`
                    Maps & mods published on Arcade.
                `,
            },
        ],
    }
});

server.register(require('../api/routes/account/auth/bnet').default);
server.register(require('../api/routes/account/logout').default);
server.register(require('../api/routes/account/info').default);
server.register(require('../api/routes/account/settings').default);

server.register(require('../api/routes/profile/show').default);

server.register(require('../api/routes/lobby/openGames').default);
server.register(require('../api/routes/lobby/active').default);
server.register(require('../api/routes/lobby/details').default);
server.register(require('../api/routes/lobby/mapHistory').default);
server.register(require('../api/routes/lobby/playerHistory').default);

server.register(require('../api/routes/maps/list').default);
server.register(require('../api/routes/maps/show').default);
server.register(require('../api/routes/maps/details').default);
server.register(require('../api/routes/maps/versions').default);
server.register(require('../api/routes/maps/dependencies').default);
server.register(require('../api/routes/maps/stats').default);

server.register(require('../api/routes/mapCategories').default);

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
