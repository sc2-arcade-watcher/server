import * as dotenv from 'dotenv';
import * as program from 'commander';

dotenv.config();

import '../cmd/map';
import '../cmd/profile';
import '../cmd/battle';
import '../cmd/discover';
import '../cmd/stats';
import '../cmd/s2cmd';

process.on('unhandledRejection', e => { throw e; });
program.parse(process.argv);
