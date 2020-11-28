import { Entity, PrimaryColumn, Column, OneToOne, OneToMany } from 'typeorm';
import { AppAccount } from './AppAccount';
import { BnAccountSettings } from './BnAccountSettings';
import { S2ProfileAccountLink } from './S2ProfileAccountLink';

@Entity()
export class BnAccount {
    // TODO: this should be BigInt
    @PrimaryColumn({
        unsigned: true,
    })
    id: number;

    @Column({
        nullable: true,
    })
    battleTag: string | null;

    @Column({
        nullable: true,
    })
    updatedAt: Date | null;

    @Column({
        nullable: true,
    })
    profilesUpdatedAt: Date | null;

    @OneToOne(type => AppAccount, appAccount => appAccount.bnAccount)
    appAccount: AppAccount;

    @OneToMany(type => S2ProfileAccountLink, profileLink => profileLink.account, {
        cascade: false,
        persistence: false,
    })
    profileLinks: S2ProfileAccountLink[];

    @OneToOne(type => BnAccountSettings, settings => settings.account)
    settings: BnAccountSettings;

    get nameWithId() {
        return `${this?.battleTag} [${this.id}]`;
    }

    get isVerified() {
        return typeof this.battleTag === 'string';
    }
}
