import { Entity, PrimaryGeneratedColumn, Column, Index, Unique, ManyToOne, OneToMany } from 'typeorm';
import { S2Region } from './S2Region';
import { BnAccount } from './BnAccount';
import { S2ProfileTracking } from './S2ProfileTracking';

@Entity()
@Unique('bnet_id', ['regionId', 'realmId', 'profileId'])
export class S2Profile {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({
        nullable: true,
    })
    nameUpdatedAt: Date;

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
        type: 'varchar',
        length: 12,
        nullable: true,
    })
    @Index()
    name: string;

    @Column({
        type: 'mediumint',
        unsigned: true,
        default: 0,
    })
    discriminator: number;

    @Column({
        default: false,
    })
    deleted: boolean;

    @ManyToOne(type => BnAccount, account => account.profiles, {
        nullable: true,
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
    })
    @Index('account_idx')
    account: BnAccount;

    @Column({
        nullable: true,
    })
    avatarUrl: string | null;

    @Column({
        nullable: true,
    })
    @Index('last_online_at_idx')
    lastOnlineAt: Date;

    tracking?: S2ProfileTracking;
}
