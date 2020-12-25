import * as orm from 'typeorm';

export class BattleMatchTracker {
    constructor (protected conn: orm.Connection) {
    }
}
