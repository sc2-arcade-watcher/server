import { Entity, PrimaryGeneratedColumn, Column, Index, Unique, ManyToOne, OneToMany } from 'typeorm';
import { S2GameLobby } from './S2GameLobby';

export enum S2GameLobbyMapKind {
    Map = 'map',
    ExtensionMod = 'extension_mod',
    MultiMod = 'multi_mod',
}

@Entity()
@Index('region_bnet_idx', ['regionId', 'bnetId'])
export class S2GameLobbyMap {
    @PrimaryGeneratedColumn()
    id: number;

    @ManyToOne(type => S2GameLobby, {
        nullable: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @Index('lobby_idx')
    lobby: S2GameLobby;

    @Column({
        type: 'tinyint',
        unsigned: true,
    })
    regionId: number;

    @Column({
        type: 'mediumint',
        unsigned: true,
    })
    bnetId: number;

    @Column({
        type: 'enum',
        enum: S2GameLobbyMapKind,
    })
    type: S2GameLobbyMapKind;
}
