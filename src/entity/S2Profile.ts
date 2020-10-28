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
        unsigned: true,
        nullable: true,
    })
    accountId: number | null;

    /**
     * determines whether profile origin has been verified through Blizzard API
     */
    @Column({
        default: false,
    })
    accountVerified: boolean;

    @Column({
        nullable: true,
    })
    avatarUrl: string | null;

    @Column({
        nullable: true,
    })
    @Index('last_online_at_idx')
    lastOnlineAt: Date | null;

    tracking?: S2ProfileTracking;

    get fullname(): string {
        return `${this.name}#${this.discriminator}`;
    }

    get nameAndId(): string {
        return `${this.name} [${this.regionId}-S2-${this.realmId}-${this.profileId}]`;
    }

    get nameAndIdPad(): string {
        return `${this.regionId}-S2-${this.realmId}-${this.profileId.toString().padEnd(8, ' ')} ${this.name}`;
    }

    static create() {
        const prof = new S2Profile();
        prof.discriminator = 0;
        prof.deleted = false;
        prof.accountId = null;
        prof.accountVerified = false;
        return prof;
    }
}
