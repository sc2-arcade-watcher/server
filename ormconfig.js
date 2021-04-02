require('dotenv').config();

// /** @type {import('typeorm/connection/ConnectionOptions').ConnectionOptions} */
/** @type {import('typeorm/driver/mysql/MysqlConnectionOptions').MysqlConnectionOptions} */
module.exports = {
    type: process.env.STARC_SQL_TYPE,
    host: process.env.STARC_SQL_HOST,
    port: Number(process.env.STARC_SQL_PORT),
    username: process.env.STARC_SQL_USER,
    password: process.env.STARC_SQL_PASS,
    database: process.env.STARC_SQL_DATABASE,
    charset: 'utf8mb4',
    timezone: '+00:00',
    synchronize: false,
    logging: process.env.STARC_SQL_LOGGING || 'error',
    namingStrategy: new (require('typeorm-naming-strategies').SnakeNamingStrategy)(),
    entities: [
        'out/src/entity/**/*.js'
    ],
    migrations: [
        'out/src/migration/**/*.js'
    ],
    subscribers: [
        'out/src/subscriber/**/*.js'
    ],
    supportBigNumbers: true,
    bigNumberStrings: false,
    cache: {
        type: 'database',
        tableName: 'tmp_query_cache',
    },
    extra: {
        connectionLimit: process.env.STARC_SQL_CONNECTION_LIMIT ? Number(process.env.STARC_SQL_CONNECTION_LIMIT) : 10,
    },
};
