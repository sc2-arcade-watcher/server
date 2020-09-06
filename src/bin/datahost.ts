import * as dotenv from 'dotenv';
import { setupFileLogger } from '../logger';
import { systemdNotifyReady, setupProcessTerminator } from '../helpers';
import { ExecutiveServer } from '../server/executiveServer';

process.on('unhandledRejection', e => { throw e; });
(async function () {
    dotenv.config();
    setupFileLogger('datahost');
    const esrv = new ExecutiveServer();
    setupProcessTerminator(esrv.close.bind(esrv));
    if (process.env.NOTIFY_SOCKET) {
        await systemdNotifyReady();
    }
    await esrv.load();
})();
