import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Check } from 'typeorm';

@Entity('users')
@Check(`"balance" >= 0`)
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  username: string;

  @Column()
  passwordHash: string;

  @Column('decimal', { precision: 12, scale: 2, default: 0.0 })
  balance: number;

  @Column({ default: 0 })
  gamesPlayed: number;

  @Column('decimal', { precision: 12, scale: 2, default: 0.0 })
  totalWon: number;

  @Column('decimal', { precision: 8, scale: 2, default: 1.0 })
  bestMultiplier: number;

  @Column({ default: 'USD', length: 10 })
  currency: string;

  @Column({ nullable: true })
  phoneNumber: string;

  @Column({ nullable: true, unique: true })
  email: string;

  @Column({ type: 'jsonb', nullable: true })
  savedWithdrawalDetails: any;

  @Column({ default: false })
  isFrozen: boolean;

  @Column({ nullable: true })
  freezeReason: string;

  @Column({ default: false })
  isFlaggedForReview: boolean;

  @Column({ nullable: true })
  flaggedReason: string;

  @Column({ default: false })
  isMarketing: boolean;

  @Column({ default: false })
  isMarketingAutoWin: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
