require('dotenv').config();

// /** @type {import('typeorm/connection/ConnectionOptions').ConnectionOptions} */
/** @type {import('typeorm/driver/mysql/MysqlConnectionOptions').MysqlConnectionOptions} */
module.exports = {
    type: process.env.STARC_SQL_TYPE || 'mariadb',
    host: process.env.STARC_SQL_HOST || 'db',
    port: process.env.STARC_SQL_PORT ? Number(process.env.STARC_SQL_PORT) : 3306,
    username: process.env.STARC_SQL_USER || 'db',
    password: process.env.STARC_SQL_PASS || 'db',
    database: process.env.STARC_SQL_DATABASE || 'db',
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
