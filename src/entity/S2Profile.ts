import { Entity, PrimaryGeneratedColumn, Column, Index, Unique, ManyToOne, OneToMany } from 'typeorm';
import { S2ProfileTracking } from './S2ProfileTracking';
import { S2ProfileAccountLink } from './S2ProfileAccountLink';
import { PlayerProfileParams } from '../bnet/common';
import { localProfileId } from '../common';
import { S2ProfileBattleTracking } from './S2ProfileBattleTracking';

export interface BareS2Profile {
    regionId: number;
    realmId: number;
    profileId: number;
    name: string;
    discriminator: number;
    profileGameId?: number;
    battleTag?: string;
    avatar?: string;
    deleted?: boolean;
    lastOnlineAt?: Date;
}

@Entity()
@Unique('bnet_id', ['regionId', 'realmId', 'profileId'])
@Unique('local_profile_region_idx', ['localProfileId', 'regionId'])
@Unique('profile_game_region_idx', ['profileGameId', 'regionId'])
export class S2Profile implements BareS2Profile {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({
        unsigned: true,
        type: 'int',
    })
    localProfileId: number;

    @Column({
        unsigned: true,
        type: 'tinyint',
    })
    regionId: number;

    @Column({
        type: 'tinyint',
        unsigned: true,
    })
    realmId: number;

    @Column({
        unsigned: true,
    })
    profileId: number;

    @Column({
        type: 'bigint',
        unsigned: true,
        nullable: true,
    })
    profileGameId: number;

    @Column({
        type: 'varchar',
        length: 12,
        nullable: true,
    })
    @Index()
    name: string;

    @Column({
        type: 'mediumint',
        unsigned: true,
    })
    discriminator: number;

    @Column({
        type: 'varchar',
        length: 32,
        nullable: true,
    })
    @Index('battle_tag_idx')
    battleTag: string;

    @Column({
        type: 'varchar',
        length: 12,
        collation: 'ascii_bin',
        nullable: false,
    })
    @Index('avatar_idx')
    avatar: string;

    @Column({
        default: false,
    })
    deleted: boolean;

    @Column({
        nullable: true,
    })
    @Index('last_online_at_idx')
    lastOnlineAt: Date | null;

    tracking?: S2ProfileTracking;

    battleTracking?: S2ProfileBattleTracking;

    accountLink?: S2ProfileAccountLink;

    get fullname(): string {
        return `${this.name}#${this.discriminator}`;
    }

    get fullnameWithHandle(): string {
        return `${this.name}#${this.discriminator} [${this.phandle}]`;
    }

    get phandle(): string {
        return `${this.regionId}-S2-${this.realmId}-${this.profileId}`;
    }

    get nameAndId(): string {
        return `${this.name} [${this.regionId}-S2-${this.realmId}-${this.profileId}]`;
    }

    get nameAndIdPad(): string {
        return `${this.regionId}-S2-${this.realmId}-${this.profileId.toString().padEnd(8, ' ')} ${this.name}`;
    }

    static create(params: PlayerProfileParams) {
        const prof = new S2Profile();

        if (params.regionId > 6 || params.regionId <= 0) throw new Error('regionId > 6');
        if (params.realmId > 2 || params.realmId <= 0) throw new Error('realmId > 2');

        prof.name = null;
        prof.discriminator = 0;
        prof.avatar = '';
        prof.deleted = false;
        prof.profileGameId = null;

        Object.assign(prof, params);
        prof.localProfileId = localProfileId(params);

        return prof;
    }
}
