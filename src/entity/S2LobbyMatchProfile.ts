import { Entity, PrimaryGeneratedColumn, Column, Index, ManyToOne, OneToMany, OneToOne, JoinColumn } from 'typeorm';
import { S2ProfileMatch } from './S2ProfileMatch';
import { S2GameLobby } from './S2GameLobby';

@Entity({
    engine: 'ROCKSDB',
})
export class S2LobbyMatchProfile {
    @OneToOne(type => S2GameLobby, {
        primary: true,
        nullable: false,
        // foreign keys not supported on RocksDB
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
    })
    lobby: S2GameLobby;

    @Column({
        primary: true,
        type: 'int',
        unsigned: true,
    })
    lobbyId: number;

    @OneToOne(type => S2ProfileMatch, x => x.lobbyMatchProfile, {
        primary: true,
        nullable: false,
        // foreign keys not supported on RocksDB
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
    })
    @JoinColumn()
    @Index('profile_match_idx', {
        unique: true,
    })
    profileMatch: S2ProfileMatch;

    @Column({
        primary: true,
        type: 'int',
        unsigned: true,
    })
    profileMatchId: number;
}
