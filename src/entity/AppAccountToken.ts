import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, Index } from 'typeorm';
import { AppAccount } from './AppAccount';

export enum AppAccountTokenKind {
    App = 'app',
    Bnet = 'bnet',
}

@Entity()
export class AppAccountToken {
    @PrimaryGeneratedColumn()
    id: number;

    @ManyToOne(type => AppAccount, {
        nullable: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @Index('account_idx')
    account: AppAccount;

    @CreateDateColumn()
    createdAt: Date;

    @Column({
        nullable: true,
    })
    expiresAt: Date;

    @Column({
        nullable: true,
    })
    userIp: string;

    @Column({
        nullable: true,
    })
    userAgent: string;

    @Column({
        type: 'enum',
        enum: AppAccountTokenKind,
    })
    type: AppAccountTokenKind;

    @Column({
        type: 'char',
        length: 64,
    })
    @Index('token_idx', { unique: true })
    accessToken: string;
}
