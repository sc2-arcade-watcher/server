import * as dotenv from 'dotenv';
import * as orm from 'typeorm';
import { setupFileLogger, logger } from '../logger';
import { systemdNotifyReady, setupProcessTerminator } from '../helpers';
import { ExecutiveServer } from '../server/executiveServer';

process.on('unhandledRejection', e => {
    if (logger) logger.error('unhandledRejection', e);
    throw e;
});
(async function () {
    dotenv.config();
    if (process.env.NOTIFY_SOCKET) {
        await systemdNotifyReady();
    }
    setupFileLogger('datahost');

    const conn = await orm.createConnection();
    const eSrv = new ExecutiveServer(conn);

    async function terminate() {
        await Promise.all([
            eSrv.close()
        ]);
        logger.verbose(`Closing database connection..`);
        await conn.close();
    }
    setupProcessTerminator(terminate);

    try {
        await eSrv.load();
    }
    catch (e) {
        logger.error('runtime error', e);
        await terminate();
    }
})();
