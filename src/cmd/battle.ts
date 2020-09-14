import * as util from 'util';
import * as orm from 'typeorm';
import * as program from 'commander';
import * as pMap from 'p-map';
import { BattleAPI } from '../bnet/battleAPI';
import { BattleDataUpdater } from '../bnet/battleData';

program.command('battle:token')
    .action(async () => {
        const bAPI = new BattleAPI();
        // const tokenInfo = await bAPI.oauth.acquireToken({ grantType: 'client_credentials' });
        // console.log(tokenInfo.data);

        const sc2Profiles = await bAPI.sc2.getAccount(128747765);
        console.log(sc2Profiles.data);

        // for (const profile of sc2Profiles.data) {
        //     console.log(profile);
        //     const mhistResult = await bAPI.sc2.getMatchHistory(profile.regionId, profile.realmId, profile.profileId);
        //     console.log(mhistResult.data);
        // }

        // const conn = await orm.createConnection();
        // await conn.close();
    })
;

program.command('battle:sync-account')
    .option<Number>('--id [number]', 'account id', (value, previous) => Number(value), null)
    .action(async (cmd: program.Command) => {
        const conn = await orm.createConnection();
        const bData = new BattleDataUpdater(conn);

        if (cmd.id) {
            await bData.updateAccount(cmd.id);
        }

        await conn.close();
    })
;
