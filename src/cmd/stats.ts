import * as orm from 'typeorm';
import * as program from 'commander';
import { buildStatsForPeriod } from '../task/statsBuilder';
import { StatsBuilderPlayers, StatsBuilderPlayersOptionsOpt } from '../task/playerStatsBuilder';
import { S2StatsPeriodKind } from '../entity/S2StatsPeriod';
import { parseProfileHandle } from '../bnet/common';

program.command('stats:lobbies')
    .option('--daily', '', false)
    .option('--weekly', '', false)
    .option('--monthly', '', false)
    .action(async (cmd: program.Command) => {
        const conn = await orm.createConnection();

        if (cmd.daily) {
            await buildStatsForPeriod(conn, S2StatsPeriodKind.Daily);
        }
        if (cmd.weekly) {
            await buildStatsForPeriod(conn, S2StatsPeriodKind.Weekly);
        }
        if (cmd.monthly) {
            await buildStatsForPeriod(conn, S2StatsPeriodKind.Monthly);
        }

        await conn.close();
    })
;

program.command('stats:players:update')
    .option<String>('--profile <profile handle>', 'profile handle', null)
    .option<Number>('--period-days-max <number>', '', Number)
    .option<Number>('--query-concurrency <number>', '', Number)
    .action(async (cmd: program.Command) => {
        const conn = await orm.createConnection();
        const sbOpts: StatsBuilderPlayersOptionsOpt = {};

        if (cmd.periodDaysMax) sbOpts.periodDaysMax = cmd.periodDaysMax;
        if (cmd.queryConcurrency) sbOpts.queryConcurrency = cmd.queryConcurrency;

        const sbp = new StatsBuilderPlayers(conn, sbOpts);

        if (cmd.profile) {
            const requestedProfile = parseProfileHandle(cmd.profile);
            await sbp.rebuildForPlayer(requestedProfile);
        }
        else {
            await sbp.generateOverdue();
        }

        await conn.close();
    })
;
