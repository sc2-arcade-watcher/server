import * as path from 'path';
import { spawn } from 'child_process';
import * as fs from 'fs-extra';
import * as orm from 'typeorm';
import * as fastify from 'fastify';
import * as fastifyStatic from 'fastify-static';
import * as fastifyRateLimit from 'fastify-rate-limit';
import * as fastifyPagination from 'fastify-pagination';
import * as limitOffsetPaginationStrategy from 'fastify-pagination/dist/strategies/limit-offset';
import * as fastifyOAS from 'fastify-oas';
import { S2GameLobby } from '../entity/S2GameLobby';
import { GameLobbyStatus } from '../gametracker';
import { setupFileLogger, logger } from '../logger';
import { S2DocumentVersion } from '../entity/S2DocumentVersion';
import { BattleDepot, NestedHashDir, convertImage } from '../depot';
import { S2Document } from '../entity/S2Document';
import * as http from 'http';
import * as https from 'https';
import * as http2 from 'http2';
import { execAsync } from '../helpers';
import { S2GameLobbySlotKind } from '../entity/S2GameLobbySlot';
import { stripIndents } from 'common-tags';

setupFileLogger('webapi');
let conn: orm.Connection;
const server = fastify({
    logger: false,
    trustProxy: ['127.0.0.1'],
});
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

// server.addHook('onSend', (req, reply, payload, done) => {
//     logger.verbose(`SEND #${req.id} code=${reply.res.statusCode}`);
//     if (reply.getHeader('Content-type').indexOf('application/json') !== -1) {
//         console.log(payload);
//     }
//     done();
// });

server.register(fastifyOAS, <fastifyOAS.FastifyOASOptions>{
    routePrefix: '/docs/api',
    exposeRoute: true,
    hideUntagged: true,
    swagger: {
        info: {
            title: 'StarCraft II Arcade API (Unofficial)',
            description: stripIndents`
                This API is provided free of charge for non profit use.

                Anyone with intentions to utilize it to build something for a wider audience should first seek approval.

                ---

                ### Where does this data come form?

                It's collected by bots. They take use of game protocol to gain access to live data such as list of open lobbies. \\
                ...

                ### Is this project open source?

                Not yet, however I plan to open source as soon as I feel comfortable doing so - there are some security concerns I need to address first, before making that move. It's likely a matter of days/weeks.

                However, only half of this project will be open-sourced - the non critical part of it. That is all the services which are responsible of handling the data feed provided by SC2 bots.

                Code of everything that interacts with internal system of Battle.net servers will stay private. The reason behind that is to keep this project alive as long as possible. Since the bots could've been abused in ways I'd not like. Such as disrupting the arcade by bot-hosting lobbies etc. Which in turn could attract Blizzard's attention and that would likely affect longevity of this service in one way or another.

                ### Rate limiting

                Current limits are: up to 500 requests in the span of 5 minutes.

                ### Pagination

                ...

                ---

                *// Talv*
            `,
        },
        servers: [
            { url: 'http://localhost:8090', description: 'development' },
            {
                url: 'https://<production-url>',
                description: 'production'
            }
        ],
        schemes: ['http'],
        consumes: ['application/json'],
        produces: ['application/json'],
        tags: [
            {
                name: 'Lobbies',
                description: stripIndents`
                    Publicly hosted games on Arcade.\n
                    **Privately hosted lobbies aren't supported** by this service and likely never will due to technical limitations.
                `,
            },
            {
                name: 'Maps',
                description: stripIndents`
                    Maps & mods published on the Battle.net. Currently database is limited to maps that have been hosted at least once since this project has started (~1 Feb 2020). At this time it's the only method of populating the database. I've began working on improvements in that regard, with the goal to include every single map published to Battle.net. With ability to auto-discover newly published documents, even before they're hosted for the first time.
                `,
            },
        ],
    }
});

server.get('/lobbies/active', {
    schema: {
        tags: ['Lobbies'],
        summary: 'Open and recently closed lobbies',
    },
}, async (request, reply) => {
    const result = await conn.getRepository(S2GameLobby)
        .createQueryBuilder('lobby')
        .leftJoinAndSelect('lobby.slots', 'slot')
        .leftJoinAndSelect('slot.profile', 'profile')
        // .leftJoinAndSelect('lobby.joinHistory', 'joinHistory')
        // .leftJoinAndSelect('joinHistory.profile', 'joinHistoryProfile')
        .andWhere('lobby.status = :status OR lobby.closedAt >= FROM_UNIXTIME(UNIX_TIMESTAMP()-20)', { status: GameLobbyStatus.Open })
        .addOrderBy('lobby.createdAt', 'ASC')
        .addOrderBy('slot.slotNumber', 'ASC')
        .getMany()
    ;

    reply.header('Cache-control', 'public, s-maxage=1');
    return reply.type('application/json').code(200).send(stripEntityIds(result));
});

/** @depracated */
server.get('/open-games', async (request, reply) => {
    const result = await conn.getRepository(S2GameLobby)
        .createQueryBuilder('lobby')
        .select([
            'lobby.bnetBucketId',
            'lobby.bnetRecordId',
            'lobby.createdAt',
            'lobby.closedAt',
            'lobby.status',
            'lobby.mapVariantIndex',
            'lobby.mapVariantMode',
            'lobby.lobbyTitle',
            'lobby.hostName',
            'lobby.slotsHumansTotal',
            'lobby.slotsHumansTaken',
        ])
        .innerJoinAndSelect('lobby.region', 'region')
        .innerJoinAndSelect('lobby.mapDocumentVersion', 'mapDocVer')
        .innerJoinAndSelect('mapDocVer.document', 'mapDoc')
        .innerJoinAndSelect('mapDoc.category', 'mapCategory')
        .leftJoinAndSelect('lobby.slots', 'slot')
        .andWhere('lobby.status = :status OR lobby.closedAt >= FROM_UNIXTIME(UNIX_TIMESTAMP()-20)', { status: GameLobbyStatus.Open })
        .addOrderBy('lobby.createdAt', 'ASC')
        .addOrderBy('slot.slotNumber', 'ASC')
        .getMany()
    ;

    result.map(s2lobby => {
        (<any>s2lobby).mapVariantCategory = s2lobby.mapDocumentVersion.document.category.name;
        (<any>s2lobby).players = s2lobby.slots.map(s2slot => {
            if (s2slot.kind !== S2GameLobbySlotKind.Human) return;
            return {
                joinedAt: s2slot.joinInfo?.joinedAt ?? s2lobby.createdAt,
                leftAt: null,
                name: s2slot.name,
            };
        }).filter(x => x !== void 0);
        delete s2lobby.slots;
    });

    reply.header('Cache-control', 'public, s-maxage=1');
    return reply.type('application/json').code(200).send(stripEntityIds(result));
});

server.get('/lobbies/:regionId/:bnetBucketId/:bnetRecordId', {
    schema: {
        tags: ['Lobbies'],
        summary: 'Lobby details',
        params: {
            type: 'object',
            required: ['regionId', 'bnetBucketId', 'bnetRecordId'],
            properties: {
                regionId: {
                    type: 'number',
                },
                bnetBucketId: {
                    type: 'number',
                },
                bnetRecordId: {
                    type: 'number',
                },
            }
        },
    },
}, async (request, reply) => {
    const result = await conn.getRepository(S2GameLobby)
        .createQueryBuilder('lobby')
        .leftJoinAndSelect('lobby.slots', 'slot')
        .leftJoinAndSelect('slot.profile', 'profile')
        .andWhere('lobby.regionId = :regionId AND lobby.bnetBucketId = :bnetBucketId AND lobby.bnetRecordId = :bnetRecordId', {
            regionId: request.params.regionId,
            bnetBucketId: request.params.bnetBucketId,
            bnetRecordId: request.params.bnetRecordId,
        })
        .addOrderBy('slot.slotNumber', 'ASC')
        .getOne()
    ;

    if (!result) {
        return reply.type('application/json').code(404).send();
    }

    return reply.type('application/json').code(200).send(stripEntityIds(result));
});

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

    const [ result, count ] = await conn.getRepository(S2Document)
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
    },
}, async (request, reply) => {
    const result = await conn.getRepository(S2Document)
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

server.get('/maps/:region/:mapId/recent-games', {
    schema: {
        tags: ['Maps'],
        summary: 'Games history for specific map',
    },
}, async (request, reply) => {
    const { limit, offset } = request.parsePagination();

    // requesting total count of matching rows gets progressively more expensive, especially for very popular maps (Direct Strike..)
    // however, fetching just a slice of rows at any offset is fast, regardless of the sorting direction
    // TODO: consider caching `count` result independetly from rows, with much higher cache duration
    const [ result, count ] = await conn.getRepository(S2GameLobby)
        .createQueryBuilder('lobby')
        .select(['lobby.bnetBucketId', 'lobby.bnetRecordId', 'lobby.closedAt'])
        .andWhere('lobby.regionId = :region', { region: request.params.region })
        .andWhere('lobby.mapBnetId = :bnetId', { bnetId: request.params.mapId })
        .andWhere('lobby.status = :status', { status: GameLobbyStatus.Started })
        .addOrderBy('lobby.id', 'ASC')
        .take(limit)
        .skip(offset)
        .cache(60000)
        .getManyAndCount()
    ;

    reply.header('Cache-control', 'public, s-maxage=60');
    return reply.type('application/json').code(200).sendWithPagination({ count: count, page: stripEntityIds(result) });
});

server.get('/bnet/:hash(^\\w+).jpg', {
    schema: {
        tags: ['Battle.net depot'],
    },
}, async (request, reply) => {
    const jpgPath = pubBnetDir.pathTo(`${request.params.hash}.jpg`);
    if (!(await fs.pathExists(jpgPath))) {
        try {
            const docResult = await conn.getRepository(S2DocumentVersion)
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
    conn = await orm.createConnection();

    if (process.env.NOTIFY_SOCKET) {
        const r = await execAsync('systemd-notify --ready');
        logger.verbose(`systemd-notify`, r);
    }

    server.listen(8090, '127.0.0.1', (err, address) => {
        if (err) throw err;
        logger.info(`server.listen`);
        logger.verbose('routes\n' + server.printRoutes());
    });

    async function terminate(sig: NodeJS.Signals) {
        logger.info(`Received ${sig}`);
        await server.close();
        await conn.close();
    }

    process.on('SIGTERM', terminate);
    process.on('SIGINT', terminate);
})();
