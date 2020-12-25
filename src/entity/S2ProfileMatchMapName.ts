import { Entity, PrimaryGeneratedColumn, Column, Index, ManyToOne } from 'typeorm';
import { S2ProfileMatch } from './S2ProfileMatch';
import { GameLocaleFlag } from '../common';

@Entity({
    engine: 'ROCKSDB',
})
export class S2ProfileMatchMapName {
    @ManyToOne(type => S2ProfileMatch, match => match.names, {
        primary: true,
        nullable: false,
        // foreign keys not supported on RocksDB
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
    })
    @Index('match_idx')
    match: S2ProfileMatch;

    @Column({
        primary: true,
        type: 'int',
        unsigned: true,
    })
    matchId: number;

    @Column({
        primary: true,
        type: 'int',
        unsigned: true,
    })
    locales: GameLocaleFlag;

    @Column({
        type: 'varchar',
        collation: 'utf8mb4_bin',
    })
    name: string;
}
