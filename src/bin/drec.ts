
import * as dotenv from 'dotenv';
import * as orm from 'typeorm';
import { setupFileLogger, logger } from '../logger';
import { systemdNotifyReady, setupProcessTerminator } from '../helpers';
import { DataRecordPersistence } from '../proc/dataPersistence';

process.on('unhandledRejection', e => {
    if (logger) logger.error('unhandledRejection', e);
    throw e;
});
(async function () {
    dotenv.config();
    if (process.env.NOTIFY_SOCKET) {
        await systemdNotifyReady();
    }
    setupFileLogger('drec');

    const conn = await orm.createConnection();
    const dataRec = new DataRecordPersistence(conn);
    await dataRec.start();

    setupProcessTerminator(async () => {
        await dataRec.shutdown();
    });

    await dataRec.onDone();
    logger.verbose(`Closing database connection..`);
    await conn.close();
})();
