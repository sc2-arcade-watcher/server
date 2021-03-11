import { Entity, PrimaryGeneratedColumn, Column, Index, ManyToOne, OneToMany, OneToOne, JoinColumn } from 'typeorm';
import { S2GameLobby } from './S2GameLobby';
import { S2LobbyMatchProfile } from './S2LobbyMatchProfile';
import { S2ProfileMatch } from './S2ProfileMatch';

export enum S2LobbyMatchResult {
    Success = 0,
    MapInfoMissing = 1,
    SlotsDataMissing = 2,
    HumanSlotCountMissmatch = 3,
    HumanSlotProfileMissing = 4,
    HumanSlotDataCorrupted = 5,
    UncertainTimestampAdditionalMatches = 6,
    DidNotStart = 7,
    UncertainTimestampPlayerDuplicates = 8,
    Unknown = 255,
}

@Entity({
    engine: 'ROCKSDB',
})
export class S2LobbyMatch {
    @OneToOne(type => S2GameLobby, x => x.match, {
        primary: true,
        nullable: false,
        // foreign keys not supported on RocksDB
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
    })
    @JoinColumn()
    // probably not needed due to lobbyId being first part of PK (and the only part)
    // @Index('lobby_idx', { unique: true })
    lobby: S2GameLobby;

    @Column({
        primary: true,
        type: 'int',
        unsigned: true,
    })
    lobbyId: number;

    @Column({
        type: 'tinyint',
        unsigned: true,
        nullable: false,
    })
    result: S2LobbyMatchResult;

    @Column({
        precision: 0,
        nullable: true,
    })
    completedAt: Date | null;

    lobbyMatchProfiles?: S2LobbyMatchProfile[];

    profileMatches?: S2ProfileMatch[];
}
