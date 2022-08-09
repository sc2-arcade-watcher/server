import { tmpdir } from 'os';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as program from 'commander';
import { BattleDepot, convertImage, NestedHashDir } from '../depot';

program.command('depot-test')
    .action(async () => {
        const tmpData = tmpdir();

        const bnDepot = new BattleDepot(path.join(tmpData, 'data', 'depot'));
        const pubBnetDir = new NestedHashDir(path.join(tmpData, 'data', 'bnet'));
        const filename = '18d81abcc4847b567bc73891213fa29d6f4c9478a142baaa805837350ec3ff2a';
        const s2mvPath = await bnDepot.getPathOrRetrieve('us', `${filename}.s2mv`);
        const jpgPath = pubBnetDir.pathTo(`${filename}.jpg`);
        await convertImage(s2mvPath, jpgPath, ['-format', 'jpg', '-quality', '85', '-strip']);

        fs.rmdir(tmpData);
    })
;
