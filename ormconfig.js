require('dotenv').config();

module.exports = {
    "type": process.env.SQL_TYPE,
    "host": "localhost",
    "port": 3306,
    "username": process.env.SQL_USER,
    "password": process.env.SQL_PASS,
    "database": process.env.SQL_DATABASE,
    "charset": "utf8mb4",
    "timezone": "+00:00",
    "synchronize": false,
    "logging": Boolean(process.env.SQL_LOGGING || false),
    "namingStrategy": new (require('typeorm-naming-strategies').SnakeNamingStrategy)(),
    "entities": [
        "out/src/entity/**/*.js"
    ],
    "migrations": [
        "out/src/migration/**/*.js"
    ],
    "subscribers": [
        "out/src/subscriber/**/*.js"
    ],
    "supportBigNumbers": true,
    "bigNumberStrings": true,
    "cache": {
        "type": "database",
        "tableName": "tmp_query_cache",
    },
};
