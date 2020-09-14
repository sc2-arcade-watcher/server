import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, OneToOne, Index, JoinColumn } from 'typeorm';
import { BnAccount } from './BnAccount';

@Entity()
export class AppAccount {
    @PrimaryGeneratedColumn()
    id: number;

    @CreateDateColumn()
    createdAt: Date;

    @Column({
        nullable: true,
    })
    lastLoginAt: Date;

    @OneToOne(type => BnAccount, bnAccount => bnAccount.appAccount, {
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
        cascade: false,
        persistence: false,
    })
    @JoinColumn()
    @Index('bn_account_idx')
    bnAccount: BnAccount;

    @Column({
        unsigned: true,
    })
    bnAccountId: number;
}
