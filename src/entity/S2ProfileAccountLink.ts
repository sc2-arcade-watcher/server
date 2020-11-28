import { Entity, PrimaryGeneratedColumn, Column, Index, Unique, ManyToOne, OneToMany } from 'typeorm';
import { BnAccount } from './BnAccount';

@Entity()
@Unique('region_realm_profile_idx', ['regionId', 'realmId', 'profileId'])
export class S2ProfileAccountLink {
    @Column({
        primary: true,
        type: 'tinyint',
        unsigned: true,
    })
    regionId: number;

    @Column({
        primary: true,
        type: 'tinyint',
        unsigned: true,
    })
    realmId: number;

    @Column({
        primary: true,
        unsigned: true,
    })
    profileId: number;

    @ManyToOne(type => BnAccount, account => account.profileLinks, {
        onDelete: 'CASCADE',
        onUpdate: 'RESTRICT',
        nullable: false,
    })
    @Index('account_idx')
    account: BnAccount;

    @Column({
        unsigned: true,
        nullable: false,
    })
    accountId: number;

    /**
     * determines whether profile origin has been verified through Blizzard API
     */
    @Column({
        default: false,
    })
    accountVerified: boolean;
}
