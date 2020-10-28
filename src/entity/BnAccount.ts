import { Entity, PrimaryColumn, Column, OneToOne, OneToMany } from 'typeorm';
import { AppAccount } from './AppAccount';
import { S2Profile } from './S2Profile';
import { BnAccountSettings } from './BnAccountSettings';

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

    @OneToMany(type => S2Profile, profile => profile.account, {
        cascade: false,
        persistence: false,
    })
    profiles: S2Profile[];

    @OneToOne(type => BnAccountSettings, settings => settings.account)
    settings: BnAccountSettings;

    get nameWithId() {
        return `${this?.battleTag} [${this.id}]`;
    }

    get isVerified() {
        return typeof this.battleTag === 'string';
    }
}
